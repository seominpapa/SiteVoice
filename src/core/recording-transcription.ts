import { LIVE_TRANSCRIPTION_MODEL, MAX_LIVE_CHUNK_BYTES, type TranscriptionSource } from '../shared.ts'

export type TranscriptionResult = TranscriptionSource & { text: string }

export function validLiveChunk(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && value.byteLength > 0 && value.byteLength <= MAX_LIVE_CHUNK_BYTES && value.byteLength % 2 === 0
}

export async function transcribeRecording(live: { finish(): Promise<string> } | undefined, batch: () => Promise<string>,
  signal: AbortSignal, { requestedModel, fileModel }: { requestedModel: string; fileModel: string }): Promise<TranscriptionResult> {
  signal.throwIfAborted()
  if (live) {
    try {
      const text = await live.finish()
      signal.throwIfAborted()
      return { text, transcriptionModel: LIVE_TRANSCRIPTION_MODEL, transcriptionMode: 'live' }
    } catch {
      signal.throwIfAborted()
    }
  }
  const text = await batch()
  return { text, transcriptionModel: fileModel, transcriptionMode: requestedModel === LIVE_TRANSCRIPTION_MODEL ? 'fallback' : 'file' }
}
