export type View = 'dashboard' | 'overlay'
type Sender = { url: string; isMain: boolean; sender: number }

export function trustedView(frame: Sender, page: string, dashboard?: number, overlay?: number): View | null {
  if (!frame.isMain) return null
  if (frame.sender === dashboard && frame.url === page) return 'dashboard'
  if (frame.sender === overlay && frame.url === page + '#overlay') return 'overlay'
  return null
}

export function parseKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 520 || !/^sk-[A-Za-z0-9_-]{16,509}$/.test(value.trim())) {
    throw new Error('입력한 OpenAI API 키 형식을 확인해 주세요.')
  }
  return value.trim()
}

export function parseId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('작업 번호가 올바르지 않습니다.')
  return value
}

const reasons = ['permission', 'target', 'changed', 'clipboard', 'input', 'invalid', 'unsupported', 'unavailable'] as const
export type NativeReason = typeof reasons[number]
export type NativeReply = { ok: true; warning?: 'clipboard' } | { ok: false; reason: NativeReason }

export function nativeReply(line: string): NativeReply {
  if (line.length < 200) {
    try {
      const result = JSON.parse(line)
      if (result?.ok === true) return result.warning === 'clipboard' ? { ok: true, warning: 'clipboard' } : { ok: true }
      if (result?.ok === false && reasons.includes(result.reason)) return { ok: false, reason: result.reason }
    } catch { /* Invalid native output: fall back to copy. */ }
  }
  return { ok: false, reason: 'unavailable' }
}
