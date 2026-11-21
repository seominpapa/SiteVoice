export type CaptureError = 'permission' | 'device' | 'silent' | 'tooLarge' | 'recording';

const maxBytes = 20 * 1024 * 1024;
export const durationLimitMs = 5 * 60 * 1000;
const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/mp4'];

interface CaptureIO {
  stream(options: MediaStreamConstraints): Promise<MediaStream>;
  recorder(stream: MediaStream): MediaRecorder;
  meter(stream: MediaStream, onSample: (rms: number) => void): () => void;
  audio(id: number, bytes: ArrayBuffer, mime: string): void;
  error(id: number, reason: CaptureError): void;
  level(value: number): void;
  input(connected: boolean): void;
  timeout(cb: () => void, delay: number): () => void;
}

interface ActiveCapture {
  id: number;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  stopMeter?: () => void;
  stopTimer?: () => void;
  chunks: Blob[];
  bytes: number;
  samples: number;
  peak: number;
  stopping: boolean;
}

export const audioConstraints = (deviceId?: string): MediaStreamConstraints => ({
  audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  video: false,
});

export function micError(error: unknown): CaptureError {
  const name = error instanceof Error ? error.name : '';
  if (['NotAllowedError', 'SecurityError'].includes(name)) return 'permission';
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError'].includes(name)) return 'device';
  return 'recording';
}

export function meterLevel(rms: number) {
  return Math.max(0, Math.min(100, Math.round(Math.sqrt(rms) * 225)));
}

export function monitorMic(stream: MediaStream, onSample: (rms: number) => void) {
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    void context.resume().catch(() => {});
    const values = new Float32Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      if (context.state !== 'running') return;
      analyser.getFloatTimeDomainData(values);
      onSample(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length));
    }, 45);
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    };
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
}

export function browserRecorder(stream: MediaStream) {
  const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('No supported audio recording format');
  return new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
}

export class Capture {
  private current?: ActiveCapture;
  private greatestStartedId = -1;
  private io: CaptureIO;

  constructor(io: CaptureIO) { this.io = io; }

  async start(id: number, deviceId?: string) {
    if (id <= this.greatestStartedId) return;
    this.greatestStartedId = id;
    this.release();
    const task: ActiveCapture = { id, chunks: [], bytes: 0, stopping: false, samples: 0, peak: 0 };
    this.current = task;
    task.stopTimer = this.io.timeout(() => this.fail(task, 'recording'), durationLimitMs + 5000);
    try {
      const stream = await this.io.stream(audioConstraints(deviceId));
      if (this.current !== task) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      task.stream = stream;
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0 || tracks.some((track) => track.readyState === 'ended')) {
        this.fail(task, 'device');
        return;
      }
      const recorder = this.io.recorder(stream);
      task.recorder = recorder;
      tracks.forEach((track) => track.addEventListener('ended', () => {
        if (!task.stopping) this.fail(task, 'device');
      }, { once: true }));
      recorder.addEventListener('dataavailable', ({ data }: BlobEvent) => this.chunk(task, data));
      recorder.addEventListener('error', () => this.fail(task, 'recording'), { once: true });
      recorder.addEventListener('stop', () => void this.finish(task), { once: true });
      recorder.start(500);
      this.io.input(true);
      task.stopMeter = this.io.meter(stream, (rms) => {
        if (this.current !== task || task.stopping) return;
        task.samples++;
        task.peak = Math.max(task.peak, rms);
        this.io.level(meterLevel(rms));
      });
    } catch (error) {
      this.fail(task, micError(error));
    }
  }

  stop(id: number) {
    const task = this.current;
    if (!task || task.id !== id || task.stopping) return;
    if (!task.recorder || task.recorder.state === 'inactive') {
      this.fail(task, 'recording');
      return;
    }
    task.stopping = true;
    try {
      task.recorder.stop();
    } catch {
      this.fail(task, 'recording');
    } finally {
      this.releaseMedia(task);
    }
  }

  release(id?: number) {
    const task = this.current;
    if (!task || (id !== undefined && task.id !== id)) return;
    this.current = undefined;
    task.stopTimer?.();
    task.chunks = [];
    try {
      if (task.recorder && task.recorder.state !== 'inactive') task.recorder.stop();
    } catch {
      // The stream is still stopped below if the recorder closed asynchronously.
    } finally {
      this.releaseMedia(task);
    }
  }

  private releaseMedia(task: ActiveCapture) {
    const stopMeter = task.stopMeter;
    task.stopMeter = undefined;
    try {
      stopMeter?.();
    } finally {
      task.stream?.getTracks().forEach((track) => track.stop());
      task.stream = undefined;
      this.io.level(0);
      this.io.input(false);
    }
  }

  private fail(task: ActiveCapture, reason: CaptureError) {
    if (this.current !== task) return;
    this.release(task.id);
    this.io.error(task.id, reason);
  }

  private chunk(task: ActiveCapture, data: Blob) {
    if (this.current !== task || !data.size) return;
    task.bytes += data.size;
    if (task.bytes > maxBytes) this.fail(task, 'tooLarge');
    else task.chunks.push(data);
  }

  private async finish(task: ActiveCapture) {
    if (this.current !== task) return;
    if (!task.stopping) return this.fail(task, 'device');
    this.releaseMedia(task);
    if (!task.bytes || (task.samples >= 2 && task.peak < 0.0006)) return this.fail(task, 'silent');
    try {
      const mime = task.recorder!.mimeType.split(';')[0];
      const bytes = await new Blob(task.chunks, { type: mime }).arrayBuffer();
      if (this.current !== task) return;
      this.release(task.id);
      this.io.audio(task.id, bytes, mime);
    } catch {
      this.fail(task, 'recording');
    }
  }
}
