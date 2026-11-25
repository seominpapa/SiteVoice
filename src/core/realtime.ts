import { LIVE_TRANSCRIPTION_MODEL, MAX_LIVE_CHUNK_BYTES, type GlossaryEntry } from '../shared.ts'
import { ServiceError } from './errors.ts'
import { MAX_RECORDING_MS, MAX_TEXT_LENGTH } from './validation.ts'

const endpoint = 'wss://api.openai.com/v1/realtime?intent=transcription'
const sampleRate = 24_000
const bytesPerSecond = sampleRate * 2
const minAudioBytes = bytesPerSecond / 10
const maxAudioBytes = bytesPerSecond * (MAX_RECORDING_MS / 1000 + 2)
const maxQueuedBytes = 512 * 1024
const maxQueuedChunks = 128
const maxSocketBytes = 1024 * 1024
const connectionTimeout = 8000
const finalTimeout = 16_000
const resultEventLimit = 8

type Socket = Pick<WebSocket, 'bufferedAmount' | 'send' | 'close'> & EventTarget
type Connect = (url: string, apiKey: string) => Socket
// Node's WebSocket constructor supports handshake headers; the DOM declaration does not.
type NodeWebSocketConstructor = new (
  url: string, options: { headers: { Authorization: string } }
) => Socket
const defaultConnect: Connect = (url, apiKey) => {
  const NodeWebSocket = globalThis.WebSocket as unknown as NodeWebSocketConstructor
  return new NodeWebSocket(url, { headers: { Authorization: 'Bearer ' + apiKey } })
}

type SessionAck = { type?: unknown; audio?: { input?: { format?: { type?: unknown; rate?: unknown };
  transcription?: { model?: unknown }; turn_detection?: unknown } } }
type ServerEvent = { type: string; session?: SessionAck; item_id?: unknown; content_index?: unknown; transcript?: unknown }
function serverEvent(event: Event): ServerEvent | undefined {
  const data = (event as MessageEvent).data
  if (typeof data !== 'string' || data.length > MAX_TEXT_LENGTH * 6 + 1024) return
  try {
    const value = JSON.parse(data)
    if (value && typeof value === 'object' && typeof value.type === 'string') return value
  } catch { /* Invalid wire messages cannot provide a transcript. */ }
}

function compatibleSession(session: SessionAck | undefined) {
  const input = session?.audio?.input
  const model = input?.transcription?.model
  return session?.type === 'transcription' && input?.format?.type === 'audio/pcm' &&
    (input.format.rate === undefined || input.format.rate === sampleRate) &&
    (input.turn_detection === undefined || input.turn_detection === null) && typeof model === 'string' &&
    (model === LIVE_TRANSCRIPTION_MODEL || model.startsWith(LIVE_TRANSCRIPTION_MODEL + '-'))
}

function validatedTranscript(value: unknown) {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) ? value.trim() : ''
}

export function createLiveTranscription(apiKey: string, terms: readonly GlossaryEntry[], signal: AbortSignal,
  connect: Connect = defaultConnect) {
  let stage: 'connecting' | 'configuring' | 'recording' | 'committed' | 'closed' = 'connecting'
  let socket: Socket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queued: string[] = []
  let queuedBytes = 0
  let totalBytes = 0
  let result: { text: string } | { error: ServiceError } | undefined
  let pending: ReturnType<typeof Promise.withResolvers<string>> | undefined
  let completion: Promise<string> | undefined
  let committedId: string | undefined
  const early = new Map<string, string>()
  const listeners = { open, message, error: disconnected, close: disconnected }

  function settle(value: NonNullable<typeof result>) {
    if (stage === 'closed') return
    stage = 'closed'
    result = value
    queued = []
    early.clear()
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    for (const [event, listener] of Object.entries(listeners)) socket?.removeEventListener(event, listener)
    try { socket?.close() } catch { /* Session is already retired. */ }
    socket = undefined
    if ('text' in value) pending?.resolve(value.text)
    else pending?.reject(value.error)
    pending = undefined
  }

  function fail(message: string) { settle({ error: new ServiceError('실시간 전사: ' + message) }) }
  function cancel() { fail('요청을 취소했습니다.') }
  function disconnected() { fail('연결이 끊겼습니다. 네트워크 연결을 확인해 주세요.') }
  function deadline(delay: number) {
    clearTimeout(timer)
    timer = setTimeout(() => fail('요청 시간이 초과되었습니다.'), delay)
    timer.unref()
  }
  function send(value: object) {
    try {
      socket!.send(JSON.stringify(value))
      return true
    } catch {
      disconnected()
      return false
    }
  }
  function sendAudio(audio: string) {
    if (socket!.bufferedAmount + audio.length > maxSocketBytes) {
      fail('오디오 전송이 지연되어 실시간 연결을 중단했습니다.')
      return false
    }
    return send({ type: 'input_audio_buffer.append', audio })
  }

  function open() {
    if (stage !== 'connecting') return
    stage = 'configuring'
    const keywords = terms.map(({ term }) => term).filter(term => !/[<>\p{Cc}\p{Cf}]/u.test(term))
    send({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: sampleRate },
        transcription: { model: LIVE_TRANSCRIPTION_MODEL, languages: ['ko', 'en'], keywords, delay: 'medium' },
        turn_detection: null,
      } } },
    })
  }

  function acknowledge(session: SessionAck | undefined) {
    if (stage !== 'configuring') return
    if (!compatibleSession(session)) {
      fail('OpenAI가 요청한 오디오 설정을 확인하지 못했습니다.')
      return
    }
    stage = 'recording'
    if (!completion) clearTimeout(timer)
    for (const audio of queued) if (!sendAudio(audio)) return
    queued = []
    queuedBytes = 0
    if (completion) commit()
  }

  function finishItem(text: string) {
    if (text) settle({ text })
    else fail('전사 결과가 비어 있거나 읽을 수 없습니다.')
  }
  function committed(id: string) {
    if (committedId && committedId !== id) {
      fail('한 녹음에 두 개 이상의 입력 응답이 도착했습니다.')
      return
    }
    committedId = id
    const text = early.get(id)
    early.clear()
    if (text !== undefined) finishItem(text)
  }

  function message(event: Event) {
    const value = serverEvent(event)
    if (!value) return
    if (value.type === 'error') return fail('OpenAI가 요청을 처리하지 못했습니다.')
    if (value.type === 'session.updated') return acknowledge(value.session)
    const id = value.item_id
    if (stage !== 'committed' || typeof id !== 'string' || !id || id.length > 256) return
    if (value.type === 'input_audio_buffer.committed') return committed(id)
    if (value.type !== 'conversation.item.input_audio_transcription.completed' &&
      value.type !== 'conversation.item.input_audio_transcription.failed') return
    const text = value.type.endsWith('.completed') && value.content_index === 0 ? validatedTranscript(value.transcript) : ''
    if (id === committedId) finishItem(text)
    else if (!committedId && early.size < resultEventLimit) early.set(id, text)
  }

  function append(bytes: ArrayBuffer) {
    if (stage === 'closed' || completion) return
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength % 2 ||
      bytes.byteLength > MAX_LIVE_CHUNK_BYTES || totalBytes + bytes.byteLength > maxAudioBytes) {
      fail('지원하지 않는 오디오 입력이거나 최대 녹음 길이를 초과했습니다.')
      return
    }
    totalBytes += bytes.byteLength
    const encoded = Buffer.from(bytes).toString('base64')
    if (stage === 'recording') sendAudio(encoded)
    else {
      if (queuedBytes + bytes.byteLength > maxQueuedBytes || queued.length >= maxQueuedChunks) {
        fail('오디오 전송을 시작하지 못했습니다.')
        return
      }
      queuedBytes += bytes.byteLength
      queued.push(encoded)
    }
  }

  function commit() {
    stage = 'committed'
    send({ type: 'input_audio_buffer.commit' })
  }
  function finish() {
    if (completion) return completion
    if (!result && totalBytes < minAudioBytes) fail('실시간 전사에 필요한 최소 오디오 길이보다 짧습니다.')
    if (result) {
      completion = 'text' in result ? Promise.resolve(result.text) : Promise.reject(result.error)
      return completion
    }
    pending = Promise.withResolvers<string>()
    completion = pending.promise
    deadline(finalTimeout)
    if (stage === 'recording') commit()
    return completion
  }

  if (signal.aborted) cancel()
  else {
    try {
      socket = connect(endpoint, apiKey)
      for (const [event, listener] of Object.entries(listeners)) socket.addEventListener(event, listener)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      else deadline(connectionTimeout)
    } catch { disconnected() }
  }
  return { append, finish, cancel }
}
