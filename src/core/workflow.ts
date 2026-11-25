import { randomUUID } from 'node:crypto'
import type { RecordingDiagnostics, State } from '../shared.ts'
import { userMessage } from './errors.ts'
import { meaningConcern } from './meaning.ts'
import type { TranscriptionResult } from './recording-transcription.ts'
import type { Audio } from './validation.ts'

type Dependencies = {
  transcribe(audio: Audio, signal: AbortSignal): Promise<TranscriptionResult>
  clean(raw: string, signal: AbortSignal): Promise<string>
  paste(text: string, signal: AbortSignal): Promise<{ ok: boolean; message?: string }>
  onState(state: State): void
  now?(): number
}
type Result = Pick<State, 'raw' | 'cleaned' | 'resultAt' | 'resultId' | 'reviewNote'>
type Job = { id: number; controller: AbortController; started: number; stopped?: number }
export function isBusy(phase: State['phase']) {
  return phase === 'recording' || phase === 'transcribing' || phase === 'cleaning' || phase === 'pasting'
}

export function createWorkflow(deps: Dependencies) {
  let state: State = { phase: 'idle', id: 0 }
  let job: Job | undefined
  let waitingForAudio = false
  let result: Result = {}
  let transcribed: Omit<RecordingDiagnostics, 'cleanupMs' | 'cleanupRetried'> | undefined
  let diagnostics: RecordingDiagnostics | undefined
  const now = deps.now ?? (() => performance.now())

  function emit(phase: State['phase'], message?: string) {
    state = { ...result, phase, id: state.id, startedAt: state.startedAt, message, diagnostics }
    deps.onState({ ...state })
  }
  function finish(phase: State['phase'], message?: string) {
    job = undefined
    waitingForAudio = false
    emit(phase, message)
  }
  function setJob() {
    state = { phase: state.phase, id: state.id + 1, startedAt: Date.now() }
    job = { id: state.id, controller: new AbortController(), started: now() }
    return job
  }
  function start() {
    if (job) return false
    setJob()
    emit('recording')
    return true
  }
  function stop() {
    if (!job || state.phase !== 'recording') return false
    job = { ...job, stopped: now() }
    waitingForAudio = true
    emit('transcribing')
    return true
  }
  async function submitAudio(id: number, audio: Audio) {
    const run = job
    if (!run || run.id !== id || run.stopped === undefined || !waitingForAudio) return
    waitingForAudio = false
    let transcription: TranscriptionResult
    try {
      transcription = await deps.transcribe(audio, run.controller.signal)
    } catch (error) {
      if (job === run) finish('failed', userMessage(error, '음성 전사에 실패했습니다. 다시 녹음해 주세요.'))
      return
    }
    if (job !== run) return
    const { text: raw, transcriptionModel, transcriptionMode } = transcription
    transcribed = {
      transcriptionModel, transcriptionMode, recordedAt: state.startedAt,
      recordingMs: Math.round(run.stopped - run.started), transcriptionMs: Math.round(now() - run.stopped),
    }
    result = { raw, resultAt: state.startedAt, resultId: randomUUID() }
    await clean(run, raw, true)
  }
  async function clean(run: Job, raw: string, autoPaste: boolean) {
    emit('cleaning')
    if (job !== run) return
    const cleanupStarted = now()
    let cleaned: string
    try {
      cleaned = await deps.clean(raw, run.controller.signal)
    } catch (error) {
      if (job === run) finish('failed', userMessage(error, '문장 정리에 실패했습니다. 원문을 복사하거나 다시 정리해 주세요.'))
      return
    }
    if (job !== run) return
    if (transcribed) {
      diagnostics = { ...transcribed, cleanupMs: Math.round(now() - cleanupStarted), ...(!autoPaste && { cleanupRetried: true }) }
    }
    const reviewNote = meaningConcern(raw, cleaned)
    result = { ...result, cleaned, reviewNote }
    const note = reviewNote ?? (autoPaste ? undefined : '문장을 다시 정리했습니다. 확인한 뒤 복사해 주세요.')
    if (note) {
      finish('copy', note)
      return
    }
    emit('pasting')
    try {
      const pasted = await deps.paste(cleaned, run.controller.signal)
      if (pasted.ok) finish('completed', pasted.message ?? '붙여넣기 키를 보냈습니다. 입력 칸에서 결과를 확인해 주세요.')
      else finish('copy', pasted.message ?? '자동 붙여넣기를 할 수 없습니다. 결과를 복사해 주세요.')
    } catch {
      finish('copy', '붙여넣기를 시도할 수 없었습니다. 결과를 복사해 주세요.')
    }
  }
  function recordingError(id: number, message: string) {
    if (!job || job.id !== id || (state.phase !== 'recording' && !waitingForAudio)) return false
    job.controller.abort()
    finish('failed', message)
    return true
  }
  function cancel(message = '현재 작업을 취소했습니다.') {
    if (!job || state.phase === 'pasting') return false
    job.controller.abort()
    finish('cancelled', message)
    return true
  }
  async function retry() {
    if (!job && result.raw) await clean(setJob(), result.raw, false)
  }
  function dismiss() {
    if (job) return false
    result = {}
    transcribed = undefined
    state = { phase: 'idle', id: state.id }
    emit('idle')
    return true
  }

  return { getState: () => ({ ...state }), start, stop, submitAudio, recordingError, cancel, retry, dismiss }
}
