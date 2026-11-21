import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('Mac Fn tap rejects chords, repeats, holds, interruptions and nonphysical events', { skip: process.platform !== 'darwin' }, () => {
  const helper = fileURLToPath(new URL(`./bin/darwin-${process.arch}/voice-target`, import.meta.url))
  const result = spawnSync(helper, ['--test-shortcut'], { encoding: 'utf8', timeout: 3_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'ok')
})
