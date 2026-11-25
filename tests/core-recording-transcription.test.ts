import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transcribeRecording, validLiveChunk } from '../src/core/recording-transcription.ts'
import { BATCH_TRANSCRIPTION_MODEL, LIVE_TRANSCRIPTION_MODEL, MAX_LIVE_CHUNK_BYTES } from '../src/shared.ts'

const liveSelected = { requestedModel: LIVE_TRANSCRIPTION_MODEL, fileModel: BATCH_TRANSCRIPTION_MODEL }

test('uses the live final result without sending the recorded file', async () => {
  const signal = new AbortController().signal
  const text = await transcribeRecording({ finish: async () => '최종 전사' }, async () => {
    assert.fail('must not send the file when live transcription succeeds')
  }, signal, liveSelected)
  assert.deepEqual(text, { text: '최종 전사', transcriptionModel: LIVE_TRANSCRIPTION_MODEL, transcriptionMode: 'live' })
})

test('a failed live connection sends the already recorded file once', async () => {
  const signal = new AbortController().signal
  let uploads = 0
  const text = await transcribeRecording({ finish: async () => { throw new Error() } }, async () => {
    uploads++
    return '파일 전사'
  }, signal, liveSelected)
  assert.deepEqual(text, { text: '파일 전사', transcriptionModel: BATCH_TRANSCRIPTION_MODEL, transcriptionMode: 'fallback' })
  assert.equal(uploads, 1)
})

test('cancelling a live recording does not upload it as a file', async () => {
  const controller = new AbortController()
  const live = { finish: async () => { controller.abort(); throw new Error() } }
  const batch = async () => assert.fail('must not upload after cancellation')
  await assert.rejects(transcribeRecording(live, batch, controller.signal, liveSelected), { name: 'AbortError' })
})

test('distinguishes an unavailable live capture from a deliberately selected file model', async () => {
  const signal = new AbortController().signal
  const batch = async () => '전사 결과'
  assert.deepEqual(await transcribeRecording(undefined, batch, signal, liveSelected),
    { text: '전사 결과', transcriptionModel: BATCH_TRANSCRIPTION_MODEL, transcriptionMode: 'fallback' })
  assert.deepEqual(await transcribeRecording(undefined, batch, signal, { requestedModel: 'whisper-1', fileModel: 'whisper-1' }),
    { text: '전사 결과', transcriptionModel: 'whisper-1', transcriptionMode: 'file' })
})

test('the audio bridge rejects empty, oversized and incomplete PCM samples', () => {
  assert.equal(validLiveChunk(new ArrayBuffer(4800)), true)
  for (const value of [null, new Uint8Array(8), new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(MAX_LIVE_CHUNK_BYTES + 2)]) {
    assert.equal(validLiveChunk(value), false)
  }
})
