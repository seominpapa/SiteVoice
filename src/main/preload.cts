import { contextBridge, ipcRenderer } from 'electron'
import type { Voice } from '../shared.ts'

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
  key: (action, value) => invoke('voice:key', action, value),
  permission: kind => invoke('voice:permission', kind),
  action: action => invoke('voice:action', action),
  overlayAction: (action, id) => invoke('voice:overlay-action', action, id),
  audio: (id, bytes, mime) => invoke('voice:audio', id, bytes, mime),
  recordingError: (id, reason) => invoke('voice:error', id, reason),
  onState: cb => subscribe('voice:state', cb),
  onRecording: cb => subscribe('voice:record', cb),
  ready: () => invoke('voice:ready')
}
ipcRenderer.on('voice:appearance', (_event, theme: unknown) => {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
})
if (window.location.hash === '#overlay') {
  const { overlayAction, audio, recordingError, onState, onRecording, ready } = bridge
  contextBridge.exposeInMainWorld('voice', { overlayAction, audio, recordingError, onState, onRecording, ready })
} else {
  const { get, save, setTheme, setAutoUpdate, checkUpdate, key, permission, action, onState } = bridge
  contextBridge.exposeInMainWorld('voice', { get, save, setTheme, setAutoUpdate, checkUpdate, key, permission, action, onState })
}
