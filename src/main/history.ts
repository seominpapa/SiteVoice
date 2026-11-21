import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_TEXT_LENGTH } from '../core/validation.ts'
import type { HistoryEntry } from '../shared.ts'
import { codeIs, writeAtomic } from './vault.ts'

type Codec = {
  available(): Promise<boolean>
  encrypt(text: string): Promise<Buffer>
  decrypt(bytes: Buffer): Promise<string>
}

const maxEncryptedBytes = 512 * 1024
const maxJsonLength = MAX_TEXT_LENGTH * 6 + 2048
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const recordName = /^([0-9a-f-]{36})\.enc$/
const disallowedText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u

export function validateHistoryEntry(input: unknown): HistoryEntry {
  const invalid = '받아쓴 기록 형식이 올바르지 않습니다.'
  if (!input || typeof input !== 'object') throw new Error(invalid)
  const { id, recordedAt, text, reviewNote } = input as Record<string, unknown>
  if (typeof id !== 'string' || !idPattern.test(id) || typeof recordedAt !== 'number' ||
      !Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt > 8_640_000_000_000_000 ||
      typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH || disallowedText.test(text) ||
      (reviewNote !== undefined && (typeof reviewNote !== 'string' || reviewNote.length > 180 || /[\p{Cc}\p{Cf}]/u.test(reviewNote)))) {
    throw new Error(invalid)
  }
  return reviewNote ? { id, recordedAt, text, reviewNote } : { id, recordedAt, text }
}

export function createHistory(directory: string, codec: Codec) {
  const folder = join(directory, 'history')
  const pathFor = (id: string) => join(folder, id + '.enc')

  async function requireCodec() {
    if (!(await codec.available().catch(() => false))) {
      throw new Error('OS 보안 저장소를 사용할 수 없어 받아쓴 기록을 열거나 저장할 수 없습니다.')
    }
  }

  async function load(id: string) {
    const file = await open(pathFor(id), 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > maxEncryptedBytes) throw new Error()
      const bytes = await file.readFile()
      if (bytes.length < 1 || bytes.length > maxEncryptedBytes) throw new Error()
      const json = await codec.decrypt(bytes)
      if (json.length > maxJsonLength) throw new Error()
      const entry = validateHistoryEntry(JSON.parse(json))
      if (entry.id !== id) throw new Error()
      return entry
    } finally {
      await file.close()
    }
  }

  return {
    async read(onUnreadable?: () => void): Promise<HistoryEntry[]> {
      let names: string[]
      try {
        if (!(await lstat(folder)).isDirectory()) throw new Error()
        names = (await readdir(folder, { withFileTypes: true })).flatMap(file => {
          const id = file.isFile() ? recordName.exec(file.name)?.[1] : undefined
          return id && idPattern.test(id) ? [id] : []
        })
      } catch (error) {
        if (codeIs(error, 'ENOENT')) return []
        throw new Error('받아쓴 기록 폴더를 읽을 수 없습니다.')
      }
      if (!names.length) return []
      await requireCodec()
      const entries: HistoryEntry[] = []
      let unreadable = false
      for (const id of names) {
        try { entries.push(await load(id)) }
        catch { unreadable = true }
      }
      if (unreadable) onUnreadable?.()
      return entries.sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id))
    },
    async save(value: HistoryEntry): Promise<void> {
      const entry = validateHistoryEntry(value)
      await requireCodec()
      try {
        await mkdir(folder, { mode: 0o700, recursive: true })
        if (!(await lstat(folder)).isDirectory()) throw new Error()
        const bytes = await codec.encrypt(JSON.stringify(entry))
        if (!bytes.length || bytes.length > maxEncryptedBytes) throw new Error()
        await writeAtomic(pathFor(entry.id), bytes)
      } catch {
        throw new Error('받아쓴 기록을 저장할 수 없습니다.')
      }
    }
  }
}
