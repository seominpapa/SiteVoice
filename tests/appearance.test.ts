import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const settings = { ...DEFAULT_SETTINGS, terms: ['SiteCAD'], microphoneId: 'desk-mic' }
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(settings))
    assert.deepEqual(await prefs.read(), { settings, theme: 'light', autoUpdate: true })
    await writeFile(file, JSON.stringify({ ...settings, theme: 'unexpected' }))
    assert.deepEqual(await prefs.read(), { settings, theme: 'light', autoUpdate: true })
    await prefs.write(settings, 'dark', false)
    assert.deepEqual(await createPreferences(dir).read(), { settings, theme: 'dark', autoUpdate: false })
    await prefs.write({ ...settings, terms: ['흙막이'] }, 'dark', false)
    assert.deepEqual(await createPreferences(dir).read(), { settings: { ...settings, terms: ['흙막이'] }, theme: 'dark', autoUpdate: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
