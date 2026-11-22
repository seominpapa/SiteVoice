import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL(`./bin/${process.platform}-${process.arch}/voice-target${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))

test('helper never dispatches without a valid, unconsumed target snapshot', () => {
  const result = spawnSync(helper, [], { input: 'PERMISSION\nRESET\nPASTE not-base64!\nPASTE 7ZWc6riA\nOTHER\n', encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const [permission, ...responses] = result.stdout.trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(typeof permission.ok, 'boolean')
  assert.deepEqual(responses, [{ ok: true }, { ok: false, reason: 'invalid' }, { ok: false, reason: 'changed' }, { ok: false, reason: 'invalid' }])
})

test('a newer clipboard owner wins; supported representations are preserved', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(execFileSync(helper, ['--test-pasteboard'], { encoding: 'utf8', timeout: 5000 }).trim(), 'ok')
})

test('macOS accepts a writable editor without AXEnabled and rejects unsafe targets', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(execFileSync(helper, ['--test-editor-target'], { encoding: 'utf8', timeout: 5000 }).trim(), 'ok')
})
