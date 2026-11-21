import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_SETTINGS } from '../src/core/validation.ts'
import { createPreferences } from '../src/main/preferences.ts'

test('uses the light theme by default and migrates existing settings without losing saved terms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voiceinput-appearance-'))
  try {
    const prefs = createPreferences(dir)
    const initial = await prefs.read()
    assert.equal(initial.theme, 'light')
    assert.equal(initial.autoUpdate, true)
    const legacy = { ...DEFAULT_SETTINGS, terms: ['SiteCAD', '흙막이\u2028공법', '옹벽\u2029검토'], microphoneId: 'desk-mic' }
    const settings = { ...legacy, terms: [
      { term: 'SiteCAD', meaning: '' }, { term: '흙막이 공법', meaning: '' }, { term: '옹벽 검토', meaning: '' }
    ] }
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(legacy))
    assert.deepEqual(await prefs.read(), { settings, theme: 'light', autoUpdate: true })
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(legacy))
    await writeFile(file, JSON.stringify({ ...legacy, theme: 'unexpected' }))
    assert.deepEqual(await prefs.read(), { settings, theme: 'light', autoUpdate: true })
    await prefs.write(settings, 'dark', false)
    assert.deepEqual(await createPreferences(dir).read(), { settings, theme: 'dark', autoUpdate: false })
    const withMeaning = {
      ...settings, terms: [{ term: 'SiteCAD', meaning: '도면 검토 앱' }, ...settings.terms.slice(1)]
    }
    await prefs.write(withMeaning, 'dark', false)
    assert.deepEqual(await createPreferences(dir).read(), { settings: withMeaning, theme: 'dark', autoUpdate: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
