import test from 'node:test';
import assert from 'node:assert/strict';
import { Capture, micError } from './capture.ts';
import { browserLiveCapture } from './live-audio.ts';

class Track extends EventTarget {
  stopped = false;
  stop() { this.stopped = true; }
}

class Recorder extends EventTarget {
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }
  data(size) {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array(size)]) }));
  }
}

function fixture({ pending, samples = [0.05, 0.05], live, liveUnavailable, timeout = () => () => {} } = {}) {
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const recorder = new Recorder();
  const errors = [];
  const clips = [];
  const connection = [];
  let callbacks;
  let constraints;
  let meterStopped = false;
  const capture = new Capture({
    stream: (options) => {
      constraints = options;
      return pending ? pending().then(() => stream) : Promise.resolve(stream);
    },
    recorder: () => recorder,
    meter: (_stream, cb) => {
      samples.forEach(cb);
      callbacks = cb;
      return () => { meterStopped = true; };
    },
    live,
    liveUnavailable,
    audio: (id, bytes, mime) => clips.push({ id, size: bytes.byteLength, mime, released: track.stopped }),
    error: (id, reason) => errors.push({ id, reason }),
    level: () => {},
    input: (connected) => connection.push(connected),
    timeout,
  });
  return { capture, track, recorder, errors, clips, connection, meterStopped: () => meterStopped, constraints: () => constraints, get callbacks() { return callbacks; } };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('uses the selected mic, releases the track and meter, and uploads only once', async () => {
  const f = fixture();
  await f.capture.start(7, 'mic-a');
  assert.deepEqual(f.constraints(), { audio: { deviceId: { exact: 'mic-a' } }, video: false });
  f.recorder.data(20);
  f.capture.stop(7);
  f.capture.stop(7);
  await nextTick();
  assert.deepEqual(f.clips, [{ id: 7, size: 20, mime: 'audio/webm', released: true }]);
  assert.equal(f.meterStopped(), true);
  assert.equal(f.connection[0], true);
  assert.equal(f.connection.at(-1), false);
  assert.deepEqual(f.errors, []);
});

test('cancellation while the permission prompt is open stops the late stream without recording', async () => {
  let resolve;
  const pending = new Promise((accept) => { resolve = accept; });
  const f = fixture({ pending: () => pending });
  const starting = f.capture.start(1);
  f.capture.release(1);
  resolve();
  await starting;
  assert.equal(f.track.stopped, true);
  assert.equal(f.recorder.state, 'inactive');
  assert.deepEqual(f.clips, []);
  assert.deepEqual(f.errors, []);
});

test('silent and oversized recordings fail without sending audio', async () => {
  const silent = fixture({ samples: [0, 0, 0] });
  await silent.capture.start(2);
  silent.recorder.data(20);
  silent.capture.stop(2);
  assert.deepEqual(silent.errors, [{ id: 2, reason: 'silent' }]);
  const oversized = fixture();
  await oversized.capture.start(3);
  oversized.recorder.data(20 * 1024 * 1024 + 1);
  assert.deepEqual(oversized.errors, [{ id: 3, reason: 'tooLarge' }]);
  assert.equal(oversized.track.stopped, true);
  assert.deepEqual(oversized.clips, []);
});

test('microphone detachment promptly releases the recording', async () => {
  const f = fixture();
  await f.capture.start(4);
  f.track.dispatchEvent(new Event('ended'));
  assert.equal(f.track.stopped, true);
  assert.deepEqual(f.errors, [{ id: 4, reason: 'device' }]);
});

test('ignores late callbacks after cancellation, even with a finished blob', async () => {
  const f = fixture();
  await f.capture.start(5);
  f.recorder.data(20);
  f.capture.stop(5);
  f.capture.release(5);
  await nextTick();
  assert.deepEqual(f.clips, []);
});

test('reports denied and unavailable microphones distinctly from unexpected capture failures', async () => {
  for (const [name, expected] of [['NotAllowedError', 'permission'], ['OverconstrainedError', 'device'], ['', 'recording']]) {
    const f = fixture({ pending: () => Promise.reject(new DOMException('private detail', name)) });
    await f.capture.start(9);
    assert.deepEqual(f.errors, [{ id: 9, reason: expected }]);
    assert.deepEqual(f.clips, []);
  }
  assert.equal(micError(undefined), 'recording');
});

test('stopping before the microphone becomes available fails without a late upload', async () => {
  let resolve;
  const pending = new Promise((accept) => { resolve = accept; });
  const f = fixture({ pending: () => pending });
  const starting = f.capture.start(10);
  f.capture.stop(10);
  resolve();
  await starting;
  assert.deepEqual(f.errors, [{ id: 10, reason: 'recording' }]);
  assert.deepEqual(f.clips, []);
  assert.equal(f.track.stopped, true);
});

test('rejects audio from a stream whose audio track was already disconnected', async () => {
  const f = fixture();
  f.track.readyState = 'ended';
  await f.capture.start(11);
  assert.deepEqual(f.errors, [{ id: 11, reason: 'device' }]);
  assert.deepEqual(f.clips, []);
});

test('only starts live capture on request and waits for the final chunks before uploading the file', async () => {
  const calls = [];
  let drained;
  const flush = new Promise((resolve) => { drained = resolve; });
  const f = fixture({ live: (id) => {
    calls.push(['start', id]);
    return { stop: () => { calls.push(['stop']); return flush; }, cancel: () => calls.push(['cancel']) };
  } });
  await f.capture.start(1);
  assert.deepEqual(calls, []);
  f.capture.release(1);
  await f.capture.start(2, undefined, true);
  f.recorder.data(20);
  f.capture.stop(2);
  await nextTick();
  assert.deepEqual(calls, [['start', 2], ['stop']]);
  assert.deepEqual(f.clips, []);
  drained();
  await nextTick();
  assert.deepEqual(f.clips, [{ id: 2, size: 20, mime: 'audio/webm', released: true }]);
});

test('live capture setup failure preserves the compressed file and signals the fallback', async () => {
  const unavailable = [];
  const f = fixture({ live: () => { throw new Error('Unavailable worklet'); }, liveUnavailable: (id) => unavailable.push(id) });
  await f.capture.start(3, undefined, true);
  f.recorder.data(20);
  f.capture.stop(3);
  await nextTick();
  assert.deepEqual(unavailable, [3]);
  assert.deepEqual(f.clips, [{ id: 3, size: 20, mime: 'audio/webm', released: true }]);
  assert.deepEqual(f.errors, []);
});

test('releasing an active live capture cancels it without uploading', async () => {
  let cancellations = 0;
  const f = fixture({ live: () => ({ stop: () => Promise.resolve(), cancel: () => { cancellations++; } }) });
  await f.capture.start(4, undefined, true);
  f.recorder.data(20);
  f.capture.release(4);
  await nextTick();
  assert.equal(cancellations, 1);
  assert.deepEqual(f.clips, []);
  assert.equal(f.track.stopped, true);
});

test('falls back when live PCM drain stalls, without waiting for the stalled IPC', async () => {
  const events = [];
  const timers = [];
  const f = fixture({
    live: () => ({ stop: () => new Promise(() => {}), cancel: () => events.push('cancel') }),
    liveUnavailable: () => events.push('unavailable'),
    timeout: (callback, delay) => { timers.push({ callback, delay }); return () => {}; },
  });
  await f.capture.start(5, undefined, true);
  f.recorder.data(20);
  f.capture.stop(5);
  const drain = timers.at(-1);
  assert.ok(drain.delay > 0 && drain.delay <= 1000);
  drain.callback();
  await nextTick();
  assert.deepEqual(events, ['unavailable', 'cancel']);
  assert.deepEqual(f.clips, [{ id: 5, size: 20, mime: 'audio/webm', released: true }]);
});

function audioContextFixture(t) {
  const node = { onaudioprocess: null, connect() {}, disconnect() {} };
  let closed = false;
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor(options) { this.sampleRate = options.sampleRate; }
    createMediaStreamSource() { return node; }
    createGain() { return { ...node, gain: { value: 1 } }; }
    createScriptProcessor(_size, inputs) { assert.equal(inputs, 1); return node; }
    async resume() {}
    async close() { closed = true; }
  };
  t.after(() => { if (previous) globalThis.AudioContext = previous; else delete globalThis.AudioContext; });
  return {
    get closed() { return closed; },
    emit: (input) => node.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } }),
  };
}

test('encodes little-endian PCM, keeps chunks in order, and flushes the final partial chunk', async (t) => {
  const hardware = audioContextFixture(t);
  const sent = [];
  let acknowledge;
  const firstAck = new Promise((resolve) => { acknowledge = resolve; });
  const live = browserLiveCapture({}, (bytes) => {
    sent.push(new Uint8Array(bytes));
    return sent.length === 1 ? firstAck : Promise.resolve();
  }, () => assert.fail('live unexpectedly unavailable'));
  const samples = new Float32Array(2403);
  samples.set([-2, 0, 2]);
  samples.set([0.5, 0, -0.5], 2400);
  hardware.emit(samples);
  const drained = live.stop();
  assert.equal(hardware.closed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].byteLength, 4800);
  assert.deepEqual([...sent[0].slice(0, 6)], [0, 128, 0, 0, 255, 127]);
  acknowledge();
  await drained;
  assert.deepEqual([...sent[1]], [0, 64, 0, 0, 0, 192]);
});

test('aborts a backed-up live sender and drops queued PCM without affecting the audio input track', async (t) => {
  const hardware = audioContextFixture(t);
  let sent = 0;
  let failures = 0;
  const live = browserLiveCapture({}, () => { sent++; return new Promise(() => {}); }, () => failures++);
  for (let i = 0; i < 10; i++) hardware.emit(new Float32Array(2400).fill(0.2));
  assert.equal(sent, 1);
  assert.equal(failures, 1);
  assert.equal(hardware.closed, true);
  await live.stop();
});

test('after the live IPC rejects, drops unsent data and reports unavailability only once', async (t) => {
  const hardware = audioContextFixture(t);
  let sent = 0;
  let failures = 0;
  const live = browserLiveCapture({}, async () => { sent++; throw new Error('Lost connection'); }, () => failures++);
  hardware.emit(new Float32Array(6000).fill(0.2));
  await live.stop();
  assert.equal(sent, 1);
  assert.equal(failures, 1);
  assert.equal(hardware.closed, true);
  live.cancel();
  assert.equal(failures, 1);
});
