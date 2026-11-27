import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { State } from '../../src/shared.ts'

const run = promisify(execFile)
const driver = fileURLToPath(new URL('windows-notepad.ps1', import.meta.url))
async function notepad(command: 'open' | 'shortcut' | 'read' | 'close', target: string) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass', '-File', driver, command, target], { windowsHide: true, timeout: 18_000 })
  return stdout.trim()
}

test('Windows global shortcut records and pastes at the caret in Notepad', async () => {
  test.skip(process.platform !== 'win32' || process.env.SITEVOICE_E2E_WINDOWS_DESKTOP !== '1',
    'Opt in on a disposable interactive Windows desktop with built native helper and Notepad')
  test.setTimeout(85_000)
  await access(join(process.cwd(), 'native', 'bin', `win32-${process.arch}`, 'voice-target.exe'))
  const folder = await mkdtemp(join(tmpdir(), 'sitevoice-notepad-'))
  const document = join(folder, 'SiteVoice-audio-probe.txt')
  const original = 'before [] after'
  const clipboardMarker = 'SiteVoice original clipboard marker'
  const raw = '오늘 회의, 회의 내용을 정리합니다.'
  const cleaned = '오늘 회의 내용을 정리합니다.'
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let notepadId = ''
  try {
    await writeFile(document, original)
    const voice = app = await electron.launch({ args: [process.cwd(), '--user-data-dir=' + join(folder, 'profile'),
      '--use-fake-device-for-media-stream'] })
    const windowAt = (suffix: string) => voice.windows().find(page => page.url().endsWith(suffix))
    await expect.poll(() => Boolean(windowAt('/index.html') && windowAt('#overlay'))).toBe(true)
    const page = windowAt('/index.html')!
    const overlay = windowAt('#overlay')!
    await voice.evaluate(({ clipboard }, data) => {
      clipboard.writeText(data.clipboardMarker)
      const fetchFixture: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/audio/transcriptions') {
          const audio = init?.body instanceof FormData && init.body.get('file')
          if (!(audio instanceof Blob) || audio.size === 0) throw new Error('No audio reached the transcription endpoint')
          return Response.json({ text: data.raw })
        }
        if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses' &&
            typeof init?.body === 'string' && JSON.parse(JSON.parse(init.body).input).transcript === data.raw) {
          return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify({ text: data.cleaned }) }] }] })
        }
        throw new Error('Unexpected provider request; no network calls allowed in this test')
      }
      globalThis.fetch = Object.assign(fetchFixture, { Response })
    }, { clipboardMarker, raw, cleaned })
    const prepared = await page.evaluate(async () => {
      window.voice.onState(state => Reflect.set(window, 'siteVoiceE2EDictationState', state))
      await window.voice.key('save', 'sk-local-testing-00000000000000000000')
      const { settings } = await window.voice.get()
      return window.voice.save({ ...settings, shortcut: 'F9', transcriptionModel: 'gpt-transcribe' })
    })
    expect(prepared).toMatchObject({ keyStored: true, shortcutRegistered: true, accessibility: 'available' })
    const dashboard = await voice.browserWindow(page)
    await dashboard.evaluate(window => window.hide())
    const editor = JSON.parse(await notepad('open', document)) as { pid: number; integrity: number; className: string }
    notepadId = String(editor.pid)
    expect(notepadId).toMatch(/^\d+$/)
    console.log(`Notepad editor class: ${editor.className}; Windows integrity RID: ${editor.integrity}`)
    expect(editor.integrity, 'Notepad must run unelevated in the interactive desktop').toBeLessThan(0x3000)
    expect(editor.integrity, 'Notepad token integrity must be readable').toBeGreaterThan(0)
    expect(JSON.parse(await notepad('read', notepadId))).toBe(original)

    await notepad('shortcut', notepadId)
    await expect(overlay.getByRole('button', { name: '녹음 종료', exact: true })).toBeVisible()
    await expect(overlay.getByText('마이크 연결됨', { exact: true })).toBeVisible()
    await expect.poll(async () => Number(await overlay.getByRole('meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0)
    await notepad('shortcut', notepadId)
    // Wait for a terminal phase, then report the precise fallback message on failure.
    const readState = () => page.evaluate(() => Reflect.get(window, 'siteVoiceE2EDictationState') as State | undefined)
    await expect.poll(async () => (await readState())?.phase ?? '').toMatch(/^(completed|copy|failed)$/)
    const state = await readState()
    expect(state, state?.message).toMatchObject({ phase: 'completed', raw, cleaned })
    expect(JSON.parse(await notepad('read', notepadId))).toBe(`before [${cleaned}] after`)
    expect(await voice.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardMarker)
  } finally {
    if (/^\d+$/.test(notepadId)) await notepad('close', notepadId).catch(() => undefined)
    await app?.close().catch(() => undefined)
    await rm(folder, { recursive: true, force: true })
  }
})
