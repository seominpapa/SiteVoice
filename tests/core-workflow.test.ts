import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkflow } from '../src/core/workflow.ts'
import { ServiceError } from '../src/core/errors.ts'
import type { Audio } from '../src/core/validation.ts'

const audio: Audio = { bytes: new ArrayBuffer(10), mime: 'audio/webm', extension: 'webm' }
const raw = '회의는 화요일에, 아니 수요일 오후 세 시에 하고요. 도면 검토가 필요해요. 도면을 한번 검토해야 합니다.'
const cleaned = '회의는 수요일 오후 3시에 진행하며, 도면 검토가 필요합니다.'
const transcript = (text: string) => ({ text, transcriptionModel: 'gpt-transcribe', transcriptionMode: 'file' as const })
function fixture(overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}) {
  const calls = { transcribe: 0, clean: 0, paste: 0 }
  const phases: string[] = []
  const flow = createWorkflow({
    transcribe: async () => { calls.transcribe++; return transcript(raw) },
    clean: async (input) => { calls.clean++; assert.equal(input, raw); return cleaned },
    paste: async (input) => { calls.paste++; assert.equal(input, cleaned); return { ok: true } },
    onState: ({ phase }) => phases.push(phase),
    ...overrides,
  })
  return { flow, calls, phases }
}
function startAndStop(flow: ReturnType<typeof createWorkflow>) {
  assert.equal(flow.start(), true)
  assert.equal(flow.stop(), true)
  return flow.getState().id
}

test('records once, ignores audio until stopped and stale audio, and only dispatches one paste', async () => {
  const { flow, calls, phases } = fixture()
  assert.equal(flow.getState().phase, 'idle')
  assert.equal(flow.start(), true)
  const { id, startedAt } = flow.getState()
  assert.equal(typeof startedAt, 'number')
  assert.equal(flow.start(), false)
  assert.equal(flow.dismiss(), false)
  await flow.submitAudio(id, audio)
  assert.equal(calls.transcribe, 0)
  assert.equal(flow.stop(), true)
  assert.equal(flow.stop(), false)
  await Promise.all([flow.submitAudio(id - 1, audio), flow.submitAudio(id, audio), flow.submitAudio(id, audio)])
  assert.deepEqual(calls, { transcribe: 1, clean: 1, paste: 1 })
  assert.deepEqual(phases, ['recording', 'transcribing', 'cleaning', 'pasting', 'completed'])
  assert.equal(flow.getState().raw, raw)
  assert.equal(flow.getState().cleaned, cleaned)
  assert.match(flow.getState().message ?? '', /확인/)
  assert.equal(flow.dismiss(), true)
  assert.equal(flow.getState().raw, undefined)
})

test('cancellation aborts a transcription and stale success cannot affect the next recording', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof transcript>>()
  let signal: AbortSignal | undefined
  const { flow, calls } = fixture({ transcribe: (_, value) => { signal = value; return pending.promise } })
  const oldId = startAndStop(flow)
  const submission = flow.submitAudio(oldId, audio)
  assert.equal(flow.cancel(), true)
  assert.equal(signal?.aborted, true)
  assert.equal(flow.getState().phase, 'cancelled')
  assert.equal(flow.start(), true)
  pending.resolve(transcript(raw))
  await submission
  assert.equal(flow.getState().phase, 'recording')
  assert.notEqual(flow.getState().id, oldId)
  assert.equal(calls.clean + calls.paste, 0)
})

test('cancellation during cleanup ignores the late result but keeps the transcript', async () => {
  const pending = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<void>()
  const { flow, calls } = fixture({ clean: () => { entered.resolve(); return pending.promise } })
  const submission = flow.submitAudio(startAndStop(flow), audio)
  await entered.promise
  assert.equal(flow.cancel('절전으로 중단했습니다.'), true)
  pending.reject(new Error('late'))
  await submission
  assert.equal(flow.getState().phase, 'cancelled')
  assert.equal(flow.getState().raw, raw)
  assert.equal(flow.getState().message, '절전으로 중단했습니다.')
  assert.equal(calls.paste, 0)
})

test('cleanup failure keeps the transcript and retry cannot auto-paste; earlier result survives later failed recording', async () => {
  let shouldFail = true
  const { flow, calls } = fixture({ clean: async () => {
    if (shouldFail) throw new ServiceError('문장 정리: 네트워크 연결을 확인해 주세요.')
    return cleaned
  } })
  await flow.submitAudio(startAndStop(flow), audio)
  assert.equal(flow.getState().phase, 'failed')
  assert.equal(flow.getState().raw, raw)
  const { resultAt, resultId, startedAt } = flow.getState()
  assert.ok(typeof resultAt === 'number')
  assert.ok(resultId)
  assert.equal(resultAt, startedAt)
  assert.match(flow.getState().message ?? '', /네트워크/)
  shouldFail = false
  await flow.retry()
  assert.equal(flow.getState().phase, 'copy')
  assert.equal(flow.getState().cleaned, cleaned)
  assert.equal(flow.getState().resultAt, resultAt)
  assert.equal(flow.getState().resultId, resultId)
  assert.equal(calls.paste, 0)
  assert.equal(flow.start(), true)
  const { id } = flow.getState()
  assert.equal(flow.recordingError(id - 1, '다른 작업'), false)
  assert.equal(flow.recordingError(id, '마이크가 분리되었습니다.'), true)
  assert.equal(flow.getState().cleaned, cleaned)
  assert.equal(flow.getState().resultAt, resultAt)
  assert.equal(flow.getState().message, '마이크가 분리되었습니다.')
})

test('a unit change or paste refusal returns a copy result', async () => {
  const changed = fixture({
    transcribe: async () => transcript('깊이는 3.5미터입니다.'),
    clean: async () => '깊이는 35미터입니다.',
  })
  await changed.flow.submitAudio(startAndStop(changed.flow), audio)
  assert.equal(changed.flow.getState().phase, 'copy')
  assert.match(changed.flow.getState().message ?? '', /숫자/)
  assert.equal(changed.flow.getState().reviewNote, changed.flow.getState().message)
  assert.equal(changed.calls.paste, 0)

  const refusal = fixture({ paste: async () => ({ ok: false, message: '입력 칸이 바뀌었습니다.' }) })
  await refusal.flow.submitAudio(startAndStop(refusal.flow), audio)
  assert.equal(refusal.flow.getState().phase, 'copy')
  assert.equal(refusal.flow.getState().message, '입력 칸이 바뀌었습니다.')
  assert.equal(refusal.flow.getState().reviewNote, undefined)
  assert.equal(refusal.flow.getState().cleaned, cleaned)
})

test('pastes the last clearly corrected amount and shows copy for an altered final amount', async () => {
  for (const [text, phase] of [['철근 15개 주문해 줘.', 'completed'], ['철근 51개 주문해 줘.', 'copy']] as const) {
    const pasted: string[] = []
    const { flow } = fixture({
      transcribe: async () => transcript('철근 50개, 아니 15개 주문해 줘.'),
      clean: async () => text,
      paste: async value => { pasted.push(value); return { ok: true } },
    })
    await flow.submitAudio(startAndStop(flow), audio)
    assert.equal(flow.getState().phase, phase)
    assert.deepEqual(pasted, phase === 'completed' ? [text] : [])
    assert.equal(flow.getState().cleaned, text)
  }
})

test('dispatch cannot be cancelled once it begins; native errors keep the result', async () => {
  const paste = Promise.withResolvers<{ ok: boolean }>()
  const entered = Promise.withResolvers<void>()
  const { flow } = fixture({ paste: () => { entered.resolve(); return paste.promise } })
  const submission = flow.submitAudio(startAndStop(flow), audio)
  await entered.promise
  assert.equal(flow.cancel(), false)
  paste.reject(new Error('native details are private'))
  await submission
  assert.equal(flow.getState().phase, 'copy')
  assert.match(flow.getState().message ?? '', /붙여넣기/)
  assert.equal(flow.getState().cleaned, cleaned)
})

test('transcription failure ends safely without exposing an upstream error or running cleanup', async () => {
  const { flow, calls } = fixture({ transcribe: async () => { throw new Error('private text') } })
  await flow.submitAudio(startAndStop(flow), audio)
  assert.equal(flow.getState().phase, 'failed')
  assert.equal(flow.getState().raw, undefined)
  assert.doesNotMatch(flow.getState().message ?? '', /private/)
  assert.equal(flow.stop(), false)
  assert.equal(flow.cancel(), false)
  await flow.retry()
  assert.equal(calls.clean + calls.paste, 0)
})

test('times the app recording and post-stop wait separately from cleanup and preserves the last diagnostics on dismiss', async () => {
  let now = 100
  const { flow } = fixture({
    now: () => now,
    transcribe: async () => { now += 600; return { ...transcript(raw), transcriptionMode: 'fallback' } },
    clean: async () => { now += 250; return cleaned },
    paste: async () => { now += 1500; return { ok: true } },
  })
  flow.start()
  now += 4000
  flow.stop()
  now += 100 // Recorder hands over its audio after the user stops.
  await flow.submitAudio(flow.getState().id, audio)
  const expected = {
    recordingMs: 4000, transcriptionMs: 700, cleanupMs: 250,
    transcriptionModel: 'gpt-transcribe', transcriptionMode: 'fallback', recordedAt: flow.getState().resultAt,
  }
  assert.deepEqual(flow.getState().diagnostics, expected)
  await flow.retry()
  assert.deepEqual(flow.getState().diagnostics, { ...expected, cleanupRetried: true })
  flow.dismiss()
  assert.deepEqual(flow.getState().diagnostics, { ...expected, cleanupRetried: true })
  flow.start()
  flow.cancel()
  assert.deepEqual(flow.getState().diagnostics, { ...expected, cleanupRetried: true })
})
