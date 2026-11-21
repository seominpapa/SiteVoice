import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ShortcutStatus } from '../shared.ts'

type TerminalStatus = Exclude<ShortcutStatus, 'idle'>
type Listener = {
  process: ChildProcessWithoutNullStreams
  result: Promise<ShortcutStatus>
  settle: (status: ShortcutStatus) => void
}
function readStatus(value: string): TerminalStatus | undefined {
  if (value === 'READY') return 'ready'
  if (value === 'PERMISSION') return 'permission'
  if (value === 'UNAVAILABLE') return 'unavailable'
}
export function createPrimaryShortcut(root: string, fire: () => void) {
  const supported = process.platform === 'darwin' || process.platform === 'win32'
  const bin = join(root, process.platform + '-' + process.arch, process.platform === 'win32' ? 'voice-target.exe' : 'voice-target')
  let status: ShortcutStatus = 'idle'
  let listener: Listener | undefined

  function dispose(next: ShortcutStatus) {
    status = next
    if (!listener) return
    const active = listener
    listener = undefined
    active.settle(next)
    active.process.stdin.end()
    setTimeout(() => active.process.kill(), 900).unref()
  }
  function start(): Promise<ShortcutStatus> {
    if (listener) return listener.result
    if (!supported) return Promise.resolve(status = 'unavailable')
    status = 'idle'
    const proc = spawn(bin, ['--shortcut'], { windowsHide: true, stdio: 'pipe' })
    const { promise, resolve } = Promise.withResolvers<ShortcutStatus>()
    const timer = setTimeout(() => dispose('unavailable'), 2200)
    listener = { process: proc, result: promise, settle: value => { clearTimeout(timer); resolve(value) } }
    const lost = () => { if (listener?.process === proc) dispose('unavailable') }
    proc.on('error', lost)
    proc.on('close', lost)
    proc.stdin.on('error', lost)
    proc.stderr.resume()
    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', line => {
      if (listener?.process !== proc) return
      if (line === 'TRIGGER' && status === 'ready') { fire(); return }
      const ready = readStatus(line)
      if (ready === 'ready') {
        if (status === 'idle') listener.settle(status = 'ready')
      } else if (ready) dispose(ready)
    })
    return promise
  }
  return {
    start,
    get status() { return status },
    stop: () => dispose('idle'),
    requestPermission: () => new Promise<ShortcutStatus>(resolve => {
      if (process.platform !== 'darwin') { resolve('unavailable'); return }
      execFile(bin, ['--request-shortcut-permission'], {
        timeout: 7000, windowsHide: true, maxBuffer: 256, encoding: 'utf8',
      }, (error, output) => resolve(error ? 'unavailable' : readStatus(output.trim()) ?? 'unavailable'))
    })
  }
}
