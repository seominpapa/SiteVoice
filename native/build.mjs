import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = dirname(fileURLToPath(import.meta.url))
const arch = process.argv[2] ?? process.arch
const platform = process.platform
if ((platform === 'darwin' && !['arm64', 'x64'].includes(arch)) ||
    (platform === 'win32' && arch !== 'x64') || !['darwin', 'win32'].includes(platform)) {
  throw new Error(`Unsupported native build: ${platform}-${arch}`)
}
const folder = resolve(source, 'bin', `${platform}-${arch}`)
mkdirSync(folder, { recursive: true })
const options = { cwd: folder, stdio: 'inherit', windowsHide: true }
if (platform === 'darwin') {
  // The Xcode 27 Apple Silicon SDK no longer ships the older Intel Swift compatibility libraries.
  const target = arch === 'x64' ? 'x86_64-apple-macos14' : 'arm64-apple-macos12'
  const cache = resolve(source, 'bin', 'swift-cache', arch)
  execFileSync('xcrun', ['swiftc', '-O', '-target', target, '-module-cache-path',
    cache, resolve(source, 'mac.swift'), '-o', 'voice-target'], options)
} else {
  if (process.env.VSCMD_ARG_TGT_ARCH?.toLowerCase() !== 'x64') {
    throw new Error('Run the Windows build from an x64 Visual Studio Developer Command Prompt.')
  }
  execFileSync('cl.exe', ['/nologo', '/std:c++17', '/O2', '/MT', '/EHsc', '/W4', '/utf-8', '/DUNICODE', '/D_UNICODE',
    resolve(source, 'win.cpp'), '/link', '/OUT:voice-target.exe', 'User32.lib', 'Gdi32.lib', 'Ole32.lib', 'OleAut32.lib',
    'Uiautomationcore.lib', 'Crypt32.lib', 'Advapi32.lib'], options)
}
