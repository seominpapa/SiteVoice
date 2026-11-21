import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { nativeReply, type NativeReply } from './boundary.ts'

const unavailable: NativeReply = { ok: false, reason: 'unavailable' }
export function createTargetClient(root: string) {
  const supported = process.platform === 'darwin' || process.platform === 'win32'
  const bin = join(root, process.platform + '-' + process.arch, process.platform === 'win32' ? 'voice-target.exe' : 'voice-target')
  let child: ChildProcessWithoutNullStreams | undefined
  let finish: ((value: NativeReply) => void) | undefined
  let queue = Promise.resolve()
  let pending = 0
  let closing = false

  function retire(proc: ChildProcessWithoutNullStreams) {
    if (child !== proc) return
    child = undefined
    finish?.(unavailable)
    proc.stdin.end()
    setTimeout(() => proc.kill(), 1500).unref()
  }
  async function send(command: string, signal?: AbortSignal, timeout = 6500): Promise<NativeReply> {
    if (!supported || closing || signal?.aborted) return unavailable
    if (!child) {
      const proc = spawn(bin, { windowsHide: true, stdio: 'pipe' })
      child = proc
      createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', line => {
        if (child === proc) finish?.(nativeReply(line))
      })
      proc.stderr.resume()
      proc.on('error', () => retire(proc))
      proc.on('close', () => retire(proc))
      proc.stdin.on('error', () => retire(proc))
    }
    const proc = child
    return new Promise(resolve => {
      const timer = setTimeout(() => retire(proc), timeout)
      finish = result => {
        clearTimeout(timer)
        finish = undefined
        resolve(result)
      }
      proc.stdin.write(command + '\n')
    })
  }

  function request(command: string, signal?: AbortSignal, interactive = false) {
    // A queued focus snapshot could capture a field the user switched to after the shortcut.
    if (interactive && (pending || !child)) {
      if (!child && !pending) void request('PERMISSION')
      return Promise.resolve(unavailable)
    }
    pending++
    const response = interactive ? send(command, signal, 800) : queue.then(() => send(command, signal))
    queue = response.catch(() => unavailable).then(() => { pending-- })
    return response.catch(() => unavailable)
  }
  return {
    permission: () => request('PERMISSION'),
    requestPermission: () => request('REQUEST_PERMISSION'),
    snapshot: () => request('SNAPSHOT', undefined, true),
    paste: (text: string, signal: AbortSignal) => Buffer.byteLength(text) <= 512 * 1024
      ? request('PASTE ' + Buffer.from(text).toString('base64'), signal)
      : Promise.resolve<NativeReply>({ ok: false, reason: 'invalid' }),
    reset: () => request('RESET'),
    close: () => {
      closing = true
      child?.stdin.end()
    }
  }
}
