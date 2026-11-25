import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fakeKey = 'sk-local-testing-00000000000000000000'
function launch(profile: string, appPath = process.cwd()) {
  return electron.launch({
    args: [appPath, '--user-data-dir=' + profile, '--use-fake-device-for-media-stream']
  })
}
async function dashboard(app: ElectronApplication) {
  for (const win of app.windows()) if (win.url().endsWith('/index.html')) return win
  await expect.poll(() => app.windows().some(win => win.url().endsWith('/index.html'))).toBe(true)
  return app.windows().find(win => win.url().endsWith('/index.html'))!
}
async function close(app?: ElectronApplication) {
  await app?.close().catch(() => undefined)
}

test('first run: saves encrypted key, survives app restart, deletes key', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'voiceinput-electron-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    let page = await dashboard(app)
    await expect(page.getByRole('heading', { name: /문장이 됩니다/ })).toBeVisible()
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
    expect(await page.evaluate(() => typeof window.voice.audio)).toBe('undefined')
    await page.screenshot({ path: testInfo.outputPath('setup.png') })
    await page.getByLabel('OpenAI API 키', { exact: true }).fill(fakeKey)
    await page.getByRole('button', { name: '키 저장', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).keyStored).toBe(true)
    expect((await readFile(join(profile, 'key.enc'))).includes(fakeKey)).toBe(false)
    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    const reopened = await page.evaluate(() => window.voice.get())
    expect(reopened.keyStored).toBe(true)
    expect(JSON.stringify(reopened)).not.toContain(fakeKey)
    await page.getByRole('button', { name: '환경 설정', exact: true }).click()
    await page.getByRole('button', { name: '키 삭제', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).keyStored).toBe(false)
    await expect(readFile(join(profile, 'key.enc'))).rejects.toThrow('ENOENT')
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})

test('records with fake device, offers copy fallback, and keeps results after restart', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'voiceinput-electron-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    let page = await dashboard(app)
    await app.evaluate(({ clipboard, systemPreferences }) => {
      Object.defineProperty(clipboard, 'writeText', { configurable: true, value: (text: string) => {
        if (Reflect.get(globalThis, 'voiceInputMockClipboardDenied')) throw new Error('Clipboard unavailable')
        Reflect.set(globalThis, 'voiceInputMockClipboard', text)
      } })
      // The UI test stays independent of the host microphone privacy decision.
      Object.defineProperty(systemPreferences, 'getMediaAccessStatus', { configurable: true, value: () => 'granted' })
      globalThis.fetch = async input => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        const second = Reflect.get(globalThis, 'voiceInputMockSecondRecording')
        if (second && path.endsWith('/audio/transcriptions')) return Response.json({ text: '안전 점검을, 안전 점검을 먼저 진행해요.' })
        if (path.endsWith('/audio/transcriptions')) return Response.json({ text: '회의는 화요일, 아니 수요일이고 도면 검토가 필요해요.' })
        if (path.endsWith('/responses')) return Response.json({
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [
            { type: 'output_text', text: JSON.stringify({ text: second ? '안전 점검을 먼저 진행해요.' : '회의는 수요일이고 도면 검토가 필요해요.' }) }
          ] }]
        })
        throw new Error('Unexpected remote request blocked by the test')
      }
    })
    await page.getByLabel('OpenAI API 키', { exact: true }).fill(fakeKey)
    await page.getByRole('button', { name: '키 저장', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).keyStored).toBe(true)
    const getOverlay = () => app!.windows().find(win => win.url().endsWith('#overlay'))
    await expect.poll(() => Boolean(getOverlay())).toBe(true)
    const overlay = getOverlay()!
    const overlayWindow = await app.browserWindow(overlay)
    const dashboardWindow = await app.browserWindow(page)
    expect(await overlay.evaluate(() => typeof window.voice.get)).toBe('undefined')
    expect(await overlay.evaluate(() => typeof window.voice.copyHistory)).toBe('undefined')
    expect(await overlay.evaluate(() => typeof window.voice.onHistory)).toBe('undefined')
    await page.getByRole('button', { name: '녹음 시작', exact: true }).click()
    await expect(overlay.getByTestId('capture-overlay')).toBeVisible()
    await expect(overlay.getByRole('button', { name: '녹음 종료' })).toBeEnabled()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).state.phase).toBe('recording')
    await expect(overlay.evaluate(() => window.voice.overlayAction('copyResult', 1))).rejects.toThrow(/복사할 문장이 없습니다/)
    await dashboardWindow.evaluate(window => window.hide())
    await overlay.screenshot({ path: testInfo.outputPath('recording.png') })
    await page.waitForTimeout(1100) // Accumulate a real chunk and level samples from Chromium's fake microphone.
    await overlay.getByRole('button', { name: '녹음 종료' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).state).toMatchObject({
      phase: 'copy', raw: '회의는 화요일, 아니 수요일이고 도면 검토가 필요해요.',
      cleaned: '회의는 수요일이고 도면 검토가 필요해요.'
    })
    await expect(overlay.getByText('회의는 수요일이고 도면 검토가 필요해요.', { exact: true })).toBeVisible()
    expect(await dashboardWindow.evaluate(window => window.isVisible())).toBe(false)
    await expect(page.getByRole('heading', { name: /문장이 됩니다/ })).toBeVisible()
    expect(await overlayWindow.evaluate(window => window.isVisible())).toBe(true)
    expect(await overlayWindow.evaluate(window => window.isFocused())).toBe(false)
    const copy = overlay.getByRole('button', { name: '복사하기', exact: true })
    await expect(copy).toBeVisible({ timeout: 2000 })
    await expect(copy).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(copy.locator('svg')).toBeVisible()
    await overlay.screenshot({ path: testInfo.outputPath('result-overlay.png') })
    await app.evaluate(() => Reflect.set(globalThis, 'voiceInputMockClipboardDenied', true))
    await copy.click()
    await expect(overlay.getByRole('status')).toHaveText('결과를 복사할 수 없습니다')
    expect(await overlayWindow.evaluate(window => window.isVisible())).toBe(true)
    await app.evaluate(() => Reflect.set(globalThis, 'voiceInputMockClipboardDenied', false))
    await copy.click()
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'voiceInputMockClipboard'))).toBe('회의는 수요일이고 도면 검토가 필요해요.')
    await expect.poll(() => overlayWindow.evaluate(window => window.isVisible())).toBe(false)
    await dashboardWindow.evaluate(window => window.show())
    await app.evaluate(() => Reflect.set(globalThis, 'voiceInputMockSecondRecording', true))
    await page.getByRole('button', { name: '녹음 시작', exact: true }).click()
    await expect(overlay.getByRole('button', { name: '녹음 종료' })).toBeEnabled()
    await overlay.waitForTimeout(1100)
    await overlay.getByRole('button', { name: '녹음 종료' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).history.map(entry => entry.text)).toEqual([
      '안전 점검을 먼저 진행해요.', '회의는 수요일이고 도면 검토가 필요해요.'
    ])
    const showHistory = () => page.getByRole('button', { name: '결과', exact: true }).click()
    const results = () => page.getByRole('list', { name: '받아쓰기 기록' }).getByRole('listitem')
    await showHistory()
    await expect(results()).toHaveCount(2)
    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    await app.evaluate(({ clipboard }) => {
      Object.defineProperty(clipboard, 'writeText', { configurable: true, value: (text: string) => {
        Reflect.set(globalThis, 'voiceInputMockClipboard', text)
      } })
    })
    await showHistory()
    await expect(results()).toHaveCount(2)
    await expect(results().first().getByText('안전 점검을 먼저 진행해요.', { exact: true })).toBeVisible()
    await expect(results().last().getByText('회의는 수요일이고 도면 검토가 필요해요.', { exact: true })).toBeVisible()
    await expect(results().last().locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
    await expect(page.getByText('회의는 화요일, 아니 수요일이고 도면 검토가 필요해요.', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '결과 닫기' })).toHaveCount(0)
    await results().last().getByRole('button', { name: '결과 복사' }).click()
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'voiceInputMockClipboard'))).toBe('회의는 수요일이고 도면 검토가 필요해요.')
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})

test('hides successful completion promptly and still saves the result', async () => {
  test.skip(process.platform !== 'darwin', 'macOS helper fixture')
  const fixture = await mkdtemp(join(tmpdir(), 'sitevoice-completion-'))
  let app: ElectronApplication | undefined
  try {
    await Promise.all(['package.json', 'dist', 'build'].map(item =>
      cp(join(process.cwd(), item), join(fixture, item), { recursive: true })))
    await symlink(join(process.cwd(), 'node_modules'), join(fixture, 'node_modules'), 'dir')
    const helper = join(fixture, 'native', 'bin', `darwin-${process.arch}`)
    const trigger = join(fixture, 'trigger')
    await mkdir(helper, { recursive: true })
    await writeFile(trigger, '')
    // Keep real shortcuts, clipboard writes and AX events out of this test.
    await writeFile(join(helper, 'voice-target'), `#!/usr/bin/env node
import { watchFile, unwatchFile } from 'node:fs'
import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
const trigger = ${JSON.stringify(trigger)}
if (process.argv.includes('--shortcut')) {
  watchFile(trigger, { interval: 25 }, () => console.log('TRIGGER'))
  input.on('close', () => unwatchFile(trigger))
  console.log('READY')
} else {
  input.on('line', line => console.log(JSON.stringify({ ok: /^(PERMISSION|SNAPSHOT|RESET|PASTE .+)$/.test(line) })))
}
`, { mode: 0o700 })
    app = await launch(join(fixture, 'profile'), fixture)
    const page = await dashboard(app)
    const sentence = '도면을 오늘 검토합니다.'
    await app.evaluate(({ systemPreferences }, text) => {
      Object.defineProperty(systemPreferences, 'getMediaAccessStatus', { configurable: true, value: () => 'granted' })
      globalThis.fetch = async input => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        if (path.endsWith('/audio/transcriptions')) return Response.json({ text })
        if (path.endsWith('/responses')) return Response.json({
          status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [
            { type: 'output_text', text: JSON.stringify({ text }) }
          ] }]
        })
        throw new Error('Unexpected remote request blocked by the test')
      }
    }, sentence)
    await page.getByLabel('OpenAI API 키', { exact: true }).fill(fakeKey)
    await page.getByRole('button', { name: '키 저장', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get()))).toMatchObject({
      keyStored: true, accessibility: 'granted', shortcutPermission: 'ready'
    })
    const overlay = app.windows().find(win => win.url().endsWith('#overlay'))!
    const overlayWindow = await app.browserWindow(overlay)
    await (await app.browserWindow(page)).evaluate(window => window.hide())
    await writeFile(trigger, 'start')
    await expect(overlay.getByRole('button', { name: '녹음 종료' })).toBeEnabled()
    await overlay.waitForTimeout(1100) // Collect audio chunks from the fake microphone.
    await overlay.getByRole('button', { name: '녹음 종료' }).click()
    await expect(overlay.getByRole('status')).toHaveText('처리 완료')
    await expect.poll(() => overlayWindow.evaluate(window => window.isVisible()), { timeout: 1200 }).toBe(false)
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).history[0]?.text).toBe(sentence)
  } finally {
    await close(app)
    await rm(fixture, { recursive: true, force: true })
  }
})

test('persists appearance and startup update preferences across restarts', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'voiceinput-appearance-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    let page = await dashboard(app)
    const getOverlay = () => app!.windows().find(win => win.url().endsWith('#overlay'))
    await expect.poll(() => Boolean(getOverlay())).toBe(true)
    const overlay = getOverlay()!
    const color = () => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)
    const choose = (name: string) => page.getByRole('group', { name: '화면 테마' }).getByRole('button', { name, exact: true })
    await expect(page).toHaveTitle('SiteVoice')
    await expect(choose('밝게')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(color).toBe('rgb(255, 255, 255)')
    await page.screenshot({ path: testInfo.outputPath('light.png') })
    await choose('어둡게').click()
    await expect(choose('어둡게')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(color).toBe('rgb(24, 24, 24)')
    await expect.poll(() => overlay.getByTestId('capture-overlay').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(34, 34, 34)')
    await page.screenshot({ path: testInfo.outputPath('dark.png') })
    expect(await overlay.evaluate(() => typeof window.voice.setTheme)).toBe('undefined')
    expect(await overlay.evaluate(() => typeof window.voice.checkUpdate)).toBe('undefined')
    const autoCheck = () => page.getByRole('checkbox', { name: '앱을 시작할 때 업데이트 자동 확인' })
    const settingsPage = () => page.getByRole('button', { name: '환경 설정', exact: true }).click()
    await settingsPage()
    await expect(autoCheck()).toBeChecked()
    await expect(page.getByRole('button', { name: '업데이트 확인', exact: true })).toBeDisabled()
    await autoCheck().click()
    await expect(autoCheck()).not.toBeChecked()
    await autoCheck().scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('update-settings.png') })
    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    await expect(choose('어둡게')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(color).toBe('rgb(24, 24, 24)')
    await settingsPage()
    await expect(autoCheck()).not.toBeChecked()
    await choose('밝게').click()
    await expect.poll(color).toBe('rgb(255, 255, 255)')
    expect((await page.evaluate(() => window.voice.get())).theme).toBe('light')
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})

test('records a shortcut by pressing keys, cancels capture and restores the platform default', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sitevoice-key-picker-'))
  let app: ElectronApplication | undefined
  const defaultKey = process.platform === 'darwin' ? 'Fn' : 'Windows'
  try {
    app = await launch(profile)
    let page = await dashboard(app)
    expect((await page.evaluate(() => window.voice.get())).settings.shortcut).toBe(defaultKey)
    const settings = () => page.getByRole('button', { name: '환경 설정', exact: true }).click()
    const picker = () => page.getByRole('button', { name: '단축키 입력', exact: true })
    const value = () => page.locator('output[data-shortcut]')
    const save = () => page.getByRole('button', { name: '환경 설정 저장' }).click()
    await settings()
    await expect(value()).toHaveAttribute('data-shortcut', defaultKey)
    await picker().click()
    await expect(picker()).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await expect(picker()).toHaveAttribute('aria-pressed', 'false')
    await expect(value()).toHaveAttribute('data-shortcut', defaultKey)
    await picker().click()
    await page.keyboard.press('Control+Alt+F9')
    await expect(value()).toHaveAttribute('data-shortcut', 'Control+Alt+F9')
    await save()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).settings.shortcut).toBe('Control+Alt+F9')
    expect((await page.evaluate(() => window.voice.get())).shortcutRegistered).toBe(true)
    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    await settings()
    await expect(value()).toHaveAttribute('data-shortcut', 'Control+Alt+F9')
    await picker().click()
    await page.keyboard.press('Control+Alt+F9')
    await expect(picker()).toHaveAttribute('aria-pressed', 'false')
    await expect(value()).toHaveAttribute('data-shortcut', 'Control+Alt+F9')
    await page.getByRole('button', { name: '기본값 사용', exact: true }).click()
    await expect(value()).toHaveAttribute('data-shortcut', defaultKey)
    await save()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).settings.shortcut).toBe(defaultKey)
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})

test('opens the matching macOS permission panes and leaves regular shortcut capture available', async () => {
  test.skip(process.platform !== 'darwin', 'macOS permission panes')
  const profile = await mkdtemp(join(tmpdir(), 'sitevoice-permissions-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    const page = await dashboard(app)
    await app.evaluate(({ shell }) => {
      shell.openExternal = async url => { Reflect.set(globalThis, 'sitevoiceLastPermissionPane', url) }
    })
    const pane = () => app!.evaluate(() => Reflect.get(globalThis, 'sitevoiceLastPermissionPane'))
    await page.getByRole('button', { name: '환경 설정', exact: true }).click()
    await page.getByRole('button', { name: '손쉬운 사용 설정 열기', exact: true }).click()
    await expect.poll(pane).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    await page.getByRole('button', { name: '입력 모니터링 설정 열기', exact: true }).click()
    await expect.poll(pane).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
    await page.getByRole('button', { name: '키보드 설정 열기', exact: true }).click()
    await expect.poll(pane).toBe('x-apple.systempreferences:com.apple.Keyboard-Settings.extension')
    const win = await app.browserWindow(page)
    await win.evaluate(window => window.focus())
    await page.getByRole('button', { name: '단축키 입력', exact: true }).click()
    await page.keyboard.press('Control+Alt+F9')
    await expect(page.locator('output[data-shortcut]')).toHaveAttribute('data-shortcut', 'Control+Alt+F9')
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})

test('saves a glossary term and its meaning, including edits after restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sitevoice-glossary-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    let page = await dashboard(app)
    const openSettings = () => page.getByRole('button', { name: '환경 설정', exact: true }).click()
    const glossary = () => page.getByRole('region', { name: '개인 용어 사전' })
    const save = async () => {
      await page.getByRole('button', { name: '환경 설정 저장' }).click()
      await expect(page.getByText('환경 설정을 저장했습니다.')).toBeVisible()
    }
    await openSettings()
    await glossary().getByRole('textbox', { name: '새 용어', exact: true }).fill('숏크리트')
    await glossary().getByRole('textbox', { name: '뜻·사용 맥락 (선택)', exact: true }).fill('터널 벽면에 뿜어 붙이는 콘크리트')
    await glossary().getByRole('button', { name: '용어 추가' }).click()
    await save()

    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    await openSettings()
    await expect(glossary().getByRole('textbox', { name: '등록 용어 1', exact: true })).toHaveValue('숏크리트')
    const registeredMeaning = () => glossary().getByRole('textbox', { name: '등록 용어 1의 뜻·사용 맥락', exact: true })
    await expect(registeredMeaning()).toHaveValue('터널 벽면에 뿜어 붙이는 콘크리트')
    await registeredMeaning().fill('터널 굴착면이나 사면에 뿜어 붙이는 콘크리트')
    await save()
    expect((await page.evaluate(() => window.voice.get())).settings.terms).toEqual([
      { term: '숏크리트', meaning: '터널 굴착면이나 사면에 뿜어 붙이는 콘크리트' },
    ])
    await close(app)
    app = await launch(profile)
    page = await dashboard(app)
    await openSettings()
    await expect(registeredMeaning()).toHaveValue('터널 굴착면이나 사면에 뿜어 붙이는 콘크리트')
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
  }
})
