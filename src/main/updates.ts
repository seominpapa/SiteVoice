import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { autoUpdater as NativeUpdater } from 'electron'

export type UpdateDriver = {
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  install(): Promise<void>
}

const siteVoiceFeed = { provider: 'github', owner: 'seominpapa', repo: 'SiteVoice' } as const
type UpdateFeed = { provider: 'generic'; url: string } | typeof siteVoiceFeed

type Options = {
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  canInterrupt(): boolean
  confirm(version: string): Promise<boolean>
  load?(feed: UpdateFeed): UpdateDriver
}

function readSupportedFeed(isPackaged: boolean, resourcesPath: string, platform = process.platform): UpdateFeed | null {
  if (!isPackaged || platform !== 'darwin') return null
  try {
    const path = join(resourcesPath, 'app-update.yml')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 4096) return null
    const fields = new Map<string, string>()
    // electron-builder writes a flat map of plain scalar values for these feeds.
    for (const line of readFileSync(path, 'utf8').trimEnd().split(/\r?\n/)) {
      const match = /^([A-Za-z]+): (\S+)$/.exec(line)
      if (!match || fields.has(match[1])) return null
      fields.set(match[1], match[2])
    }
    const cacheDir = fields.get('updaterCacheDirName')
    if (cacheDir && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(cacheDir)) return null
    const keys = [...fields.keys()].filter(key => key !== 'updaterCacheDirName')
    if (fields.get('provider') === 'github' && keys.length === 4 && fields.get('private') === 'true' &&
      fields.get('owner') === siteVoiceFeed.owner && fields.get('repo') === siteVoiceFeed.repo) return siteVoiceFeed
    if (fields.get('provider') !== 'generic' || keys.length !== 2) return null
    const url = new URL(fields.get('url') ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.')) return null
    return { provider: 'generic', url: url.href }
  } catch {
    return null
  }
}

export function hasSupportedFeed(isPackaged: boolean, resourcesPath: string, platform = process.platform) {
  return readSupportedFeed(isPackaged, resourcesPath, platform) !== null
}

class GitHubLoginRequired extends Error {}

async function readLocalGitHubToken(): Promise<string | null> {
  // Finder does not include Homebrew's directories in PATH. Use only fixed executable paths.
  for (const command of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    const token = await new Promise<string | null>(resolve => {
      execFile(command, ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
        env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_PROMPT_DISABLED: '1' }
      }, (error, stdout) => resolve(error ? null : stdout.trim()))
    })
    if (token) return token
  }
  return null
}

export async function configureUpdateFeed(
  updater: Pick<AppUpdater, 'setFeedURL' | 'disableDifferentialDownload'>,
  feed: UpdateFeed,
  readToken = readLocalGitHubToken
) {
  if (feed.provider === 'generic') {
    updater.setFeedURL(feed)
    return
  }
  const token = await readToken()
  if (!token || token.length > 1024 || /[^A-Za-z0-9_]/.test(token)) throw new GitHubLoginRequired()
  // The private provider uses numeric GitHub asset URLs, not paths that support blockmap lookup.
  updater.disableDifferentialDownload = true
  // Supplying the token explicitly selects the private provider without consulting process.env.
  updater.setFeedURL({ ...feed, token })
}

function productionDriver(feed: UpdateFeed): UpdateDriver {
  const require = createRequire(import.meta.url)
  const { autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater }
  const { autoUpdater: nativeUpdater } = require('electron') as { autoUpdater: typeof NativeUpdater }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null
  return {
    async checkForUpdates() {
      await configureUpdateFeed(autoUpdater, feed)
      return autoUpdater.checkForUpdates()
    },
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    install: () => new Promise<void>((resolve, reject) => {
      function cleanup() {
        nativeUpdater.removeListener('before-quit-for-update', finish)
        autoUpdater.removeListener('error', fail)
      }
      function finish() { cleanup(); resolve() }
      function fail() { cleanup(); reject(new Error('Update installation failed')) }
      nativeUpdater.once('before-quit-for-update', finish)
      autoUpdater.once('error', fail)
      try { autoUpdater.quitAndInstall() } catch { fail() }
    })
  }
}

export function createUpdateController({ isPackaged, resourcesPath, platform, canInterrupt, confirm, load = productionDriver }: Options) {
  const feed = readSupportedFeed(isPackaged, resourcesPath, platform)
  const inUse = '진행 중인 작업이 끝난 뒤 업데이트를 다시 확인해 주세요.'
  let busy = false
  let driver: UpdateDriver | undefined

  return {
    available: feed !== null,
    get busy() { return busy },
    async check() {
      if (!feed) return '이 빌드는 자동 업데이트를 지원하지 않습니다.'
      if (busy || !canInterrupt()) return inUse
      busy = true
      let phase = '확인'
      try {
        driver ??= load(feed)
        const result = await driver.checkForUpdates()
        if (!result) throw new Error()
        if (!result.isUpdateAvailable) return '최신 버전을 사용 중입니다.'
        const version = result.updateInfo.version
        if (typeof version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(version)) throw new Error()
        if (!canInterrupt()) return inUse
        if (!await confirm(version)) return '업데이트를 나중에 설치합니다.'
        if (!canInterrupt()) return inUse
        phase = '다운로드'
        await driver.downloadUpdate()
        if (!canInterrupt()) return inUse
        phase = '설치'
        await driver.install()
        return '업데이트 설치를 시작합니다.'
      } catch (error) {
        if (error instanceof GitHubLoginRequired) return '업데이트를 받으려면 터미널에서 gh auth login으로 GitHub에 로그인해 주세요.'
        return `업데이트 ${phase}에 실패했습니다. 잠시 뒤 다시 확인해 주세요.`
      } finally {
        busy = false
      }
    }
  }
}
