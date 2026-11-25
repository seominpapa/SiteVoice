import type { LiveCapture } from './capture.ts';

const sampleRate = 24_000;
const chunkSamples = sampleRate / 10;
const maxPendingChunks = 6;

export function browserLiveCapture(
  stream: MediaStream,
  send: (pcm: ArrayBuffer) => Promise<void>,
  unavailable: () => void,
): LiveCapture {
  // Chromium resamples the input to the context rate and downmixes it to the processor's one channel.
  const context = new AudioContext({ sampleRate });
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let muted: GainNode | undefined;
  let recording = true;
  let halted = false;
  let sending = false;
  let resolveDrain: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
  const queue: ArrayBuffer[] = [];
  let pcm = new DataView(new ArrayBuffer(chunkSamples * 2));
  let length = 0;

  function disconnect() {
    if (!recording) return;
    recording = false;
    if (processor) processor.onaudioprocess = null;
    source?.disconnect();
    processor?.disconnect();
    muted?.disconnect();
    void context.close().catch(() => {});
  }

  function halt() {
    if (halted) return false;
    halted = true;
    disconnect();
    queue.length = 0;
    length = 0;
    resolveDrain();
    return true;
  }

  function fail() {
    if (halt()) unavailable();
  }

  async function sendQueued() {
    if (sending || halted) return;
    sending = true;
    try {
      while (!halted && queue.length) await send(queue.shift()!);
    } catch {
      fail();
    } finally {
      sending = false;
      if (!recording) resolveDrain();
    }
  }

  function enqueue() {
    if (queue.length + Number(sending) >= maxPendingChunks) return fail();
    queue.push(length === chunkSamples ? pcm.buffer : pcm.buffer.slice(0, length * 2));
    pcm = new DataView(new ArrayBuffer(chunkSamples * 2));
    length = 0;
    void sendQueued();
  }

  try {
    if (context.sampleRate !== sampleRate) throw new Error('Unsupported PCM sample rate');
    source = context.createMediaStreamSource(stream);
    // A local file page's CSP does not allow fetching an AudioWorklet module.
    processor = context.createScriptProcessor(512, 1, 1);
    muted = context.createGain();
    muted.gain.value = 0;
    processor.onaudioprocess = ({ inputBuffer }) => {
      if (!recording) return;
      for (const sample of inputBuffer.getChannelData(0)) {
        const value = Math.max(-1, Math.min(1, sample));
        pcm.setInt16(length++ * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
        if (length === chunkSamples) enqueue();
        if (halted) break;
      }
    };
    source.connect(processor);
    processor.connect(muted);
    muted.connect(context.destination);
    void context.resume().catch(fail);
  } catch (error) {
    halt();
    throw error;
  }

  return {
    stop() {
      disconnect();
      if (length) enqueue();
      if (!sending) resolveDrain();
      return drained;
    },
    cancel: () => { halt(); },
  };
}
