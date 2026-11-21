import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseKey } from './boundary.ts'

type Codec = {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}
export function codeIs(error: unknown, code: string) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}
export async function writeAtomic(path: string, bytes: Buffer | string) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
export function createVault(directory: string, codec: Codec) {
  const path = join(directory, 'key.enc')
  return {
    path,
    async read() {
      try {
        const bytes = await readFile(path)
        if (bytes.length > 8192 || !(await codec.available())) throw new Error()
        return parseKey(await codec.decrypt(bytes))
      } catch (error) {
        if (codeIs(error, 'ENOENT')) return undefined
        throw new Error('저장된 키를 읽을 수 없습니다. OS 보안 저장소를 확인하거나 키를 다시 등록해 주세요.')
      }
    },
    async save(value: string) {
      const key = parseKey(value)
      if (!(await codec.available())) throw new Error('이 환경에서는 OS 보안 저장소로 키를 보호할 수 없습니다.')
      try {
        const bytes = await codec.encrypt(key)
        if (!bytes.length || bytes.length > 8192) throw new Error()
        await writeAtomic(path, bytes)
      } catch {
        throw new Error('키를 보안 저장소에 저장할 수 없습니다.')
      }
    },
    async delete() {
      try { await rm(path, { force: true }) }
      catch { throw new Error('저장한 키를 삭제할 수 없습니다.') }
    }
  }
}
