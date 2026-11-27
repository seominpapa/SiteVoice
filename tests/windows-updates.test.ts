import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createWindowsUpdateDriver } from '../src/main/windows-updates.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const installer = Buffer.from('test installer bytes')
const release = (version: string) => ({
  tag_name: 'v' + version, draft: false, prerelease: false,
  assets: [{ name: 'sitevoice-win-x64-update.json' }, { name: `SiteVoice-${version}-win-x64.exe` }]
})
function envelope(version: string, changes: Record<string, unknown> = {}) {
  const payload = Buffer.from(JSON.stringify({
    version, name: `SiteVoice-${version}-win-x64.exe`,
    size: installer.length, sha256: createHash('sha256').update(installer).digest('hex'), ...changes
  }))
  return {
    payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64')
  }
}

async function scenario(run: (context: {
  requests: string[]
  launched: string[]
  replies: { releases: unknown, manifest: unknown, binary: Uint8Array, redirect?: string }
  driver: ReturnType<typeof createWindowsUpdateDriver>
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sitevoice-win-update-test-'))
  const requests: string[] = []
  const launched: string[] = []
  const replies = { releases: [release('0.2.12')], manifest: envelope('0.2.12'), binary: new Uint8Array(installer) } as
    { releases: unknown, manifest: unknown, binary: Uint8Array, redirect?: string }
  const driver = createWindowsUpdateDriver({
    installed: '0.2.11', root, publicKey,
    request: async url => {
      requests.push(url)
      if (url.startsWith('https://api.github.com/')) return Response.json(replies.releases)
      if (url.endsWith('.json')) return Response.json(replies.manifest)
      if (replies.redirect && url.endsWith('.exe')) return Response.redirect(replies.redirect, 302)
      return new Response(Uint8Array.from(replies.binary))
    },
    launch: async path => {
      assert.deepEqual(await readFile(path), installer)
      launched.push(basename(path))
    }
  })
  try { await run({ requests, launched, replies, driver }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('finds the newest compatible Windows release without using the Mac latest endpoint', () => scenario(async context => {
  context.replies.releases = [
    release('0.2.12'), release('0.2.9'), { ...release('1.0.0'), assets: [] },
    { ...release('1.1.0'), draft: true }, { ...release('1.2.0'), prerelease: true },
    release('0.3.0')
  ]
  context.replies.manifest = envelope('0.3.0')
  assert.deepEqual(await context.driver.checkForUpdates(), { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } })
  assert.equal(context.requests.length, 2)
  assert.match(context.requests[1], /\/v0\.3\.0\//)
  assert.deepEqual(context.launched, [])
  await context.driver.downloadUpdate()
  assert.deepEqual(context.launched, [])
  await context.driver.install()
  assert.deepEqual(context.launched, ['SiteVoice-0.3.0-win-x64.exe'])
  await assert.rejects(context.driver.install())
}))

test('refuses invalid manifest signatures, artifact identity and versions', () => scenario(async ({ driver, replies }) => {
  for (const bad of [
    { ...envelope('0.2.12'), signature: Buffer.alloc(64).toString('base64') },
    envelope('0.2.13'), envelope('0.2.12', { name: '../SiteVoice.exe' }),
    envelope('0.2.12', { size: 1e12 }), envelope('0.2.12', { sha256: 'unexpected' })
  ]) {
    replies.manifest = bad
    await assert.rejects(driver.checkForUpdates())
    await assert.rejects(driver.downloadUpdate())
    await assert.rejects(driver.install())
  }
}))

test('leaves Windows untouched for older versions, damaged bytes or an untrusted download redirect', () => scenario(async ({ driver, replies, launched, requests }) => {
  replies.releases = [release('0.2.10'), release('0.2.11')]
  assert.equal((await driver.checkForUpdates()).isUpdateAvailable, false)
  replies.releases = [release('0.2.12')]
  await driver.checkForUpdates()
  replies.binary = new Uint8Array(installer.length)
  await assert.rejects(driver.downloadUpdate())
  await assert.rejects(driver.install())
  replies.redirect = 'https://example.org/untrusted'
  await assert.rejects(driver.downloadUpdate())
  assert.ok(!requests.some(url => url.includes('example.org')))
  assert.deepEqual(launched, [])
}))
