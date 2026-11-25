import { LIVE_TRANSCRIPTION_MODEL, MAX_TERMS, MAX_TERM_LENGTH, MAX_TERM_MEANING_LENGTH, type GlossaryEntry, type Settings } from '../shared.ts'
import { ServiceError } from './errors.ts'
import { defaultShortcut, validateShortcut } from './shortcuts.ts'

export const DEFAULT_SETTINGS: Settings = {
  transcriptionModel: LIVE_TRANSCRIPTION_MODEL,
  cleanupModel: 'gpt-6-luna',
  shortcut: defaultShortcut(process.platform),
  microphoneId: '',
  terms: [],
}

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024
export const MAX_RECORDING_MS = 5 * 60 * 1000
export const MAX_TEXT_LENGTH = 60_000
export type Audio = {
  bytes: ArrayBuffer
  mime: 'audio/webm' | 'audio/mp4'
  extension: 'webm' | 'mp4'
}

const modelId = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/
const controlCharacter = /[\p{Cc}\p{Cf}]/u
const glossaryBreak = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
function glossaryText(value: unknown, limit: number) {
  if (typeof value !== 'string' || value.length > limit || glossaryBreak.test(value)) return undefined
  const text = value.trim().normalize('NFC')
  return text.length <= limit ? text : undefined
}

function validateGlossary(value: unknown): GlossaryEntry[] {
  const error = '용어는 80자, 뜻·사용 맥락은 300자 이내로 줄바꿈 없이 최대 64개까지 등록할 수 있습니다.'
  if (!Array.isArray(value) || value.length > MAX_TERMS) throw new ServiceError(error)
  const glossary = new Map<string, GlossaryEntry>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'meaning,term') {
      throw new ServiceError(error)
    }
    const term = glossaryText(entry.term, MAX_TERM_LENGTH)
    const meaning = glossaryText(entry.meaning, MAX_TERM_MEANING_LENGTH)
    if (!term || meaning === undefined) throw new ServiceError(error)
    const existing = glossary.get(term)
    if (existing?.meaning && meaning && existing.meaning !== meaning) {
      throw new ServiceError('같은 용어에 서로 다른 뜻이 있습니다. 하나로 합쳐 주세요.')
    }
    if (!existing?.meaning) glossary.set(term, { term, meaning })
  }
  return [...glossary.values()]
}

export function validateSettings(input: unknown, platform: string = process.platform): Settings {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'cleanupModel,microphoneId,shortcut,terms,transcriptionModel') {
    throw new ServiceError('저장할 설정 형식을 확인해 주세요.')
  }
  const value = input as Record<string, unknown>
  const model = (candidate: unknown) => {
    if (typeof candidate !== 'string' || candidate.length > 128 || !modelId.test(candidate.trim())) {
      throw new ServiceError('OpenAI 모델 ID를 확인해 주세요.')
    }
    return candidate.trim()
  }
  const microphone = value.microphoneId
  if (typeof microphone !== 'string' || microphone.length > 256 || controlCharacter.test(microphone)) {
    throw new ServiceError('마이크를 다시 선택해 주세요.')
  }
  return {
    transcriptionModel: model(value.transcriptionModel),
    cleanupModel: model(value.cleanupModel),
    shortcut: validateShortcut(value.shortcut, platform),
    microphoneId: microphone,
    terms: validateGlossary(value.terms),
  }
}

export function validateAudio(bytes: unknown, mime: unknown): Audio {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 8) {
    throw new ServiceError('녹음된 음성을 읽을 수 없습니다.')
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new ServiceError('녹음이 너무 큽니다. 짧게 다시 녹음해 주세요.')
  const type = typeof mime === 'string' && mime.length <= 100 ? mime.toLowerCase().split(';')[0]?.trim() : ''
  const header = new DataView(bytes)
  if (type === 'audio/webm' && header.getUint32(0) === 0x1a45dfa3) {
    return { bytes, mime: type, extension: 'webm' }
  }
  if (type === 'audio/mp4' && header.getUint32(4) === 0x66747970) {
    return { bytes, mime: type, extension: 'mp4' }
  }
  throw new ServiceError('녹음 파일 형식을 지원하지 않습니다. 다시 녹음해 주세요.')
}
