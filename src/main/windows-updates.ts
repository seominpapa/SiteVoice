import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { UpdateDriver } from './updates.ts'

export const windowsUpdateKey = 'MCowBQYDK2VwAyEASus2PJLqSqHJ6etc1I8ONOxLBjgCpxCxPxSSvdBRGak='
export const manifestName = 'sitevoice-win-x64-update.json'
export const installerName = (version: string) => `SiteVoice-${version}-win-x64.exe`
export const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/.test(value)
export const maxInstallerSize = 256 * 1024 * 1024
export function launchWindowsUpdate(path: string, quit: () => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(path, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      quit()
      resolve()
    })
  })
}
const assetBase = 'https://github.com/seominpapa/SiteVoice/releases/download/'
const releaseList = 'https://api.github.com/repos/seominpapa/SiteVoice/releases?per_page=100'
const dirPrefix = 'sitevoice-update-'
type Manifest = { version: string; name: string; size: number; sha256: string }
type Request = (url: string, options: RequestInit) => Promise<Response>
type Options = { installed: string; root: string; publicKey?: KeyObject; request?: Request; launch(path: string): Promise<void> }

function isNewer(a: string, b: string) {
  const mine = a.split('.').map(Number)
  const theirs = b.split('.').map(Number)
  for (const i of [0, 1, 2]) if (mine[i] !== theirs[i]) return mine[i] > theirs[i]
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function candidateVersion(releases: unknown, installed: string) {
  if (!Array.isArray(releases)) throw new Error('Invalid release list')
  let newest = installed
  for (const entry of releases) {
    if (!isRecord(entry) || entry.draft !== false || entry.prerelease !== false || !Array.isArray(entry.assets)) continue
    const tag = entry.tag_name
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue
    const version = tag.slice(1)
    if (!validVersion(version) || !isNewer(version, newest)) continue
    const names = entry.assets.filter(isRecord).map(asset => asset.name)
    if (names.includes(manifestName) && names.includes(installerName(version))) newest = version
  }
  return newest === installed ? undefined : newest
}

function readManifest(raw: unknown, version: string, publicKey: KeyObject): Manifest {
  if (!isRecord(raw) || typeof raw.payload !== 'string' || typeof raw.signature !== 'string')
    throw new Error('Invalid update envelope')
  const payload = Buffer.from(raw.payload, 'base64')
  const signature = Buffer.from(raw.signature, 'base64')
  if (signature.length !== 64 || !verify(null, payload, publicKey, signature))
    throw new Error('Invalid update signature')
  const body: unknown = JSON.parse(payload.toString('utf8'))
  if (!isRecord(body) || body.version !== version || body.name !== installerName(version) ||
      typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size <= 0 || body.size > maxInstallerSize ||
      typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new Error('Invalid update manifest')
  return { version, name: body.name, size: body.size, sha256: body.sha256 }
}

async function responseFor(request: Request, input: string, signal: AbortSignal) {
  let url = new URL(input)
  for (let i = 0; i < 4; i++) {
    const reply = await request(url.href, { redirect: 'manual', signal, cache: 'no-store' })
    if (reply.ok && reply.body) return reply
    await reply.body?.cancel()
    const location = reply.headers.get('Location')
    if (reply.status < 300 || reply.status > 399 || !location) break
    url = new URL(location, url)
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname))
      break
  }
  throw new Error('Update request rejected')
}

async function* bounded(reply: Response, limit: number) {
  const reader = reply.body!.getReader()
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      size += value.byteLength
      if (size > limit) throw new Error('Update response too large')
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readJson(request: Request, url: string, max: number, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const bytes of bounded(await responseFor(request, url, signal), max)) chunks.push(Buffer.from(bytes))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function verifyInstaller(path: string, manifest: Manifest) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > manifest.size) throw new Error('Invalid installer size')
    hash.update(chunk)
  }
  if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Invalid installer digest')
}

async function removeOldDownloads(root: string) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^sitevoice-update-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
    const path = join(root, entry.name)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000)
      await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

export function createWindowsUpdateDriver({ installed, root, launch, request = fetch,
  publicKey = createPublicKey({ key: Buffer.from(windowsUpdateKey, 'base64'), format: 'der', type: 'spki' }) }: Options): UpdateDriver {
  if (!validVersion(installed)) throw new Error('Invalid installed version')
  let candidate: Manifest | undefined
  let download: { directory: string; path: string; manifest: Manifest } | undefined
  async function clearDownload() {
    const old = download
    download = undefined
    if (old) await rm(old.directory, { recursive: true, force: true }).catch(() => {})
  }
  return {
    async checkForUpdates() {
      candidate = undefined
      await clearDownload()
      const deadline = AbortSignal.timeout(8000)
      const version = candidateVersion(await readJson(request, releaseList, 8 * 1024 * 1024, deadline), installed)
      if (!version) return { isUpdateAvailable: false, updateInfo: { version: installed } }
      candidate = readManifest(await readJson(request, `${assetBase}v${version}/${manifestName}`, 16 * 1024, deadline), version, publicKey)
      return { isUpdateAvailable: true, updateInfo: { version } }
    },
    async downloadUpdate() {
      const manifest = candidate
      if (!manifest) throw new Error('No approved update')
      await clearDownload()
      await mkdir(root, { recursive: true, mode: 0o700 })
      await removeOldDownloads(root).catch(() => {})
      const directory = await mkdtemp(join(root, dirPrefix))
      const path = join(directory, manifest.name)
      try {
        const signal = AbortSignal.timeout(180_000)
        const reply = await responseFor(request, `${assetBase}v${manifest.version}/${manifest.name}`, signal)
        await pipeline(bounded(reply, manifest.size), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
        await verifyInstaller(path, manifest)
        download = { directory, path, manifest }
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    },
    async install() {
      if (!download) throw new Error('No verified installer')
      try {
        await verifyInstaller(download.path, download.manifest)
        await launch(download.path)
        download = undefined
        candidate = undefined
      } catch (error) {
        await clearDownload()
        throw error
      }
    }
  }
}
