import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { createPrimaryShortcut } from '../src/main/native-shortcut.ts'

test('forwards only a ready helper’s native activation and stops it when disabled', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sitevoice-shortcut-'))
  const folder = join(dir, process.platform + '-' + process.arch)
  let hits = 0
  const listener = createPrimaryShortcut(dir, () => ++hits)
  try {
    await mkdir(folder)
    await writeFile(join(folder, 'voice-target'), '#!' + process.execPath + '\n' +
      'if (process.argv[2] === "--request-shortcut-permission") console.log("PERMISSION");\n' +
      'else { console.log("TRIGGER\\nREADY\\nkey-not-forwarded\\nTRIGGER"); process.stdin.resume(); }\n', { mode: 0o700 })
    assert.equal(listener.status, 'idle')
    assert.equal(await listener.requestPermission(), 'permission')
    assert.deepEqual(await Promise.all([listener.start(), listener.start()]), ['ready', 'ready'])
    for (let i = 0; i < 30 && hits === 0; i++) await setTimeout(10)
    assert.equal(hits, 1)
    assert.equal(listener.status, 'ready')
    listener.stop()
    assert.equal(listener.status, 'idle')
  } finally {
    listener.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
