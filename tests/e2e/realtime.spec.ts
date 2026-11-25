import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const raw = '두 가지 기능을 하는 앱을 만들고 싶어. 잘 듣고 잘 말하고'
const cleaned = '두 가지 기능을 하는 앱을 만들고 싶어.\n1. 잘 듣고\n2. 잘 말하고'
const findPage = (hash = '') => (window: { url(): string }) => window.url().endsWith('/index.html' + hash)

test('default realtime sends audio during recording and falls back to the same recording on disconnect', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sitevoice-realtime-'))
  const args = [process.cwd(), '--user-data-dir=' + profile, '--use-fake-device-for-media-stream']
  let app = await electron.launch({ args })
  try {
    await app.evaluate(({ systemPreferences }, samples) => {
      Object.defineProperty(systemPreferences, 'getMediaAccessStatus', { configurable: true, value: () => 'granted' })
      const observed = { chunks: 0, commits: 0, connections: 0, closed: 0, batch: [] as string[], cleanup: 0, failNext: false }
      Reflect.set(globalThis, 'siteVoiceTestRealtime', observed)
      class MockSocket extends EventTarget {
        bufferedAmount = 0
        constructor(url: string) {
          super()
          if (url !== 'wss://api.openai.com/v1/realtime?intent=transcription') throw new Error('Unexpected realtime endpoint')
          observed.connections++
          queueMicrotask(() => this.dispatchEvent(new Event('open')))
        }
        send(data: string) {
          const message = JSON.parse(data)
          switch (message.type) {
            case 'session.update':
              this.reply({ type: 'session.updated', session: message.session })
              break
            case 'input_audio_buffer.append':
              if (Buffer.from(message.audio, 'base64').length === 4800) observed.chunks++
              if (observed.failNext) {
                observed.failNext = false
                queueMicrotask(() => this.dispatchEvent(new Event('error')))
              }
              break
            case 'input_audio_buffer.commit':
              observed.commits++
              this.reply({ type: 'input_audio_buffer.committed', item_id: 'fake-item' })
              this.reply({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fake-item',
                content_index: 0, transcript: samples.raw })
              break
          }
        }
        close() { observed.closed++ }
        reply(frame: object) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })))
        }
      }
      Reflect.set(globalThis, 'WebSocket', MockSocket)
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).pathname === '/v1/audio/transcriptions') {
          const form = await request.formData()
          if (!(form.get('file') instanceof File)) throw new Error('Missing fallback audio')
          observed.batch.push(String(form.get('model')))
          return Response.json({ text: samples.raw })
        }
        if (new URL(request.url).pathname === '/v1/responses') {
          observed.cleanup++
          return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify({ text: samples.cleaned }) }] }] })
        }
        throw new Error('Unexpected remote request blocked by the test')
      }
    }, { raw, cleaned })
    const metrics = () => app.evaluate(() => Reflect.get(globalThis, 'siteVoiceTestRealtime'))
    await expect.poll(() => app.windows().some(findPage()) && app.windows().some(findPage('#overlay'))).toBe(true)
    const page = app.windows().find(findPage())!
    const overlay = app.windows().find(findPage('#overlay'))!
    const snapshot = () => page.evaluate(() => window.voice.get())
    expect((await snapshot()).settings.transcriptionModel).toBe('gpt-live-transcribe')
    expect(await page.evaluate(() => typeof window.voice.liveChunk)).toBe('undefined')
    await page.getByLabel('OpenAI API 키', { exact: true }).fill('sk-local-testing-00000000000000000000')
    await page.getByRole('button', { name: '키 저장', exact: true }).click()
    await expect.poll(async () => (await snapshot()).keyStored).toBe(true)
    const start = () => page.getByRole('button', { name: '녹음 시작', exact: true }).click()
    const stop = () => overlay.getByRole('button', { name: '녹음 종료' }).click()
    const heardAudio = () => expect.poll(async () => Number(await overlay.getByRole('meter').getAttribute('aria-valuenow')),
      { intervals: [50, 50, 100] }).toBeGreaterThan(10)
    const expectHistory = (phase: string, history: string[]) => expect.poll(async () => {
      const { state, history: entries } = await snapshot()
      return { phase: state.phase, history: entries.map(({ text }) => text), message: state.message }
    }).toMatchObject({ phase, history })
    const expectDiagnostics = async (model: string, mode: string, count: number) => {
      await page.getByRole('button', { name: '결과', exact: true }).click()
      const title = page.getByText('최근 받아쓰기 진단', { exact: true })
      const details = page.locator('details').filter({ has: title })
      await expect(details).toHaveJSProperty('open', false)
      await title.click()
      await expect(details.getByText(model, { exact: true })).toBeVisible()
      await expect(details.getByText(mode, { exact: true })).toBeVisible()
      for (const label of ['녹음 길이', '녹음 종료 후 전사', '문장 정리']) {
        await expect(details.getByText(label, { exact: true }).locator('..').locator('dd')).toContainText(/\d.*(?:밀리초|초)/)
      }
      const archive = page.getByRole('list', { name: '받아쓰기 기록', exact: true })
      await expect(archive.getByRole('listitem')).toHaveCount(count)
      await expect(archive.getByText(model, { exact: true })).toHaveCount(0)
      expect((await snapshot()).history.some(entry => 'diagnostics' in entry)).toBe(false)
      await page.getByRole('button', { name: '시작하기', exact: true }).click()
    }
    await start()
    await expect.poll(async () => (await metrics()).chunks).toBeGreaterThanOrEqual(2)
    expect((await snapshot()).state.phase).toBe('recording')
    expect(await metrics()).toMatchObject({ commits: 0, batch: [] })
    await heardAudio()
    await stop()
    await expectHistory('copy', [cleaned])
    expect(await metrics()).toMatchObject({ commits: 1, connections: 1, closed: 1, batch: [], cleanup: 1 })

    await overlay.getByRole('button', { name: '표시창 닫기' }).click()
    await expectDiagnostics('gpt-live-transcribe', '실시간 전사', 1)
    await app.evaluate(() => { Reflect.get(globalThis, 'siteVoiceTestRealtime').failNext = true })
    await start()
    await expect.poll(async () => (await metrics()).closed).toBe(2)
    await heardAudio()
    await stop()
    await expectHistory('copy', [cleaned, cleaned])
    expect(await metrics()).toMatchObject({ commits: 1, connections: 2, batch: ['gpt-transcribe'], cleanup: 2 })

    await overlay.getByRole('button', { name: '표시창 닫기' }).click()
    await expectDiagnostics('gpt-transcribe', '실시간 전사 실패 후 파일로 전사', 2)
    const chunksBeforeCancel = (await metrics()).chunks
    await start()
    await expect.poll(async () => (await metrics()).chunks).toBeGreaterThan(chunksBeforeCancel)
    await overlay.getByRole('button', { name: '취소' }).click()
    await expectHistory('cancelled', [cleaned, cleaned])
    expect(await metrics()).toMatchObject({ commits: 1, connections: 3, closed: 3, batch: ['gpt-transcribe'], cleanup: 2 })

    await app.close()
    app = await electron.launch({ args })
    await expect.poll(() => app.windows().some(findPage())).toBe(true)
    const reopened = app.windows().find(findPage())!
    await reopened.getByRole('button', { name: '결과', exact: true }).click()
    await expect(reopened.getByRole('list', { name: '받아쓰기 기록', exact: true }).getByRole('listitem')).toHaveCount(2)
    await expect(reopened.getByText('최근 받아쓰기 진단', { exact: true })).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    await rm(profile, { recursive: true, force: true })
  }
})
