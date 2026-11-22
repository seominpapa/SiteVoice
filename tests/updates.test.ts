import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configureUpdateFeed, createUpdateController, hasSupportedFeed, type UpdateDriver } from '../src/main/updates.ts'

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'voiceinput-updates-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const manifest = 'provider: generic\nurl: https://updates.example.com/mac/arm64/\nupdaterCacheDirName: voiceinput-updater\n'
const privateManifest = 'provider: github\nowner: seominpapa\nrepo: SiteVoice\nprivate: true\nupdaterCacheDirName: voiceinput-updater\n'
const update = { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }

test('does not load the updater in development or without HTTPS distribution metadata', async () => fixture(async dir => {
  let loaded = false
  const options = {
    resourcesPath: dir, platform: 'darwin' as const, canInterrupt: () => true, confirm: async () => true,
    load: () => { loaded = true; throw new Error('unexpected load') }
  }
  const unavailable = () => createUpdateController({ ...options, isPackaged: true })
  for (const value of [
    undefined,
    'provider: github\nurl: https://updates.example.com',
    manifest.replace('https:', 'http:'),
    manifest.replace('updates.example.com', 'token@updates.example.com'),
    manifest.replace('/mac/arm64/', '/mac/arm64/?token=secret'),
    manifest.replace('updates.example.com', 'localhost')
  ]) {
    if (value) await writeFile(join(dir, 'app-update.yml'), value)
    const controller = unavailable()
    assert.equal(controller.available, false)
    assert.match(await controller.check(), /지원하지/)
  }
  await writeFile(join(dir, 'app-update.yml'), manifest)
  assert.equal(createUpdateController({ ...options, isPackaged: false }).available, false)
  assert.equal(loaded, false)
}))

test('does not enable in-app updates on Windows or Linux', async () => fixture(async dir => {
  const file = join(dir, 'app-update.yml')
  await writeFile(file, manifest)
  assert.equal(hasSupportedFeed(true, dir, 'win32'), false)
  assert.equal(hasSupportedFeed(true, dir, 'linux'), false)
}))

test('only the packaged SiteVoice repository is accepted as a private GitHub feed', async () => fixture(async dir => {
  const file = join(dir, 'app-update.yml')
  await writeFile(file, privateManifest)
  assert.equal(hasSupportedFeed(true, dir, 'darwin'), true)
  for (const unsafe of [
    privateManifest.replace('seominpapa', 'unknown-owner'),
    privateManifest.replace('SiteVoice', 'other-project'),
    privateManifest.replace('private: true', 'private: false'),
    privateManifest.replace('voiceinput-updater', '../../elsewhere'),
    privateManifest + 'host: example.com\n',
    privateManifest + 'token: credentials\n',
    privateManifest + 'owner: unknown-owner\n'
  ]) {
    await writeFile(file, unsafe)
    assert.equal(hasSupportedFeed(true, dir, 'darwin'), false)
  }
}))

test('private GitHub uses local authentication before any request and keeps the install confirmation', async () => fixture(async dir => {
  await writeFile(join(dir, 'app-update.yml'), privateManifest)
  const events: Array<unknown> = []
  let localToken: string | null = null
  const updater = {
    disableDifferentialDownload: false,
    setFeedURL: (options: unknown) => { events.push(options) }
  }
  const controller = createUpdateController({
    resourcesPath: dir, platform: 'darwin', isPackaged: true, canInterrupt: () => true,
    confirm: async version => { events.push('prompt ' + version); return false },
    load: feed => ({
      checkForUpdates: async () => {
        await configureUpdateFeed(updater, feed, async () => localToken)
        events.push('check')
        return update
      },
      async downloadUpdate() { assert.fail('download without confirmation') },
      async install() { assert.fail('install without confirmation') }
    })
  })
  assert.match(await controller.check(), /gh auth login/)
  localToken = 'invalid credential\n'
  assert.match(await controller.check(), /gh auth login/)
  assert.deepEqual(events, [])
  localToken = 'test_token_sitevoice_local_only'
  assert.match(await controller.check(), /나중에/)
  assert.deepEqual(events, [{ provider: 'github', owner: 'seominpapa', repo: 'SiteVoice', token: localToken }, 'check', 'prompt 0.3.0'])
  assert.equal(updater.disableDifferentialDownload, true)
}))

test('only an approved newer version downloads and installs; overlapping calls cannot repeat it', async () => fixture(async dir => {
  await writeFile(join(dir, 'app-update.yml'), manifest)
  const events: string[] = []
  let candidate = false
  let reply = false
  let active = false
  const driver: UpdateDriver = {
    checkForUpdates: async () => {
      events.push('check')
      return candidate ? update : { ...update, isUpdateAvailable: false }
    },
    downloadUpdate: async () => { events.push('download') },
    install: async () => { events.push('install') }
  }
  const controller = createUpdateController({
    resourcesPath: dir, isPackaged: true, platform: 'darwin', canInterrupt: () => !active,
    confirm: async version => { events.push('prompt ' + version); return reply },
    load: () => driver
  })
  assert.equal(controller.available, true)
  assert.match(await controller.check(), /최신/)
  assert.deepEqual(events, ['check'])
  candidate = true
  assert.match(await controller.check(), /나중에/)
  assert.deepEqual(events, ['check', 'check', 'prompt 0.3.0'])
  reply = true
  active = true
  assert.match(await controller.check(), /진행 중/)
  active = false
  const pending = controller.check()
  assert.equal(controller.busy, true)
  assert.match(await controller.check(), /진행 중/)
  assert.match(await pending, /설치/)
  assert.deepEqual(events.slice(3), ['check', 'prompt 0.3.0', 'download', 'install'])
  assert.equal(controller.busy, false)
}))

test('hides upstream errors, skips install if work starts, and can retry after a failure', async () => fixture(async dir => {
  await writeFile(join(dir, 'app-update.yml'), manifest)
  let work = false
  let stage = 'check'
  let installed = false
  const driver: UpdateDriver = {
    checkForUpdates: async () => {
      if (stage === 'check') throw new Error('sensitive diagnostics')
      return update
    },
    async downloadUpdate() {
      if (stage === 'download') throw new Error('sensitive diagnostics')
      work = true
    },
    async install() { installed = true }
  }
  const controller = createUpdateController({
    resourcesPath: dir, isPackaged: true, platform: 'darwin', canInterrupt: () => !work,
    confirm: async () => true, load: () => driver
  })
  assert.match(await controller.check(), /^업데이트 확인에 실패/)
  stage = 'download'
  assert.match(await controller.check(), /^업데이트 다운로드에 실패/)
  stage = ''
  assert.match(await controller.check(), /진행 중/)
  assert.equal(installed, false)
  assert.equal(controller.busy, false)
}))
