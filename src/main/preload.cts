import { contextBridge, ipcRenderer } from 'electron'
import type { HistoryEntry, Voice } from '../shared.ts'

const subscribe = <T,>(channel: string, fn: (data: T) => void) => {
  const listener = (_: unknown, data: T) => fn(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = await ipcRenderer.invoke(channel, ...args) as { value: T } | { error: string }
  if ('error' in reply) throw new Error(reply.error)
  return reply.value
}
const bridge: Voice = {
  get: () => invoke('voice:get'),
  save: settings => invoke('voice:save', settings),
  setTheme: theme => invoke('voice:theme', theme),
  setAutoUpdate: enabled => invoke('voice:auto-update', enabled),
  checkUpdate: () => invoke('voice:check-update'),
  setShortcutCapture: active => invoke('voice:shortcut-capture', active),
  onShortcutCapture: cb => subscribe('voice:shortcut-captured', cb),
  requestShortcutPermission: () => invoke('voice:shortcut-permission'),
  key: (action, value) => invoke('voice:key', action, value),
  permission: kind => invoke('voice:permission', kind),
  action: action => invoke('voice:action', action),
  copyHistory: id => invoke('voice:copy-history', id),
  onHistory: cb => subscribe<{ history: HistoryEntry[]; warning?: string }>('voice:history', ({ history, warning }) => cb(history, warning)),
  overlayAction: (action, id) => invoke('voice:overlay-action', action, id),
  audio: (id, bytes, mime) => invoke('voice:audio', id, bytes, mime),
  liveChunk: (id, bytes) => invoke('voice:live-chunk', id, bytes),
  liveUnavailable: id => invoke('voice:live-unavailable', id),
  recordingError: (id, reason) => invoke('voice:error', id, reason),
  onState: cb => subscribe('voice:state', cb),
  onRecording: cb => subscribe('voice:record', cb),
  ready: () => invoke('voice:ready')
}
ipcRenderer.on('voice:appearance', (_event, theme: unknown) => {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
})
if (window.location.hash === '#overlay') {
  const { overlayAction, audio, liveChunk, liveUnavailable, recordingError, onState, onRecording, ready } = bridge
  contextBridge.exposeInMainWorld('voice', { overlayAction, audio, liveChunk, liveUnavailable, recordingError, onState, onRecording, ready })
} else {
  const { get, save, setTheme, setAutoUpdate, checkUpdate, setShortcutCapture, onShortcutCapture, requestShortcutPermission, key, permission, action, copyHistory, onHistory, onState } = bridge
  contextBridge.exposeInMainWorld('voice', { get, save, setTheme, setAutoUpdate, checkUpdate, setShortcutCapture, onShortcutCapture, requestShortcutPermission, key, permission, action, copyHistory, onHistory, onState })
}
