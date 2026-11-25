export const MAX_TERMS = 64
export const MAX_TERM_LENGTH = 80
export const MAX_TERM_MEANING_LENGTH = 300
export const BATCH_TRANSCRIPTION_MODEL = 'gpt-transcribe'
export const LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe'
export const MAX_LIVE_CHUNK_BYTES = 64 * 1024
export type GlossaryEntry = { term: string; meaning: string }

export type Settings = {
  transcriptionModel: string
  cleanupModel: string
  shortcut: string
  microphoneId: string
  terms: GlossaryEntry[]
}
export type Phase = 'idle' | 'recording' | 'transcribing' | 'cleaning' | 'pasting' | 'completed' | 'copy' | 'failed' | 'cancelled'
export type TranscriptionSource = {
  transcriptionModel: string
  transcriptionMode: 'live' | 'file' | 'fallback'
}
export type RecordingDiagnostics = TranscriptionSource & {
  recordedAt?: number
  recordingMs: number
  transcriptionMs: number
  cleanupMs: number
  cleanupRetried?: boolean
}
export type State = {
  phase: Phase
  id: number
  startedAt?: number
  resultAt?: number
  resultId?: string
  reviewNote?: string
  raw?: string
  cleaned?: string
  message?: string
  diagnostics?: RecordingDiagnostics
}
export type Theme = 'light' | 'dark'
export type PrimaryShortcut = 'Fn' | 'Windows'
export type ShortcutStatus = 'idle' | 'ready' | 'permission' | 'unavailable'
export type HistoryEntry = { id: string; recordedAt: number; text: string; reviewNote?: string }
export type Snapshot = {
  name: string
  settings: Settings
  theme: Theme
  version: string
  autoUpdate: boolean
  updatesAvailable: boolean
  keyStored: boolean
  protectedStorage: boolean
  microphone: string
  accessibility: string
  shortcutRegistered: boolean
  shortcutPermission: ShortcutStatus
  platform: string
  state: State
  history: HistoryEntry[]
  historyWarning?: string
}
export type KeyAction = 'save' | 'verify' | 'delete'
export type Permission = 'microphone' | 'accessibility' | 'keyboard'
export type Action = 'start' | 'stop' | 'cancel' | 'retry' | 'copyRaw' | 'copyCleaned' | 'dismiss'
export type OverlayAction = 'stop' | 'cancel' | 'copyResult' | 'closeResult'
export type RecordingError = 'permission' | 'device' | 'silent' | 'tooLarge' | 'recording'
export type Recording = { command: 'start' | 'stop' | 'release'; id: number; microphoneId?: string; live?: boolean }
export interface Voice {
  get(): Promise<Snapshot>
  save(settings: Settings): Promise<Snapshot>
  setTheme(theme: Theme): Promise<Snapshot>
  setAutoUpdate(enabled: boolean): Promise<Snapshot>
  checkUpdate(): Promise<string>
  setShortcutCapture(active: boolean): Promise<boolean>
  onShortcutCapture(cb: (key: PrimaryShortcut) => void): () => void
  requestShortcutPermission(): Promise<Snapshot>
  key(action: KeyAction, value?: string): Promise<Snapshot>
  permission(kind: Permission): Promise<Snapshot>
  action(action: Action): Promise<Snapshot>
  copyHistory(id: string): Promise<void>
  onHistory(cb: (history: HistoryEntry[], warning?: string) => void): () => void
  overlayAction(action: OverlayAction, id: number): Promise<void>
  audio(id: number, bytes: ArrayBuffer, mime: string): Promise<void>
  liveChunk(id: number, bytes: ArrayBuffer): Promise<void>
  liveUnavailable(id: number): Promise<void>
  recordingError(id: number, reason: RecordingError): Promise<void>
  onState(cb: (s: State) => void): () => void
  onRecording(cb: (r: Recording) => void): () => void
  ready(): Promise<void>
}
declare global { interface Window { voice: Voice } }
