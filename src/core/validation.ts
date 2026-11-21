import type { Settings } from '../shared.ts'
import { ServiceError } from './errors.ts'

export const DEFAULT_SETTINGS: Settings = {
  transcriptionModel: 'gpt-transcribe',
  cleanupModel: 'gpt-6-luna',
  shortcut: 'CommandOrControl+Shift+Space',
  microphoneId: '',
  terms: [],
}

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024
export const MAX_RECORDING_MS = 5 * 60 * 1000
export const MAX_TERMS = 64
export const MAX_TERM_LENGTH = 80
export const MAX_TEXT_LENGTH = 60_000
export type Audio = {
  bytes: ArrayBuffer
  mime: 'audio/webm' | 'audio/mp4'
  extension: 'webm' | 'mp4'
}

const modifiers = new Map(Object.entries({
  command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl',
  commandorcontrol: 'cmdctrl', cmdorctrl: 'cmdctrl',
  alt: 'alt', option: 'alt', altgr: 'altgr', shift: 'shift',
  super: 'super', meta: 'super',
}))
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/
const controlCharacter = /[\p{Cc}\p{Cf}]/u
const acceleratorKey = /^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|space|tab|enter|return|insert|delete|backspace|home|end|pageup|pagedown|up|down|left|right|num[0-9]|plus)$/i

export function validateSettings(input: unknown): Settings {
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
  const terms = value.terms
  if (!Array.isArray(terms) || terms.length > MAX_TERMS || terms.some(term =>
    typeof term !== 'string' || term.length > MAX_TERM_LENGTH || !term.trim() || controlCharacter.test(term))) {
    throw new ServiceError('용어는 줄바꿈 없이 항목당 80자, 총 64개까지 등록할 수 있습니다.')
  }
  const microphone = value.microphoneId
  if (typeof microphone !== 'string' || microphone.length > 256 || controlCharacter.test(microphone)) {
    throw new ServiceError('마이크를 다시 선택해 주세요.')
  }
  return {
    transcriptionModel: model(value.transcriptionModel),
    cleanupModel: model(value.cleanupModel),
    shortcut: validateShortcut(value.shortcut),
    microphoneId: microphone,
    terms: [...new Set(terms.map(term => term.trim().normalize('NFC')))],
  }
}

function validateShortcut(input: unknown) {
  const parts = typeof input === 'string' && input.length <= 80 ? input.trim().split('+') : []
  const key = parts.pop()
  const group = parts.map(part => modifiers.get(part.toLowerCase()))
  if (!key || !acceleratorKey.test(key) || !group.length || group.includes(undefined) ||
      group.every(part => part === 'shift') || new Set(group).size !== group.length ||
      (group.includes('cmdctrl') && (group.includes('cmd') || group.includes('ctrl')))) {
    throw new ServiceError('단축키 형식을 확인해 주세요. 예: CommandOrControl+Shift+Space')
  }
  return [...parts, key].join('+')
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
