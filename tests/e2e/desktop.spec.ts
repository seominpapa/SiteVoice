import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fakeKey = 'sk-local-testing-00000000000000000000'
function launch(profile: string) {
  return electron.launch({
    args: [process.cwd(), '--user-data-dir=' + profile, '--use-fake-device-for-media-stream']
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

test('records with fake device, cleans through mocked OpenAI, shows copy fallback', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'voiceinput-electron-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(profile)
    const page = await dashboard(app)
    await app.evaluate(({ clipboard, systemPreferences }) => {
      Object.defineProperty(clipboard, 'writeText', { configurable: true, value: (text: string) => {
        Reflect.set(globalThis, 'voiceInputMockClipboard', text)
      } })
      // The UI test stays independent of the host microphone privacy decision.
      Object.defineProperty(systemPreferences, 'getMediaAccessStatus', { configurable: true, value: () => 'granted' })
      globalThis.fetch = async input => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        if (path.endsWith('/audio/transcriptions')) return Response.json({ text: '회의는 화요일, 아니 수요일이고 도면 검토가 필요해요.' })
        if (path.endsWith('/responses')) return Response.json({
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [
            { type: 'output_text', text: JSON.stringify({ text: '회의는 수요일이고 도면 검토가 필요해요.' }) }
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
    expect(await overlay.evaluate(() => typeof window.voice.get)).toBe('undefined')
    await page.getByRole('button', { name: '녹음 시작', exact: true }).click()
    await expect(overlay.getByTestId('capture-overlay')).toBeVisible()
    await expect(overlay.getByRole('button', { name: '녹음 종료' })).toBeEnabled()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).state.phase).toBe('recording')
    await overlay.screenshot({ path: testInfo.outputPath('recording.png') })
    await page.waitForTimeout(1100) // Accumulate a real chunk and level samples from Chromium's fake microphone.
    await overlay.getByRole('button', { name: '녹음 종료' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).state).toMatchObject({
      phase: 'copy', raw: '회의는 화요일, 아니 수요일이고 도면 검토가 필요해요.',
      cleaned: '회의는 수요일이고 도면 검토가 필요해요.'
    })
    await expect(page.getByRole('heading', { name: '정리한 문장' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('result.png') })
    await page.getByRole('button', { name: '정리 결과 복사' }).click()
    expect(await app.evaluate(() => Reflect.get(globalThis, 'voiceInputMockClipboard'))).toBe('회의는 수요일이고 도면 검토가 필요해요.')
    await page.getByRole('button', { name: '결과 닫기' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.voice.get())).state.raw).toBeUndefined()
  } finally {
    await close(app)
    await rm(profile, { recursive: true, force: true })
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
