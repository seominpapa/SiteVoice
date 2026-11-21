export type Settings = {
  transcriptionModel: string
  cleanupModel: string
  shortcut: string
  microphoneId: string
  terms: string[]
}
export type Phase = 'idle' | 'recording' | 'transcribing' | 'cleaning' | 'pasting' | 'completed' | 'copy' | 'failed' | 'cancelled'
export type State = {
  phase: Phase
  id: number
  startedAt?: number
  raw?: string
  cleaned?: string
  message?: string
}
export type Theme = 'light' | 'dark'
export type PrimaryShortcut = 'Fn' | 'Windows'
export type ShortcutStatus = 'idle' | 'ready' | 'permission' | 'unavailable'
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
}
export type KeyAction = 'save' | 'verify' | 'delete'
export type Permission = 'microphone' | 'accessibility'
export type Action = 'start' | 'stop' | 'cancel' | 'retry' | 'copyRaw' | 'copyCleaned' | 'dismiss'
export type RecordingError = 'permission' | 'device' | 'silent' | 'tooLarge' | 'recording'
export type Recording = { command: 'start' | 'stop' | 'release'; id: number; microphoneId?: string }
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
  overlayAction(action: 'stop' | 'cancel', id: number): Promise<void>
  audio(id: number, bytes: ArrayBuffer, mime: string): Promise<void>
  recordingError(id: number, reason: RecordingError): Promise<void>
  onState(cb: (s: State) => void): () => void
  onRecording(cb: (r: Recording) => void): () => void
  ready(): Promise<void>
}
declare global { interface Window { voice: Voice } }
