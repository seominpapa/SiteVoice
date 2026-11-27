import { _electron as electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { State } from '../../src/shared.ts'

const run = promisify(execFile)
const driver = fileURLToPath(new URL('windows-notepad.ps1', import.meta.url))
async function desktop(command: 'open' | 'open-uia' | 'shortcut' | 'read' | 'close', target: string) {
  const { stdout, stderr } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass', '-File', driver, command, target], { windowsHide: true, timeout: 35_000 })
    .catch(error => {
      throw new Error(`Windows desktop ${command} ${error.killed ? 'timed out' : 'failed'}: ${error.stderr || error.message}`)
    })
  if (stderr.trim()) console.log(stderr.trim())
  return stdout.trim()
}

type Editor = { pid: number; integrity: number; className: string }
type Scenario = 'f9' | 'logo' | 'uia' | 'published'

async function verifyDictation(scenario: Scenario) {
  test.skip(process.platform !== 'win32' || process.env.SITEVOICE_E2E_WINDOWS_DESKTOP !== '1',
    'Opt in on a disposable interactive Windows desktop with built native helper and Notepad')
  const manual = scenario === 'logo'
  const baseline = scenario === 'published'
  const probe = scenario === 'uia' || baseline ? process.env.SITEVOICE_E2E_UIA_EDITOR : undefined
  test.skip(manual && process.env.SITEVOICE_E2E_WINDOWS_LOGO_KEY !== '1', 'Press the real Windows logo key on an interactive desktop')
  test.skip((scenario === 'uia' || baseline) && !probe, 'Build the external UI Automation test editor')
  test.skip(baseline && process.env.SITEVOICE_E2E_PUBLISHED_HELPER !== '1', 'Use the published version of the native helper')
  test.setTimeout(manual ? 150_000 : 85_000)
  await access(join(process.cwd(), 'native', 'bin', `win32-${process.arch}`, 'voice-target.exe'))
  const folder = await mkdtemp(join(tmpdir(), 'sitevoice-notepad-'))
  const document = join(folder, 'SiteVoice-audio-probe.txt')
  const original = probe ? 'before  after' : 'before [] after'
  const clipboardMarker = 'SiteVoice original clipboard marker'
  const raw = '오늘 회의, 회의 내용을 정리합니다.'
  const cleaned = '오늘 회의 내용을 정리합니다.'
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let editor: Editor | undefined
  try {
    if (!probe) await writeFile(document, original)
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
    const prepared = await page.evaluate(async manual => {
      window.voice.onState(state => Reflect.set(window, 'siteVoiceE2EDictationState', state))
      await window.voice.key('save', 'sk-local-testing-00000000000000000000')
      const { settings } = await window.voice.get()
      return window.voice.save({ ...settings, shortcut: manual ? settings.shortcut : 'F9', transcriptionModel: 'gpt-transcribe' })
    }, manual)
    expect(prepared).toMatchObject({ keyStored: true, shortcutRegistered: true, accessibility: 'available' })
    expect(prepared.settings.shortcut).toBe(manual ? 'Windows' : 'F9')
    const dashboard = await voice.browserWindow(page)
    await dashboard.evaluate(window => window.hide())
    editor = JSON.parse(await desktop(probe ? 'open-uia' : 'open', document)) as Editor
    const pid = String(editor.pid)
    expect(pid).toMatch(/^\d+$/)
    console.log(`Focused editor class: ${editor.className}; Windows integrity RID: ${editor.integrity}`)
    expect(editor.integrity, 'The target must run unelevated in an interactive desktop').toBeLessThan(0x3000)
    expect(editor.integrity, 'The target token integrity must be readable').toBeGreaterThan(0)
    if (probe) {
      const mode = process.env.SITEVOICE_E2E_UIA_MODE ?? 'missing-both'
      const { stdout } = await run(probe, ['--inspect', mode], { windowsHide: true, timeout: 15_000 })
      console.log(`UI Automation check (${mode}): ${stdout.trim()}`)
    }
    const readText = async () => probe ? (await readFile(document, 'utf8')).trimEnd() : JSON.parse(await desktop('read', pid)) as string
    expect(await readText()).toBe(original)

    if (manual) console.log('Leave Notepad focused and tap the Windows logo key once to start recording.')
    else await desktop('shortcut', pid)
    await expect(overlay.getByRole('button', { name: '녹음 종료', exact: true }))
      .toBeVisible({ timeout: manual ? 60_000 : 10_000 })
    await expect(overlay.getByText('마이크 연결됨', { exact: true })).toBeVisible()
    await expect.poll(async () => Number(await overlay.getByRole('meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0)
    if (manual) console.log('Audio is being recorded. Tap the Windows logo key again to transcribe and paste.')
    else await desktop('shortcut', pid)
    // Wait for a terminal phase, then report the precise fallback message on failure.
    const readState = () => page.evaluate(() => Reflect.get(window, 'siteVoiceE2EDictationState') as State | undefined)
    await expect.poll(async () => (await readState())?.phase ?? '', { timeout: manual ? 60_000 : 10_000 })
      .toMatch(/^(completed|copy|failed)$/)
    const state = await readState()
    expect(state, state?.message).toMatchObject({ phase: baseline ? 'copy' : 'completed', raw, cleaned })
    if (baseline) expect(state?.message).toBe('안전한 입력 칸인지 확인할 수 없어 자동 입력을 보류했습니다.')
    const expected = baseline ? original : probe ? `before ${cleaned} after` : `before [${cleaned}] after`
    await expect.poll(readText).toBe(expected)
    console.log(`Observed disposition: ${state?.phase}; editor text matches expectation.`)
    expect(await voice.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardMarker)
  } finally {
    if (editor && Number.isInteger(editor.pid) && editor.pid > 0)
      await desktop('close', String(editor.pid)).catch(() => undefined)
    await app?.close().catch(() => undefined)
    await rm(folder, { recursive: true, force: true })
  }
}

test('Windows F9 records and pastes at the caret in Notepad', () => verifyDictation('f9'))
// On a real test desktop use SITEVOICE_E2E_WINDOWS_LOGO_KEY=1 and --grep "logo key".
test('Windows logo key records and pastes at the caret in Notepad', () => verifyDictation('logo'))
test('Windows F9 pastes in an external editor missing accessibility properties', () => verifyDictation('uia'))
test('Windows published native helper falls back to copy for the same external editor', () => verifyDictation('published'))
