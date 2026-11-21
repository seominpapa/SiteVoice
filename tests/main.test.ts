import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { trustedView, parseKey, parseId, nativeReply } from '../src/main/boundary.ts'
import { createVault } from '../src/main/vault.ts'

test('IPC accepts only the exact expected main frame and least privileged view', () => {
  const page = 'file:///VoiceInput/index.html'
  const main = { url: page, isMain: true, sender: 8 }
  assert.equal(trustedView(main, page, 8, 9), 'dashboard')
  assert.equal(trustedView({ ...main, url: page + '#overlay', sender: 9 }, page, 8, 9), 'overlay')
  assert.equal(trustedView({ ...main, url: page + '#overlay' }, page, 8, 9), null)
  assert.equal(trustedView({ ...main, isMain: false }, page, 8, 9), null)
  assert.equal(trustedView({ ...main, url: page + '?external' }, page, 8, 9), null)
  assert.equal(trustedView({ ...main, url: 'https://example.org/' }, page, 8, 9), null)
})
test('credentials and task identifiers have bounded valid inputs', () => {
  assert.equal(parseKey('  sk-local-testing-987654321  '), 'sk-local-testing-987654321')
  for (const bad of [undefined, {}, 'sk-abc', 'sk-012345678901234\nsecond-line', 'sk-' + 'a'.repeat(600)]) {
    assert.throws(() => parseKey(bad), /API 키/)
  }
  for (const bad of [0, -3, 1.2, '1', NaN, Infinity]) assert.throws(() => parseId(bad))
  assert.equal(parseId(27), 27)
})
test('native success requires explicit supported JSON; failure does not expose unknown helper text', () => {
  assert.deepEqual(nativeReply('{"ok":true}'), { ok: true })
  assert.deepEqual(nativeReply('{"ok":true,"warning":"clipboard"}'), { ok: true, warning: 'clipboard' })
  assert.deepEqual(nativeReply('{"ok":false,"reason":"changed"}'), { ok: false, reason: 'changed' })
  for (const bad of ['not json', '{"ok":"true"}', '{}', 'false', '{"ok":false,"reason":"ignored"}']) {
    assert.deepEqual(nativeReply(bad), { ok: false, reason: 'unavailable' })
  }
})
test('vault persists encrypted bytes across process instances and deletes them on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voiceinput-vault-'))
  try {
    const key = 'sk-local-testing-987654321'
    const codec = {
      available: async () => true,
      encrypt: async (text: string) => Buffer.from(text).map(x => x ^ 0x35),
      decrypt: async (value: Buffer) => Buffer.from(value).map(x => x ^ 0x35).toString()
    }
    const first = createVault(dir, codec)
    assert.equal(await first.read(), undefined)
    await first.save(key)
    assert.ok(!(await readFile(first.path)).includes(key))
    const second = createVault(dir, codec)
    assert.equal(await second.read(), key)
    await second.delete()
    assert.equal(await first.read(), undefined)
    assert.deepEqual(await readdir(dir), [])
    const unavailable = createVault(dir, { ...codec, available: async () => false })
    await assert.rejects(unavailable.save(key), /보호/)
    await writeFile(first.path, Buffer.alloc(8193))
    await assert.rejects(first.read(), /읽을 수/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
