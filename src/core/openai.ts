import OpenAI from 'openai'
import type { Settings } from '../shared.ts'
import { CLEANUP_PROMPT } from './cleanup-prompt.ts'
import { ServiceError } from './errors.ts'
import { MAX_TEXT_LENGTH, type Audio } from './validation.ts'

type Phase = '음성 전사' | '문장 정리' | '전사 모델 확인' | '문장 정리 모델 확인'

function providerError(phase: Phase, error: unknown): ServiceError {
  const message = (text: string) => new ServiceError(phase + ': ' + text)
  if (error instanceof ServiceError) return error
  if (error instanceof OpenAI.APIConnectionTimeoutError) return message('요청 시간이 초과되었습니다.')
  if (error instanceof OpenAI.APIConnectionError) return message('네트워크 연결을 확인해 주세요.')
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return message('API 키를 확인해 주세요.')
    if (error.status === 403 || error.status === 404 || error.code === 'model_not_found') {
      return message('설정한 모델에 접근할 수 없습니다. 모델 ID와 프로젝트 권한을 확인해 주세요.')
    }
    if (error.status === 429) {
      if (error.code === 'insufficient_quota' || error.code === 'billing_hard_limit_reached') {
        return message('OpenAI 잔액과 사용 한도를 확인해 주세요.')
      }
      return message('요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.')
    }
    if (error.status === 400 || error.status === 422) {
      return message('설정한 모델이 이 요청 형식을 지원하는지 확인해 주세요.')
    }
    if (error.status === 503 || error.status === 502 || error.status === 500) {
      return message('OpenAI 서버에 문제가 있습니다. 잠시 뒤 다시 시도해 주세요.')
    }
  }
  return message('요청에 실패했습니다. 잠시 뒤 다시 시도해 주세요.')
}

const cleanFormat = {
  type: 'json_schema',
  name: 'dictation_cleanup',
  strict: true,
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
} as const

function textValue(value: unknown) {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    return undefined
  }
  return value.trim() || undefined
}

function readCleanup(response: OpenAI.Responses.Response) {
  if (response.status === 'incomplete') {
    throw new ServiceError('문장 정리: 응답이 끝나기 전에 중단되었습니다.')
  }
  const messages = response.output?.filter(item => item.type === 'message') ?? []
  const message = messages[0]
  if (messages.some(item => item.content?.some(part => part.type === 'refusal'))) {
    throw new ServiceError('문장 정리: OpenAI가 응답을 거부했습니다.')
  }
  const part = message?.content?.[0]
  if (response.status === 'completed' && messages.length === 1 && message?.status === 'completed' &&
      message.role === 'assistant' && message.content.length === 1 && part?.type === 'output_text' &&
      typeof part.text === 'string' && part.text.length <= MAX_TEXT_LENGTH * 2) {
    try {
      const value: unknown = JSON.parse(part.text)
      if (value && typeof value === 'object' && Object.keys(value).join(',') === 'text' && 'text' in value) {
        const cleaned = textValue(value.text)
        if (cleaned) return cleaned
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  throw new ServiceError('문장 정리: 결과가 비어 있거나 형식이 올바르지 않습니다.')
}

export function createSpeechService(apiKey: string, request?: typeof fetch) {
  const client = new OpenAI({
    apiKey,
    adminAPIKey: null,
    baseURL: 'https://api.openai.com/v1',
    organization: null,
    project: null,
    defaultHeaders: { Authorization: 'Bearer ' + apiKey },
    logLevel: 'off',
    maxRetries: 0,
    timeout: 120_000,
    fetchOptions: { redirect: 'error' },
    ...(request ? { fetch: Object.assign((...args: Parameters<typeof fetch>) => request(...args), { Response }) } : {}),
  })

  async function transcribe(audio: Audio, settings: Settings, signal: AbortSignal) {
    try {
      const model = settings.transcriptionModel
      const common = { file: new File([audio.bytes], 'recording.' + audio.extension, { type: audio.mime }), model }
      const terms = settings.terms.map(entry => entry.term)
      // The API documents these multipart fields; the installed SDK types still omit them.
      const fields = /^gpt-transcribe(?:-|$)/.test(model)
        ? { ...common, languages: ['ko', 'en'], keywords: terms }
        : model === 'gpt-4o-transcribe-diarize'
          ? { ...common, chunking_strategy: 'auto' as const }
          : { ...common, prompt: terms.length ? '고유명사와 전문 용어: ' + terms.join(', ') : undefined }
      const response = await client.audio.transcriptions.create(fields, { signal })
      const text = textValue(response.text)
      if (!text) throw new ServiceError('음성 전사: 전사할 음성이 없거나 결과를 읽을 수 없습니다.')
      return text
    } catch (error) {
      throw providerError('음성 전사', error)
    }
  }

  async function clean(raw: string, settings: Settings, signal: AbortSignal) {
    try {
      const response = await client.responses.create({
        model: settings.cleanupModel,
        instructions: CLEANUP_PROMPT,
        input: JSON.stringify({ transcript: raw, glossary: settings.terms }),
        text: { format: cleanFormat },
        max_output_tokens: 12_000,
        store: false,
      }, { signal })
      return readCleanup(response)
    } catch (error) {
      throw providerError('문장 정리', error)
    }
  }

  async function verify(settings: Settings, signal?: AbortSignal) {
    const models = [[settings.transcriptionModel, '전사 모델 확인'], [settings.cleanupModel, '문장 정리 모델 확인']] as const
    for (const [id, phase] of models) {
      try {
        const result = await client.models.retrieve(id, { signal, timeout: 12_000 })
        if (result.id !== id) throw new ServiceError(phase + ': 설정한 모델을 확인할 수 없습니다.')
      } catch (error) {
        throw providerError(phase, error)
      }
    }
  }

  return { transcribe, clean, verify }
}
