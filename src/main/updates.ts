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

type Options = {
  isPackaged: boolean
  resourcesPath: string
  platform?: NodeJS.Platform
  canInterrupt(): boolean
  confirm(version: string): Promise<boolean>
  load?(): UpdateDriver
}

export function hasSupportedFeed(isPackaged: boolean, resourcesPath: string, platform = process.platform) {
  if (!isPackaged || platform !== 'darwin') return false
  try {
    const path = join(resourcesPath, 'app-update.yml')
    if (statSync(path).size > 4096) return false
    const config = readFileSync(path, 'utf8')
    // Accept the format written by electron-builder for our generic provider only.
    if (!/^provider: generic\r?$/m.test(config)) return false
    const url = new URL(config.match(/^url: (https:\/\/\S+)\r?$/m)?.[1] ?? '')
    return !url.username && !url.password && !url.search && !url.hash && url.hostname.includes('.')
  } catch {
    return false
  }
}

function productionDriver(): UpdateDriver {
  const require = createRequire(import.meta.url)
  const { autoUpdater } = require('electron-updater') as { autoUpdater: AppUpdater }
  const { autoUpdater: nativeUpdater } = require('electron') as { autoUpdater: typeof NativeUpdater }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null
  return {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
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
  const available = hasSupportedFeed(isPackaged, resourcesPath, platform)
  const inUse = '진행 중인 작업이 끝난 뒤 업데이트를 다시 확인해 주세요.'
  let busy = false
  let driver: UpdateDriver | undefined

  return {
    available,
    get busy() { return busy },
    async check() {
      if (!available) return '이 빌드는 자동 업데이트를 지원하지 않습니다.'
      if (busy || !canInterrupt()) return inUse
      busy = true
      let phase = '확인'
      try {
        driver ??= load()
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
      } catch {
        return `업데이트 ${phase}에 실패했습니다. 잠시 뒤 다시 확인해 주세요.`
      } finally {
        busy = false
      }
    }
  }
}
