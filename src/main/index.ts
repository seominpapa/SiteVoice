import { app, autoUpdater, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, safeStorage, shell, systemPreferences, Tray, type IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkflow, isBusy } from '../core/workflow.ts'
import { createSpeechService } from '../core/openai.ts'
import { transcribeRecording, validLiveChunk } from '../core/recording-transcription.ts'
import { createLiveTranscription } from '../core/realtime.ts'
import { validateSettings, validateAudio, MAX_RECORDING_MS } from '../core/validation.ts'
import { BATCH_TRANSCRIPTION_MODEL, LIVE_TRANSCRIPTION_MODEL, type HistoryEntry, type Recording, type Snapshot, type State, type Theme } from '../shared.ts'
import { parseId, parseKey, type NativeReason, type NativeReply, type View } from './boundary.ts'
import { createTargetClient } from './native.ts'
import { createPrimaryShortcut } from './native-shortcut.ts'
import { nativeShortcut } from '../core/shortcuts.ts'
import { createPreferences } from './preferences.ts'
import { createVault } from './vault.ts'
import { createHistory, validateHistoryEntry } from './history.ts'
import { createWindows, dashboardColor } from './windows.ts'
import { createUpdateController } from './updates.ts'

const running = new Set(['recording', 'transcribing', 'cleaning', 'pasting'])
const completedOverlayMs = 450
const recorderErrors = {
  permission: '마이크 접근이 거부되었습니다. 환경 설정에서 권한을 확인해 주세요.',
  device: '녹음 중 마이크 연결이 끊겼습니다. 연결을 확인하고 다시 시도해 주세요.',
  silent: '마이크에서 음성이 감지되지 않았습니다. 입력 장치와 볼륨을 확인해 주세요.',
  tooLarge: '녹음 파일이 20 MiB를 넘었습니다. 더 짧게 나누어 녹음해 주세요.',
  recording: '녹음을 완료할 수 없었습니다. 마이크를 확인하고 다시 시도해 주세요.'
}
const pasteErrors: Record<NativeReason, string> = {
  permission: '자동 입력 권한이 없습니다. 결과를 복사해 붙여넣으세요.',
  target: '안전한 입력 칸인지 확인할 수 없어 자동 입력을 보류했습니다.',
  changed: '입력 대상이 바뀌어 자동 입력을 보류했습니다.',
  clipboard: '기존 클립보드를 보존할 수 없어 자동 입력을 보류했습니다.',
  input: '시스템이 붙여넣기 입력을 제한했습니다. 결과를 복사해 붙여넣으세요.',
  invalid: '이 결과는 자동 입력할 수 없습니다. 결과를 복사해 붙여넣으세요.',
  unsupported: '이 환경의 자동 입력을 지원하지 않습니다.',
  unavailable: '자동 입력 연결을 확인할 수 없습니다. 기존 입력 칸을 확인한 뒤 필요한 경우에만 결과를 복사하세요.'
}

function selection<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error('지원하지 않는 요청입니다.')
  return value as T
}
function publicMessage(error: unknown) {
  // Only UI errors intentionally written in Korean cross the process boundary.
  return error instanceof Error && error.message.length <= 220 && /^(?:[가-힣]|OpenAI |API )/.test(error.message)
    ? error.message : '요청을 처리할 수 없습니다. 다시 시도해 주세요.'
}
const permissionMessage = '먼저 환경 설정에서 OpenAI API 키를 저장해 주세요.'
const macSettings = {
  accessibility: 'com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'com.apple.preference.security?Privacy_ListenEvent',
  keyboard: 'com.apple.Keyboard-Settings.extension'
} as const
async function openMacSettings(section: keyof typeof macSettings) {
  try { await shell.openExternal('x-apple.systempreferences:' + macSettings[section]) }
  catch { throw new Error('시스템 설정을 열지 못했습니다. macOS 시스템 설정에서 직접 열어 주세요.') }
}

async function startApp() {
  const name = app.getName()
  const directory = app.getPath('userData')
  const resources = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const nativeRoot = join(resources, app.isPackaged ? 'targets' : 'native/bin')
  const targets = createTargetClient(nativeRoot)
  const primaryKey = nativeShortcut(process.platform)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const prefs = createPreferences(directory)
  const loaded = await prefs.read()
  let settings = loaded.settings
  let theme: Theme = loaded.theme
  let autoUpdate = loaded.autoUpdate
  nativeTheme.themeSource = theme
  let settingsWarning = loaded.message
  const codec = {
    available: () => ['darwin', 'win32'].includes(process.platform) ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    encrypt: (value: string) => safeStorage.encryptStringAsync(value),
    decrypt: async (bytes: Buffer) => {
      const result = await safeStorage.decryptStringAsync(bytes)
      return result.shouldReEncrypt ? (await safeStorage.decryptStringAsync(bytes)).result : result.result
    }
  }
  const vault = createVault(directory, codec)
  let keyWarning: string | undefined
  let key = await vault.read().catch(error => { keyWarning = publicMessage(error); return undefined })
  const historyStore = createHistory(directory, codec)
  let historyReadWarning: string | undefined
  let historyWriteWarning: string | undefined
  const historyWarning = () => historyWriteWarning || historyReadWarning
  let historyWrite = Promise.resolve()
  let historyWritesPending = 0
  let quitAfterHistory = false
  const recoveryFile = app.commandLine.getSwitchValue('recover-sitevoice-result')
  if (recoveryFile) {
    try {
      const info = await stat(recoveryFile)
      if (!info.isFile() || info.size > 512 * 1024) throw new Error()
      const file = await readFile(recoveryFile, 'utf8')
      if (file.length > 512 * 1024) throw new Error()
      await historyStore.save(validateHistoryEntry(JSON.parse(file)))
    } catch {
      historyWriteWarning = '이전 결과를 기록에 옮기지 못했습니다. 별도로 보관한 백업을 확인해 주세요.'
    }
  }
  let history = await historyStore.read(() => {
    historyReadWarning = '일부 받아쓰기 기록을 열지 못했습니다. 다른 기록은 표시됩니다.'
  }).catch(() => {
    historyReadWarning = '받아쓰기 기록을 열지 못했습니다. 운영체제 보안 저장소를 확인해 주세요.'
    return []
  })
  let acceleratorRegistered = false
  let capturingShortcut = false
  const usesNative = () => settings.shortcut === primaryKey
  let overlayReady = false
  let quitting = false
  let prior: State | undefined
  let overlayRecordingId = 0
  let target: Promise<NativeReply> | undefined
  let captureTimer: NodeJS.Timeout | undefined
  let audioTimer: NodeJS.Timeout | undefined
  let hideTimer: NodeJS.Timeout | undefined
  let awaitingAudio = 0
  let liveRecording: { id: number; abort: AbortController; session: ReturnType<typeof createLiveTranscription> } | undefined
  let operation = false
  let tray: Tray

  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  const page = pathToFileURL(join(app.getAppPath(), 'dist/ui/index.html')).href
  const windows = createWindows(name, page, join(import.meta.dirname, 'preload.cjs'))
  const themedWindows = [windows.dashboard, windows.overlay]
  for (const window of themedWindows) {
    window.webContents.on('did-finish-load', () => window.webContents.send('voice:appearance', theme))
  }
  const primary = createPrimaryShortcut(nativeRoot, () => {
    if (quitting || !primaryKey) return
    if (capturingShortcut) {
      if (windows.dashboard.isFocused()) windows.dashboard.webContents.send('voice:shortcut-captured', primaryKey)
    } else if (usesNative()) toggle()
  })
  const microphone = () => systemPreferences.getMediaAccessStatus('microphone')
  const icon = (file: string) => nativeImage.createFromPath(join(resources, 'build', file))
  function service() {
    if (!key) throw new Error(permissionMessage)
    return createSpeechService(key)
  }

  const workflow = createWorkflow({
    transcribe: (audio, signal) => {
      const active = liveRecording
      const fileSettings = settings.transcriptionModel === LIVE_TRANSCRIPTION_MODEL
        ? { ...settings, transcriptionModel: BATCH_TRANSCRIPTION_MODEL } : settings
      return transcribeRecording(active?.session, () => service().transcribe(audio, fileSettings, signal), signal, {
        requestedModel: settings.transcriptionModel, fileModel: fileSettings.transcriptionModel,
      })
    },
    clean: (raw, signal) => service().clean(raw, settings, signal),
    async paste(text, signal) {
      const captured = await target
      if (!captured || signal.aborted) return { ok: false, message: pasteErrors.target }
      if (!captured.ok) return { ok: false, message: pasteErrors[captured.reason] }
      const reply = await targets.paste(text, signal)
      return reply.ok
        ? { ok: true, message: reply.warning === 'clipboard'
          ? '붙여넣기 키를 보냈지만 이전 클립보드를 복원하지 못했습니다. 입력 칸과 클립보드를 확인해 주세요.'
          : undefined }
        : { ok: false, message: pasteErrors[reply.reason] }
    },
    onState: publish
  })

  const updates = createUpdateController({
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    canInterrupt: () => !quitting && !operation && !capturingShortcut && !historyWritesPending && !isBusy(workflow.getState().phase),
    async confirm(version) {
      const result = await dialog.showMessageBox(windows.dashboard, {
        type: 'question',
        title: name + ' 업데이트',
        message: '새 버전 ' + version + '을 설치할까요?',
        detail: '설치를 선택하면 업데이트를 내려받은 뒤 앱을 다시 시작합니다. 저장된 받아쓰기 기록은 유지됩니다.',
        buttons: ['나중에', '업데이트 설치'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    }
  })

  function resultState(): State {
    const state = workflow.getState()
    const warning = keyWarning || settingsWarning
    return warning && !state.message ? { ...state, message: warning } : state
  }
  function record(command: Recording['command'], id: number) {
    if (!overlayReady || quitting || windows.overlay.isDestroyed()) return
    windows.overlay.webContents.send('voice:record', { command, id, microphoneId: settings.microphoneId,
      live: command === 'start' && liveRecording?.id === id } satisfies Recording)
  }
  function stopLiveRecording() {
    const active = liveRecording
    liveRecording = undefined
    active?.abort.abort()
  }
  function overlayResult(state: State) {
    return state.phase === 'copy' && state.id === overlayRecordingId ? state.cleaned : undefined
  }
  function sendOverlayState(state: State) {
    const { phase, id, startedAt } = state
    const cleaned = overlayResult(state)
    windows.overlay.webContents.send('voice:state', { phase, id, startedAt, cleaned, reviewNote: cleaned ? state.reviewNote : undefined })
  }
  function saveFinalResult(state: State) {
    if ((state.phase !== 'completed' && state.phase !== 'copy') || !state.resultId || !state.resultAt || !state.cleaned) return
    const entry: HistoryEntry = { id: state.resultId, recordedAt: state.resultAt, text: state.cleaned, reviewNote: state.reviewNote }
    historyWritesPending++
    historyWrite = historyWrite.then(async () => {
      try {
        await historyStore.save(entry)
        history = [entry, ...history.filter(item => item.id !== entry.id)].sort((a, b) => b.recordedAt - a.recordedAt)
      } catch {
        historyWriteWarning = '받아쓰기 결과를 기록에 저장하지 못했습니다. 앱을 닫기 전에 현재 문장을 복사해 보관하세요.'
      } finally {
        historyWritesPending--
        if (!windows.dashboard.isDestroyed() && !windows.dashboard.webContents.isDestroyed()) {
          windows.dashboard.webContents.send('voice:history', { history, warning: historyWarning() })
        }
      }
    })
  }
  function publish(state: State) {
    if (quitting) return
    const { phase } = state
    windows.dashboard.webContents.send('voice:state', state)
    saveFinalResult(state)
    if (overlayReady) sendOverlayState(state)
    tray.setToolTip(name + (phase === 'recording' ? ' · 녹음 중' : running.has(phase) ? ' · 처리 중' : ''))
    const trayIcon = icon(phase === 'recording' ? 'tray-recording.png' : (process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'))
    if (process.platform === 'darwin' && phase !== 'recording') trayIcon.setTemplateImage(true)
    tray.setImage(trayIcon)
    if (running.has(phase)) {
      if (phase === 'pasting') globalShortcut.unregister('Escape')
      clearTimeout(hideTimer)
    } else {
      stopLiveRecording()
      clearTimeout(captureTimer)
      clearTimeout(audioTimer)
      awaitingAudio = 0
      globalShortcut.unregister('Escape')
      if (prior && running.has(prior.phase)) {
        record('release', prior.id)
        void targets.reset()
        target = undefined
      }
      if (phase === 'failed' && !windows.dashboard.isVisible()) windows.dashboard.showInactive()
      clearTimeout(hideTimer)
      if (!overlayResult(state)) {
        const delay = phase === 'completed' ? completedOverlayMs : phase === 'idle' ? 0 : 2500
        hideTimer = setTimeout(() => windows.overlay.hide(), delay)
      }
    }
    prior = state
  }

  async function snapshot(refreshPermissions = false): Promise<Snapshot> {
    const mic = microphone()
    if (usesNative() && (primary.status === 'idle' || (refreshPermissions && primary.status !== 'ready'))) await primary.start()
    const trusted = await targets.permission(refreshPermissions)
    const accessibility = process.platform === 'darwin'
      ? trusted.ok ? 'granted' : trusted.reason === 'permission' ? 'denied' : 'unavailable'
      : trusted.ok ? 'available' : 'unavailable'
    return {
      name, settings, theme, version: app.getVersion(), autoUpdate, updatesAvailable: updates.available,
      keyStored: !!key, protectedStorage: await (['darwin', 'win32'].includes(process.platform)
        ? safeStorage.isAsyncEncryptionAvailable().catch(() => false) : Promise.resolve(false)),
      microphone: mic, accessibility, shortcutPermission: primary.status,
      shortcutRegistered: usesNative() ? primary.status === 'ready' : acceleratorRegistered,
      platform: process.platform, state: resultState(), history, historyWarning: historyWarning()
    }
  }
  function showDashboard() { windows.dashboard.show(); windows.dashboard.focus() }
  function begin(external: boolean) {
    if (isBusy(workflow.getState().phase) || operation || quitting || quitAfterHistory) return
    if (updates.busy) throw new Error('업데이트 확인이나 설치가 끝난 뒤 녹음을 시작해 주세요.')
    if (!key) { showDashboard(); throw new Error(permissionMessage) }
    if (!overlayReady) throw new Error('녹음 창을 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요.')
    if (process.platform === 'darwin' && microphone() !== 'granted') {
      showDashboard()
      throw new Error('환경 설정에서 마이크 권한을 허용해 주세요.')
    }
    target = external && !windows.dashboard.isFocused() ? targets.snapshot() : undefined
    if (!workflow.start()) return
    const id = workflow.getState().id
    overlayRecordingId = id
    if (settings.transcriptionModel === LIVE_TRANSCRIPTION_MODEL) {
      const abort = new AbortController()
      liveRecording = { id, abort, session: createLiveTranscription(key, settings.terms, abort.signal) }
    }
    try { globalShortcut.register('Escape', () => workflow.cancel()) } catch { /* Overlay cancel still works. */ }
    windows.showOverlay()
    record('start', id)
    captureTimer = setTimeout(end, MAX_RECORDING_MS)
  }
  function end() {
    if (!workflow.stop()) return
    clearTimeout(captureTimer)
    const id = workflow.getState().id
    awaitingAudio = id
    audioTimer = setTimeout(() => {
      awaitingAudio = 0
      workflow.recordingError(id, recorderErrors.recording)
    }, 15_000)
    record('stop', id)
  }
  function toggle() {
    try {
      if (workflow.getState().phase === 'recording') end()
      else begin(true)
    } catch (error) {
      showDashboard()
      windows.dashboard.webContents.send('voice:state', { ...workflow.getState(), message: publicMessage(error) })
    }
  }
  function register(shortcut: string) {
    try { return globalShortcut.register(shortcut, () => { if (!capturingShortcut) toggle() }) } catch { return false }
  }
  function resumeShortcut() {
    if (quitting) return
    if (usesNative()) void primary.start()
    else {
      primary.stop()
      acceleratorRegistered = register(settings.shortcut)
    }
  }
  function finishShortcutCapture() {
    if (!capturingShortcut) return
    capturingShortcut = false
    resumeShortcut()
  }
  async function exclusive<T>(run: () => Promise<T>) {
    if (operation || updates.busy || isBusy(workflow.getState().phase)) throw new Error('진행 중인 작업이 끝나면 다시 시도해 주세요.')
    operation = true
    try { return await run() } finally { operation = false }
  }

  // A caller only receives access to channels for its own window. Expected
  // failures use a data reply so Electron never logs exception arguments.
  function handle<T extends unknown[], R>(channel: string, allowed: readonly View[], run: (...args: T) => R) {
    ipcMain.handle('voice:' + channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const frame = event.senderFrame
        const view = frame && windows.view(event.sender, frame.url, frame === event.sender.mainFrame)
        if (!view || !allowed.includes(view)) throw new Error('허용되지 않은 요청입니다.')
        return { value: await run(...args as T) }
      } catch (error) {
        return { error: publicMessage(error) }
      }
    })
  }

  handle('get', ['dashboard'], () => snapshot(process.platform === 'darwin' && windows.dashboard.isFocused() && !isBusy(workflow.getState().phase)))
  handle('ready', ['overlay'], () => {
    overlayReady = true
    const state = workflow.getState()
    if (overlayResult(state)) sendOverlayState(state)
  })
  handle('shortcut-capture', ['dashboard'], async (enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('단축키 입력 상태를 확인할 수 없습니다.')
    if (!enabled) { finishShortcutCapture(); return false }
    if (!windows.dashboard.isFocused() || quitting || operation || updates.busy || isBusy(workflow.getState().phase)) {
      throw new Error('설정 창의 작업이 끝난 뒤 단축키를 입력해 주세요.')
    }
    if (!capturingShortcut) {
      capturingShortcut = true
      if (!usesNative() && acceleratorRegistered) {
        globalShortcut.unregister(settings.shortcut)
        acceleratorRegistered = false
      }
    }
    return (await primary.start()) === 'ready' && capturingShortcut
  })
  handle('shortcut-permission', ['dashboard'], async () => {
    if (process.platform === 'darwin') {
      if (windows.dashboard.isFocused() && primary.status !== 'ready') await primary.requestPermission()
      await openMacSettings('inputMonitoring')
    }
    return snapshot()
  })
  handle('save', ['dashboard'], (input: unknown) => exclusive(async () => {
    const next = validateSettings(input)
    finishShortcutCapture()
    const priorShortcut = settings.shortcut
    const changed = next.shortcut !== priorShortcut
    const hasPreviousAccelerator = !usesNative() && acceleratorRegistered
    const nextIsAccelerator = next.shortcut !== primaryKey
    const sameRegistration = nextIsAccelerator && hasPreviousAccelerator &&
      (!changed || globalShortcut.isRegistered(next.shortcut))
    const addAccelerator = nextIsAccelerator && !sameRegistration
    if (addAccelerator && !register(next.shortcut)) {
      throw new Error('이 단축키를 등록할 수 없습니다. 다른 조합으로 설정해 주세요.')
    }
    try { await prefs.write(next, theme, autoUpdate) }
    catch (error) {
      if (addAccelerator) globalShortcut.unregister(next.shortcut)
      throw error
    }
    if (hasPreviousAccelerator && !sameRegistration) globalShortcut.unregister(priorShortcut)
    acceleratorRegistered = nextIsAccelerator
    settings = next
    settingsWarning = undefined
    if (usesNative() && (changed || primary.status !== 'ready')) await primary.start()
    else if (!usesNative()) primary.stop()
    return snapshot()
  }))
  handle('theme', ['dashboard'], (input: unknown) => exclusive(async () => {
    const next = selection(input, ['light', 'dark'])
    if (next !== theme) {
      if (settingsWarning) throw new Error('기존 설정을 읽을 수 없어 테마를 저장하지 못했습니다. 환경 설정을 먼저 다시 저장해 주세요.')
      await prefs.write(settings, next, autoUpdate)
      theme = next
      nativeTheme.themeSource = theme
      windows.dashboard.setBackgroundColor(dashboardColor(theme))
      for (const window of themedWindows) window.webContents.send('voice:appearance', theme)
    }
    return snapshot()
  }))
  handle('auto-update', ['dashboard'], (enabled: unknown) => exclusive(async () => {
    if (typeof enabled !== 'boolean') throw new Error('업데이트 확인 설정을 선택해 주세요.')
    if (enabled !== autoUpdate) {
      if (settingsWarning) throw new Error('기존 설정을 읽을 수 없어 업데이트 설정을 저장하지 못했습니다. 환경 설정을 먼저 다시 저장해 주세요.')
      await prefs.write(settings, theme, enabled)
      autoUpdate = enabled
    }
    return snapshot()
  }))
  handle('check-update', ['dashboard'], () => updates.check())
  handle('key', ['dashboard'], (action: unknown, value: unknown) => exclusive(async () => {
    switch (selection(action, ['save', 'verify', 'delete'])) {
      case 'save':
        key = await (async () => {
          const parsed = parseKey(value)
          await vault.save(parsed)
          return parsed
        })()
        keyWarning = undefined
        break
      case 'verify': await service().verify(settings); break
      case 'delete': await vault.delete(); key = undefined; keyWarning = undefined; break
    }
    return snapshot()
  }))
  handle('permission', ['dashboard'], async (input: unknown) => {
    const kind = selection(input, ['microphone', 'accessibility', 'keyboard'])
    if (process.platform === 'darwin') {
      if (kind === 'microphone' && microphone() === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      if (kind === 'accessibility') {
        if (!(await targets.permission(true)).ok) await targets.requestPermission()
        await openMacSettings('accessibility')
      }
      if (kind === 'keyboard') await openMacSettings('keyboard')
    }
    return snapshot()
  })

  function runAction(action: unknown) {
    switch (selection(action, ['start', 'stop', 'cancel', 'retry', 'copyRaw', 'copyCleaned', 'dismiss'] as const)) {
      case 'start': begin(false); break
      case 'stop': end(); break
      case 'cancel': workflow.cancel(); break
      case 'retry':
        if (updates.busy) throw new Error('업데이트 확인이나 설치가 끝난 뒤 다시 시도해 주세요.')
        if (!key) throw new Error(permissionMessage)
        if (!operation && workflow.getState().raw && !isBusy(workflow.getState().phase)) {
          overlayRecordingId = 0
          windows.overlay.hide()
          void workflow.retry()
        }
        break
      case 'dismiss': workflow.dismiss(); break
      case 'copyRaw':
      case 'copyCleaned': {
        if (workflow.getState().phase === 'pasting') throw new Error('붙여넣기 키 입력이 끝난 뒤 다시 시도해 주세요.')
        const state = workflow.getState()
        const value = action === 'copyRaw' ? state.raw : state.cleaned
        if (!value) throw new Error('복사할 문장이 없습니다.')
        clipboard.writeText(value)
        break
      }
    }
  }
  handle('action', ['dashboard'], (action: unknown) => { runAction(action); return snapshot() })
  handle('copy-history', ['dashboard'], (id: unknown) => {
    if (workflow.getState().phase === 'pasting') throw new Error('붙여넣기 키 입력이 끝난 뒤 다시 시도해 주세요.')
    const entry = typeof id === 'string' && id.length === 36 ? history.find(item => item.id === id) : undefined
    if (!entry) throw new Error('복사할 기록을 찾을 수 없습니다.')
    clipboard.writeText(entry.text)
  })
  handle('overlay-action', ['overlay'], (action: unknown, id: unknown) => {
    const state = workflow.getState()
    if (parseId(id) !== state.id) throw new Error('표시창의 작업이 바뀌었습니다.')
    switch (selection(action, ['stop', 'cancel', 'copyResult', 'closeResult'])) {
      case 'stop': end(); break
      case 'cancel': workflow.cancel(); break
      case 'copyResult':
      case 'closeResult': {
        const text = overlayResult(state)
        if (!text || !windows.overlay.isVisible()) throw new Error('표시창에 복사할 문장이 없습니다.')
        if (action === 'copyResult') clipboard.writeText(text)
        overlayRecordingId = 0
        windows.overlay.hide()
        break
      }
    }
  })
  handle('live-chunk', ['overlay'], (value: unknown, bytes: unknown) => {
    const active = liveRecording
    const id = parseId(value)
    const { phase } = workflow.getState()
    if (!active || active.id !== id || (phase !== 'recording' && !(phase === 'transcribing' && awaitingAudio === id))) return
    if (!validLiveChunk(bytes)) {
      stopLiveRecording()
      throw new Error('실시간 전사 음성을 읽을 수 없습니다.')
    }
    active.session.append(bytes)
  })
  handle('live-unavailable', ['overlay'], (value: unknown) => {
    if (parseId(value) === liveRecording?.id) stopLiveRecording()
  })
  handle('audio', ['overlay'], (value: unknown, bytes: unknown, mime: unknown) => {
    const id = parseId(value)
    if (id !== awaitingAudio || workflow.getState().phase !== 'transcribing') return
    awaitingAudio = 0
    clearTimeout(audioTimer)
    try { void workflow.submitAudio(id, validateAudio(bytes, mime)) }
    catch (error) { workflow.recordingError(id, publicMessage(error)) }
  })
  handle('error', ['overlay'], (value: unknown, reason: unknown) => {
    const id = parseId(value)
    const code = selection(reason, ['permission', 'device', 'silent', 'tooLarge', 'recording'])
    workflow.recordingError(id, recorderErrors[code])
  })
  windows.overlay.webContents.on('render-process-gone', () => {
    overlayReady = false
    const { id, phase } = workflow.getState()
    if (phase === 'recording' || (phase === 'transcribing' && awaitingAudio)) workflow.recordingError(id, recorderErrors.recording)
    if (!quitting) windows.overlay.reload()
  })
  windows.overlay.webContents.on('did-start-loading', () => { overlayReady = false })
  windows.dashboard.on('blur', finishShortcutCapture)
  windows.dashboard.on('hide', finishShortcutCapture)
  windows.dashboard.webContents.on('render-process-gone', finishShortcutCapture)
  windows.dashboard.webContents.on('did-start-loading', finishShortcutCapture)
  windows.dashboard.on('focus', () => { if (usesNative()) void primary.start() })
  windows.dashboard.on('close', event => {
    if (!quitting) { event.preventDefault(); windows.dashboard.hide() }
  })
  powerMonitor.on('suspend', () => {
    finishShortcutCapture()
    primary.stop()
    workflow.cancel('절전 모드로 전환되어 작업을 취소했습니다.')
  })
  powerMonitor.on('resume', () => { if (usesNative()) void primary.start() })
  const idleIcon = icon(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
  if (process.platform === 'darwin') idleIcon.setTemplateImage(true)
  tray = new Tray(idleIcon)
  tray.setToolTip(name)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: name + ' 열기', click: showDashboard },
    { label: '녹음 시작 / 종료', click: toggle },
    { label: '진행 중인 작업 취소', click: () => workflow.cancel() },
    { type: 'separator' },
    { label: '완전히 종료', click: () => app.quit() }
  ]))
  tray.on('click', showDashboard)
  app.on('activate', showDashboard)
  app.on('second-instance', showDashboard)
  autoUpdater.on('before-quit-for-update', () => { quitting = true })
  app.on('before-quit', (event) => {
    if (historyWritesPending) {
      event.preventDefault()
      if (!quitAfterHistory) {
        quitAfterHistory = true
        void historyWrite.then(() => { quitAfterHistory = false; app.quit() })
      }
      return
    }
    quitting = true
    stopLiveRecording()
    workflow.cancel()
    globalShortcut.unregisterAll()
    primary.stop()
    targets.close()
    clearTimeout(captureTimer); clearTimeout(audioTimer); clearTimeout(hideTimer)
  })
  resumeShortcut()
  void targets.permission()
  await windows.load()
  showDashboard()
  if (autoUpdate && !settingsWarning && updates.available) void updates.check()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  if (process.platform === 'win32') app.setAppUserModelId('com.voiceinput.desktop')
  app.whenReady().then(startApp).catch(() => {
    console.error(app.getName() + ' 앱을 시작할 수 없습니다. 앱 파일과 OS 보안 저장소를 확인해 주세요.')
    app.exit(1)
  })
}
