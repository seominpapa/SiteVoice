import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const [editorExe, helperExe, expectation] = process.argv.slice(2)
assert.equal(process.platform, 'win32', 'The paste probe requires an interactive Windows desktop')
assert.ok(editorExe && helperExe, 'Usage: node native/probe-win-paste.mjs <editor.exe> <voice-target.exe>')

function connect(path, args = []) {
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.pipe(process.stderr, { end: false })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const exit = once(child, 'close').catch(error => [null, error.message])
  child.stdin.on('error', () => {})
  let pending
  const queued = []
  lines.on('line', line => {
    if (!pending) {
      queued.push(line)
      return
    }
    const { resolve, reject, timer } = pending
    pending = undefined
    clearTimeout(timer)
    try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
  })
  async function receive(command) {
    assert.ok(!pending, 'Only one command may be in flight')
    if (queued.length) {
      assert.equal(command, undefined, `Unexpected response from ${path}`)
      return JSON.parse(queued.shift())
    }
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined
        reject(new Error(`${path} did not respond to ${command ?? 'startup'}`))
      }, 6500)
      timer.unref()
      pending = { resolve, reject, timer }
    })
    if (command !== undefined) child.stdin.write(`${command}\n`)
    try {
      return await Promise.race([response, exit.then(([code, signal]) => {
        throw new Error(`${path} exited during ${command ?? 'startup'} (${code ?? signal})`)
      })])
    } finally {
      clearTimeout(pending?.timer)
      pending = undefined
    }
  }
  async function stop() {
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2500)
    timer.unref()
    try { await exit } finally { clearTimeout(timer) }
  }
  return { receive, stop }
}

const originalText = 'before [] after'
const sample = 'SiteVoice 붙여넣기 테스트'
const expectedText = `before [${sample}] after`
const editor = connect(editorExe, ['--isolated-clipboard'])
let helper
const results = []
try {
  const ready = await editor.receive()
  assert.equal(ready.ready, true, `Editor setup failed: ${JSON.stringify(ready)}`)
  console.log(JSON.stringify({ editorReady: ready }))
  helper = connect(helperExe)
  for (const condition of ['PLAIN', 'CHROME', 'PLAIN']) {
    const fixture = await editor.receive(condition)
    assert.equal(fixture.ok, true, `Could not seed ${condition}: ${JSON.stringify(fixture)}`)
    const before = await editor.receive('READ')
    assert.deepEqual(before, { ok: true, text: originalText, original: true, sourceUrl: condition === 'CHROME' })
    const snapshot = await helper.receive('SNAPSHOT')
    const paste = snapshot.ok ? await helper.receive(`PASTE ${Buffer.from(sample).toString('base64')}`) : null
    const after = await editor.receive('READ')
    assert.equal(after.ok, true, `Could not inspect ${condition}: ${JSON.stringify(after)}`)
    const row = { condition, snapshot, paste, inserted: after.text === expectedText, after }
    console.log(JSON.stringify(row))
    results.push(row)
  }
} finally {
  await Promise.all([helper?.stop(), editor.stop()])
}

const [first, chrome, last] = results
const baselinePassed = [first, last].every(row => row.snapshot.ok && row.paste?.ok && row.inserted && row.after.original)
if (baselinePassed && chrome.snapshot.ok && chrome.paste?.reason === 'clipboard' &&
    chrome.after.text === originalText && chrome.after.original && chrome.after.sourceUrl) {
  assert.notEqual(expectation, '--expect-fixed', 'The Chromium paste failure still occurs')
  console.log('REPRODUCED: Windows accepted the same editor and pasted with plain text, but declined with Chromium source URL metadata.')
} else if (baselinePassed && chrome.snapshot.ok && chrome.paste?.ok && chrome.inserted && chrome.after.original && chrome.after.sourceUrl) {
  console.log('NOT REPRODUCED: Both conditions inserted text and preserved the original clipboard.')
} else {
  throw new Error('INCONCLUSIVE: inspect snapshots, helper replies and the actual text/clipboard in the rows above.')
}
