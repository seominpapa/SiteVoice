import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Arch, Platform, build } from 'electron-builder'

const [platform, arch] = process.argv.slice(2)
if (!((platform === 'mac' && process.platform === 'darwin' && ['arm64', 'x64'].includes(arch))
      || (platform === 'win' && process.platform === 'win32' && arch === 'x64'))) {
  throw new Error('macOS 빌드는 Mac, Windows x64 빌드는 MSVC와 Windows SDK가 설치된 Windows에서 실행하세요.')
}
const developerId = process.env.VOICEINPUT_SIGNING === '1'
const configuredFeed = process.env.VOICEINPUT_UPDATE_URL
const githubUpdates = process.env.VOICEINPUT_GITHUB_UPDATES === '1'
const localUpdateTest = process.env.VOICEINPUT_LOCAL_UPDATE_TEST === '1'
if (githubUpdates && (configuredFeed || platform !== 'mac' || arch !== 'arm64')) {
  throw new Error('SiteVoice GitHub 업데이트 빌드는 별도 HTTPS 피드를 지정하지 않은 Apple Silicon용으로만 만드세요.')
}
if (localUpdateTest && !githubUpdates) throw new Error('로컬 업데이트 테스트는 SiteVoice GitHub 업데이트 빌드에만 적용됩니다.')
if (githubUpdates && !developerId) throw new Error('GitHub 업데이트 배포에는 VOICEINPUT_SIGNING=1이 필요합니다.')
if (githubUpdates && !localUpdateTest && !process.env.APPLE_KEYCHAIN_PROFILE) {
  throw new Error('GitHub 배포용 macOS 빌드에는 공증용 APPLE_KEYCHAIN_PROFILE 설정이 필요합니다.')
}
let updateUrl
if (configuredFeed) {
  if (platform !== 'mac') throw new Error('Windows에서는 앱 내 업데이트를 지원하지 않습니다. 일반 NSIS 설치 파일을 사용하세요.')
  let base
  try { base = new URL(configuredFeed) } catch { throw new Error('업데이트 서버는 HTTPS 주소여야 합니다.') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.hostname.includes('.')) {
    throw new Error('업데이트 서버는 인증 정보가 없는 HTTPS 주소여야 합니다.')
  }
  if (!developerId) throw new Error('업데이트 배포 빌드에는 VOICEINPUT_SIGNING=1 및 코드 서명이 필요합니다.')
  base.pathname = base.pathname.replace(/\/$/, '') + '/' + platform + '/' + arch + '/'
  updateUrl = base.href
}
const publication = githubUpdates
  ? { provider: 'github', owner: 'seominpapa', repo: 'SiteVoice', private: true }
  : updateUrl ? { provider: 'generic', url: updateUrl } : null
const output = githubUpdates
  ? `release/${localUpdateTest ? 'github-local-test' : 'github'}/mac-${arch}`
  : updateUrl ? `release/update/${platform}-${arch}` : 'release'
let verifiedMacSignature = false
// npm invokes this script with its own environment. No shell interpolation or publisher.
execFileSync(process.execPath, ['native/build.mjs', arch], { stdio: 'inherit' })
execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { stdio: 'inherit' })
if (platform === 'mac' && !developerId) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  delete process.env.CSC_LINK
  delete process.env.CSC_KEY_PASSWORD
}
await build({
  targets: (platform === 'mac' ? Platform.MAC : Platform.WINDOWS)
    .createTarget(platform === 'mac' ? publication ? ['dmg', 'zip'] : ['dmg'] : ['nsis'], Arch[arch]),
  publish: 'never',
  config: {
    appId: 'com.voiceinput.desktop',
    asar: true,
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    },
    directories: { output, buildResources: 'build' },
    forceCodeSigning: Boolean(publication),
    ...(publication ? {
      afterSign({ appOutDir, packager }) {
        const app = join(appOutDir, packager.appInfo.productFilename + '.app')
        const developerRequirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
        const requirement = githubUpdates ? developerRequirement + ' and certificate leaf[subject.OU] = "6564NK7Q97"' : developerRequirement
        execFileSync('codesign', ['--verify', '--strict', `-R=${requirement}`, app])
        if (githubUpdates && !localUpdateTest) execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' })
        verifiedMacSignature = true
      }
    } : {}),
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    files: ['dist/**/*', 'package.json'],
    extraResources: [
      { from: 'native/bin/' + process.platform + '-' + arch, to: 'targets/' + process.platform + '-' + arch, filter: ['voice-target', 'voice-target.exe'] },
      { from: 'build', to: 'build', filter: ['tray*.png'] }
    ],
    publish: publication,
    npmRebuild: false,
    mac: {
      category: 'public.app-category.productivity',
      icon: 'build/icon.png',
      identity: developerId ? undefined : '-',
      hardenedRuntime: developerId,
      notarize: developerId && !localUpdateTest,
      minimumSystemVersion: arch === 'x64' ? '14.0' : '13.0',
      binaries: ['Contents/Resources/targets/darwin-' + arch + '/voice-target'],
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      extendInfo: { NSMicrophoneUsageDescription: '말한 내용을 문장으로 입력하기 위해 마이크를 사용합니다.' }
    },
    win: { icon: 'build/icon.png', requestedExecutionLevel: 'asInvoker' },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true }
  }
})
if (publication && !verifiedMacSignature) {
  throw new Error('업데이트용 앱의 Developer ID Application 서명을 확인하지 못했습니다.')
}
