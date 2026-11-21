import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, validateSettings } from '../core/validation.ts'
import { migrateShortcut } from '../core/shortcuts.ts'
import type { Theme } from '../shared.ts'
import { codeIs, writeAtomic } from './vault.ts'

export function createPreferences(directory: string) {
  const path = join(directory, 'settings.json')
  return {
    async read() {
      try {
        const value = await readFile(path, 'utf8')
        if (value.length > 64 * 1024) throw new Error()
        const { theme, autoUpdate, shortcutVersion, ...settings } = JSON.parse(value)
        const terms: unknown = settings.terms
        const glossary = Array.isArray(terms)
          ? terms.map(entry => typeof entry === 'string'
            ? { term: entry.replace(/[\p{Zl}\p{Zp}]/gu, ' '), meaning: '' } : entry)
          : terms
        return {
          settings: validateSettings({
            ...settings, terms: glossary, shortcut: migrateShortcut(settings.shortcut, shortcutVersion, process.platform)
          }),
          theme: theme === 'dark' ? 'dark' as const : 'light' as const,
          autoUpdate: autoUpdate !== false
        }
      } catch (error) {
        return {
          settings: DEFAULT_SETTINGS,
          theme: 'light' as const,
          autoUpdate: true,
          message: codeIs(error, 'ENOENT') ? undefined : '설정 파일을 읽을 수 없어 기본값을 쓰고 있습니다.'
        }
      }
    },
    async write(value: ReturnType<typeof validateSettings>, theme: Theme, autoUpdate: boolean) {
      try { await writeAtomic(path, JSON.stringify({ ...value, theme, autoUpdate, shortcutVersion: 1 }, null, 2) + '\n') }
      catch { throw new Error('설정 파일에 저장할 수 없습니다.') }
    }
  }
}
