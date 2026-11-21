import { app, autoUpdater, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, safeStorage, systemPreferences, Tray, type IpcMainInvokeEvent } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWorkflow, isBusy } from '../core/workflow.ts'
import { createSpeechService } from '../core/openai.ts'
import { validateSettings, validateAudio, MAX_RECORDING_MS } from '../core/validation.ts'
import type { Recording, Snapshot, State, Theme } from '../shared.ts'
import { parseId, parseKey, type NativeReason, type NativeReply, type View } from './boundary.ts'
import { createTargetClient } from './native.ts'
import { createPreferences } from './preferences.ts'
import { createVault } from './vault.ts'
import { createWindows, dashboardColor } from './windows.ts'
import { createUpdateController } from './updates.ts'

const running = new Set(['recording', 'transcribing', 'cleaning', 'pasting'])
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

async function startApp() {
  const name = app.getName()
  const directory = app.getPath('userData')
  const resources = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const targets = createTargetClient(join(resources, app.isPackaged ? 'targets' : 'native/bin'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const prefs = createPreferences(directory)
  const loaded = await prefs.read()
  let settings = loaded.settings
  let theme: Theme = loaded.theme
  let autoUpdate = loaded.autoUpdate
  nativeTheme.themeSource = theme
  let settingsWarning = loaded.message
  const vault = createVault(directory, {
    available: () => ['darwin', 'win32'].includes(process.platform) ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async bytes => {
      const result = await safeStorage.decryptStringAsync(bytes)
      return result.shouldReEncrypt ? (await safeStorage.decryptStringAsync(bytes)).result : result.result
    }
  })
  let keyWarning: string | undefined
  let key = await vault.read().catch(error => { keyWarning = publicMessage(error); return undefined })
  let shortcutRegistered = false
  let overlayReady = false
  let quitting = false
  let prior: State | undefined
  let target: Promise<NativeReply> | undefined
  let captureTimer: NodeJS.Timeout | undefined
  let audioTimer: NodeJS.Timeout | undefined
  let hideTimer: NodeJS.Timeout | undefined
  let awaitingAudio = 0
  let operation = false
  let tray: Tray

  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  const page = pathToFileURL(join(app.getAppPath(), 'dist/ui/index.html')).href
  const windows = createWindows(name, page, join(import.meta.dirname, 'preload.cjs'))
  const themedWindows = [windows.dashboard, windows.overlay]
  for (const window of themedWindows) {
    window.webContents.on('did-finish-load', () => window.webContents.send('voice:appearance', theme))
  }
  const microphone = () => systemPreferences.getMediaAccessStatus('microphone')
  const icon = (file: string) => nativeImage.createFromPath(join(resources, 'build', file))
  function service() {
    if (!key) throw new Error(permissionMessage)
    return createSpeechService(key)
  }

  const workflow = createWorkflow({
    transcribe: (audio, signal) => service().transcribe(audio, settings, signal),
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
    canInterrupt: () => !quitting && !operation && !isBusy(workflow.getState().phase),
    async confirm(version) {
      const result = await dialog.showMessageBox(windows.dashboard, {
        type: 'question',
        title: name + ' 업데이트',
        message: '새 버전 ' + version + '을 설치할까요?',
        detail: '설치를 선택하면 업데이트를 내려받은 뒤 앱을 다시 시작합니다. 열려 있는 결과는 닫힙니다.',
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
    windows.overlay.webContents.send('voice:record', { command, id, microphoneId: settings.microphoneId } satisfies Recording)
  }
  function publish(state: State) {
    if (quitting) return
    const { phase, id, startedAt } = state
    windows.dashboard.webContents.send('voice:state', state)
    windows.overlay.webContents.send('voice:state', { phase, id, startedAt, message: state.message })
    tray.setToolTip(name + (phase === 'recording' ? ' · 녹음 중' : running.has(phase) ? ' · 처리 중' : ''))
    const trayIcon = icon(phase === 'recording' ? 'tray-recording.png' : (process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'))
    if (process.platform === 'darwin' && phase !== 'recording') trayIcon.setTemplateImage(true)
    tray.setImage(trayIcon)
    if (running.has(phase)) {
      if (phase === 'pasting') globalShortcut.unregister('Escape')
      clearTimeout(hideTimer)
    } else {
      clearTimeout(captureTimer)
      clearTimeout(audioTimer)
      awaitingAudio = 0
      globalShortcut.unregister('Escape')
      if (prior && running.has(prior.phase)) {
        record('release', prior.id)
        void targets.reset()
        target = undefined
      }
      if ((phase === 'copy' || phase === 'failed') && !windows.dashboard.isVisible()) windows.dashboard.showInactive()
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => windows.overlay.hide(), phase === 'idle' ? 0 : 2500)
    }
    prior = state
  }

  async function snapshot(): Promise<Snapshot> {
    const mic = microphone()
    const trusted = await targets.permission()
    const accessibility = process.platform === 'darwin'
      ? trusted.ok ? 'granted' : trusted.reason === 'permission' ? 'denied' : 'unavailable'
      : trusted.ok ? 'available' : 'unavailable'
    return {
      name, settings, theme, version: app.getVersion(), autoUpdate, updatesAvailable: updates.available,
      keyStored: !!key, protectedStorage: await (['darwin', 'win32'].includes(process.platform)
        ? safeStorage.isAsyncEncryptionAvailable().catch(() => false) : Promise.resolve(false)),
      microphone: mic, accessibility, shortcutRegistered, platform: process.platform, state: resultState()
    }
  }
  function showDashboard() { windows.dashboard.show(); windows.dashboard.focus() }
  function begin(external: boolean) {
    if (isBusy(workflow.getState().phase) || operation || quitting) return
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
    try { return globalShortcut.register(shortcut, toggle) } catch { return false }
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

  handle('get', ['dashboard'], snapshot)
  handle('ready', ['overlay'], () => { overlayReady = true })
  handle('save', ['dashboard'], (input: unknown) => exclusive(async () => {
    const next = validateSettings(input)
    const changed = next.shortcut !== settings.shortcut || !shortcutRegistered
    if (changed && !register(next.shortcut)) throw new Error('이 단축키를 등록할 수 없습니다. 다른 조합으로 설정해 주세요.')
    try { await prefs.write(next, theme, autoUpdate) }
    catch (error) {
      if (changed) globalShortcut.unregister(next.shortcut)
      throw error
    }
    if (changed && shortcutRegistered) globalShortcut.unregister(settings.shortcut)
    settings = next
    settingsWarning = undefined
    shortcutRegistered = true
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
    const kind = selection(input, ['microphone', 'accessibility'])
    if (process.platform === 'darwin') {
      if (kind === 'microphone' && microphone() === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      if (kind === 'accessibility') await targets.requestPermission()
    }
    return snapshot()
  })

  function runAction(action: unknown, dashboard: boolean) {
    switch (selection(action, dashboard
      ? ['start', 'stop', 'cancel', 'retry', 'copyRaw', 'copyCleaned', 'dismiss'] as const
      : ['stop', 'cancel'] as const)) {
      case 'start': begin(false); break
      case 'stop': end(); break
      case 'cancel': workflow.cancel(); break
      case 'retry':
        if (updates.busy) throw new Error('업데이트 확인이나 설치가 끝난 뒤 다시 시도해 주세요.')
        if (!key) throw new Error(permissionMessage)
        if (!operation) void workflow.retry()
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
  // Separate action channels to avoid sending settings or results to the overlay.
  handle('action', ['dashboard'], (action: unknown) => { runAction(action, true); return snapshot() })
  handle('overlay-action', ['overlay'], (action: unknown, id: unknown) => {
    if (parseId(id) === workflow.getState().id) runAction(action, false)
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
  windows.dashboard.on('close', event => {
    if (!quitting) { event.preventDefault(); windows.dashboard.hide() }
  })
  powerMonitor.on('suspend', () => workflow.cancel('절전 모드로 전환되어 작업을 취소했습니다.'))
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
  app.on('before-quit', () => {
    quitting = true
    workflow.cancel()
    globalShortcut.unregisterAll()
    targets.close()
    clearTimeout(captureTimer); clearTimeout(audioTimer); clearTimeout(hideTimer)
  })
  shortcutRegistered = register(settings.shortcut)
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
