import test from 'node:test';
import assert from 'node:assert/strict';
import { Capture, micError } from './capture.ts';

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

function fixture({ pending, samples = [0.05, 0.05] } = {}) {
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
    audio: (id, bytes, mime) => clips.push({ id, size: bytes.byteLength, mime, released: track.stopped }),
    error: (id, reason) => errors.push({ id, reason }),
    level: () => {},
    input: (connected) => connection.push(connected),
    timeout: () => () => {},
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
