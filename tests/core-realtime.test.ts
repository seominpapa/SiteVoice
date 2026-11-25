import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveTranscription } from '../src/core/realtime.ts'
import { LIVE_TRANSCRIPTION_MODEL, MAX_LIVE_CHUNK_BYTES } from '../src/shared.ts'

const endpoint = 'wss://api.openai.com/v1/realtime?intent=transcription'
const fakeKey = 'test-key-never-sent'
const terms = [
  { term: 'SiteCAD', meaning: '민감한 사전 설명' }, { term: '흙막이', meaning: '' },
  { term: '<현장>', meaning: '' }, { term: '잘못\n저장된 힌트', meaning: '' },
]

class FakeSocket extends EventTarget {
  sent: Record<string, any>[] = []
  closeCount = 0
  bufferedAmount = 0

  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.closeCount++ }
  open() { this.dispatchEvent(new Event('open')) }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
  ack(turnDetection: null | object = null) {
    this.message({
      type: 'session.updated', session: {
        type: 'transcription', audio: { input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: LIVE_TRANSCRIPTION_MODEL },
          turn_detection: turnDetection,
        } },
      },
    })
  }
  committed(id = 'item-1') { this.message({ type: 'input_audio_buffer.committed', item_id: id }) }
  complete(transcript: string, id = 'item-1') {
    this.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript })
  }
}
function fixture() {
  const socket = new FakeSocket()
  const controller = new AbortController()
  let observed: [url: string, key: string] | undefined
  const live = createLiveTranscription(fakeKey, terms, controller.signal, (url, key) => {
    observed = [url, key]
    return socket
  })
  assert.deepEqual(observed, [endpoint, fakeKey])
  return { socket, controller, live }
}

test('waits for compatible session acknowledgment before transmitting; commits once and ignores deltas', async () => {
  const { socket, live } = fixture()
  const a = Uint8Array.from([1, 2]).buffer
  const b = new Uint8Array(4800)
  b.set([3, 4])
  live.append(a)
  socket.open()
  live.append(b.buffer)
  const result = live.finish()
  assert.equal(live.finish(), result)
  assert.equal(socket.sent.length, 1)
  const update = socket.sent[0]!
  assert.equal(update.type, 'session.update')
  assert.equal(update.session.type, 'transcription')
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 })
  assert.equal(update.session.audio.input.turn_detection, null)
  assert.equal(update.session.audio.input.transcription.model, LIVE_TRANSCRIPTION_MODEL)
  assert.deepEqual(update.session.audio.input.transcription.languages, ['ko', 'en'])
  assert.deepEqual(update.session.audio.input.transcription.keywords, ['SiteCAD', '흙막이'])
  assert.equal(update.session.audio.input.transcription.delay, 'medium')
  assert.doesNotMatch(JSON.stringify(update), /민감한|test-key/)
  socket.message({ type: 'session.created' })
  assert.equal(socket.sent.length, 1)
  socket.ack()
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'input_audio_buffer.append', audio: 'AQI=' },
    { type: 'input_audio_buffer.append', audio: Buffer.from(b).toString('base64') },
    { type: 'input_audio_buffer.commit' },
  ])
  live.append(a)
  socket.committed()
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: '부분 응답' })
  socket.complete('다른 녹음', 'item-2')
  assert.equal(socket.closeCount, 0)
  socket.complete(' SiteCAD 도면을 검토해요. ')
  assert.equal(await result, 'SiteCAD 도면을 검토해요.')
  assert.equal(socket.closeCount, 1)
})

test('handles a final event received before the commit acknowledgment, using only the committed item', async () => {
  const { socket, live } = fixture()
  socket.open()
  socket.ack()
  live.append(new ArrayBuffer(9600))
  socket.complete('종료 전에 도착한 응답')
  const result = live.finish()
  socket.complete('다른 녹음', 'other')
  socket.complete('최종 전사')
  assert.equal(socket.closeCount, 0)
  socket.committed()
  assert.equal(await result, '최종 전사')
})

test('the compatible session can omit fixed PCM rate and disabled turn detection', async () => {
  const { socket, live } = fixture()
  socket.open()
  socket.message({ type: 'session.updated', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm' }, transcription: { model: LIVE_TRANSCRIPTION_MODEL },
  } } } })
  live.append(new ArrayBuffer(4800))
  const result = live.finish()
  assert.deepEqual(socket.sent.map(event => event.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit'])
  socket.committed()
  socket.complete('최종 결과')
  assert.equal(await result, '최종 결과')
})

test('early disconnect and provider errors are retained, and remote details are never exposed', async () => {
  const disconnected = fixture()
  disconnected.socket.dispatchEvent(new Event('close'))
  assert.equal(disconnected.socket.closeCount, 1)
  disconnected.live.append(new ArrayBuffer(9600))
  await assert.rejects(disconnected.live.finish(), /연결/)
  assert.deepEqual(disconnected.socket.sent, [])

  const rejected = fixture()
  rejected.socket.open()
  rejected.socket.message({ type: 'error', error: { message: 'private contents plus ' + fakeKey } })
  await assert.rejects(rejected.live.finish(), (error: Error) => {
    assert.match(error.message, /실시간 전사/)
    assert.doesNotMatch(error.message, /private|test-key/)
    return true
  })
})

test('aborts before or after commit, supports explicit cancel and ignores all late results', async () => {
  let connected = false
  const before = createLiveTranscription(fakeKey, [], AbortSignal.abort(), () => {
    connected = true
    return new FakeSocket()
  })
  assert.equal(connected, false)
  await assert.rejects(before.finish(), /취소/)

  const manual = fixture()
  manual.live.cancel()
  manual.socket.open()
  assert.equal(manual.socket.sent.length, 0)
  assert.equal(manual.socket.closeCount, 1)
  await assert.rejects(manual.live.finish(), /취소/)

  const { socket, live, controller } = fixture()
  socket.open()
  socket.ack()
  live.append(new ArrayBuffer(9600))
  const result = live.finish()
  controller.abort()
  socket.committed()
  socket.complete('취소된 전사')
  live.cancel()
  assert.equal(socket.closeCount, 1)
  await assert.rejects(result, /취소/)
})

test('a socket construction error remains eligible for file fallback, without sending audio', async () => {
  const live = createLiveTranscription(fakeKey, [], new AbortController().signal, () => {
    throw new Error('private handshake information')
  })
  live.append(new ArrayBuffer(9600))
  await assert.rejects(live.finish(), (error: Error) => {
    assert.match(error.message, /연결/)
    assert.doesNotMatch(error.message, /private/)
    return true
  })
})

test('resolves the WebSocket constructor at recording time and sends authorization only in the handshake', async (t) => {
  const constructor = t.mock.method(globalThis, 'WebSocket', function () { return new FakeSocket() })
  const live = createLiveTranscription(fakeKey, terms, new AbortController().signal)
  assert.deepEqual(constructor.mock.calls[0]?.arguments, [
    endpoint, { headers: { Authorization: 'Bearer ' + fakeKey } },
  ])
  live.cancel()
  await assert.rejects(live.finish(), /취소/)
})

test('rejects invalid or excessive audio, long pre-ack queues and swollen socket buffers', async () => {
  for (const size of [0, 13, MAX_LIVE_CHUNK_BYTES + 2]) {
    const { socket, live } = fixture()
    live.append(new ArrayBuffer(size))
    assert.equal(socket.closeCount, 1)
    await assert.rejects(live.finish(), /오디오/)
  }
  const queued = fixture()
  for (let n = 0; n < 12; n++) queued.live.append(new ArrayBuffer(MAX_LIVE_CHUNK_BYTES))
  assert.equal(queued.socket.closeCount, 1)
  await assert.rejects(queued.live.finish(), /전송/)
  const congested = fixture()
  congested.socket.open()
  congested.socket.ack()
  congested.socket.bufferedAmount = 8 * 1024 * 1024
  congested.live.append(new ArrayBuffer(9600))
  await assert.rejects(congested.live.finish(), /전송/)
})

test('rejects wrong session config, empty final text, empty input and failed transcription', async () => {
  const badSession = fixture()
  badSession.socket.open()
  badSession.socket.ack({ type: 'server_vad' })
  await assert.rejects(badSession.live.finish(), /설정/)
  const shortInput = fixture()
  shortInput.socket.open()
  shortInput.socket.ack()
  shortInput.live.append(new ArrayBuffer(4798))
  await assert.rejects(shortInput.live.finish(), /오디오/)
  assert.ok(!shortInput.socket.sent.some(event => event.type === 'input_audio_buffer.commit'))
  for (const text of [null, '   ', '\u0000']) {
    const { socket, live } = fixture()
    socket.open()
    socket.ack()
    live.append(new ArrayBuffer(9600))
    const result = live.finish()
    socket.committed()
    if (text !== null) socket.complete(text)
    else socket.message({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item-1' })
    await assert.rejects(result, /전사/)
  }
})

test('connection and final deadlines close the socket and reject the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const noAck = fixture()
  noAck.socket.open()
  t.mock.timers.tick(8000)
  assert.equal(noAck.socket.closeCount, 1)
  await assert.rejects(noAck.live.finish(), /시간/)
  const noFinal = fixture()
  noFinal.socket.open()
  noFinal.socket.ack()
  noFinal.live.append(new ArrayBuffer(9600))
  const result = noFinal.live.finish()
  t.mock.timers.tick(16_000)
  assert.equal(noFinal.socket.closeCount, 1)
  await assert.rejects(result, /시간/)
})
