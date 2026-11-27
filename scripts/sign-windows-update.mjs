import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { installerName, manifestName, maxInstallerSize, validVersion, windowsUpdateKey } from '../src/main/windows-updates.ts'

const [version, file, keyFile] = process.argv.slice(2)
if (!validVersion(version) || !file || basename(file) !== installerName(version) || !keyFile) {
  throw new Error('Usage: node scripts/sign-windows-update.mjs <version> <installer.exe> <private-key-file>')
}
const key = createPrivateKey(await readFile(keyFile))
if (createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== windowsUpdateKey)
  throw new Error('The signing key does not match the Windows update key built into SiteVoice')
const { size } = await stat(file)
if (!size || size > maxInstallerSize) throw new Error('Invalid installer size')
const digest = createHash('sha256')
let bytes = 0
for await (const chunk of createReadStream(file)) {
  bytes += chunk.length
  if (bytes > size) throw new Error('Installer changed while signing')
  digest.update(chunk)
}
if (bytes !== size) throw new Error('Installer changed while signing')
const sha256 = digest.digest('hex')
const payload = Buffer.from(JSON.stringify({ version, name: basename(file), size, sha256 }))
const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }
await writeFile(join(dirname(file), manifestName), JSON.stringify(envelope) + '\n', { flag: 'wx' })
console.log(`${basename(file)}: SHA-256 ${sha256}`)
