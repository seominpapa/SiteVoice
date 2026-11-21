import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHistory } from '../src/main/history.ts'

const codec = {
  available: async () => true,
  encrypt: async (text: string) => Buffer.from(text).map(byte => byte ^ 0x4b),
  decrypt: async (bytes: Buffer) => bytes.map(byte => byte ^ 0x4b).toString()
}

test('retains only encrypted dated results across instances and updates the same recording once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitevoice-history-'))
  try {
    const original = { id: randomUUID(), recordedAt: 1_700_000_000_000, text: '사용자에게 붙여넣을 문장.' }
    const next = { id: randomUUID(), recordedAt: original.recordedAt + 1000, text: '두 번째 결과.' }
    const revised = { ...original, text: '다시 정리한 문장.', reviewNote: '숫자나 단위를 확인해 주세요.' }
    const history = createHistory(directory, codec)
    assert.deepEqual(await history.read(), [])
    await history.save(original)
    await history.save(next)
    assert.deepEqual(await createHistory(directory, codec).read(), [next, original])
    await history.save(revised)
    assert.deepEqual(await createHistory(directory, codec).read(), [next, revised])
    const records = join(directory, 'history')
    assert.equal((await readdir(records)).length, 2)
    const bytes = await readFile(join(records, revised.id + '.enc'))
    assert.equal(bytes.includes(revised.text), false)
    assert.deepEqual(JSON.parse(await codec.decrypt(bytes)), revised)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retains readable results, reports damaged files and refuses invalid IDs or unencrypted writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sitevoice-history-'))
  try {
    const record = { id: randomUUID(), recordedAt: 1_700_000_000_000, text: '기존 기록.' }
    const history = createHistory(directory, codec)
    await history.save(record)
    const records = join(directory, 'history')
    await writeFile(join(records, randomUUID() + '.enc'), Buffer.from('broken'))
    await writeFile(join(records, randomUUID() + '.enc'), await codec.encrypt(JSON.stringify(record)))
    await writeFile(join(records, 'other.txt'), 'ignore')
    let warnings = 0
    assert.deepEqual(await history.read(() => ++warnings), [record])
    assert.equal(warnings, 1)
    await assert.rejects(history.save({ ...record, id: '../escape' }), /기록/)
    await assert.rejects(history.save({ ...record, recordedAt: Infinity }), /기록/)
    await assert.rejects(history.save({ ...record, text: 'a'.repeat(60_001) }), /기록/)
    await assert.rejects(history.save({ ...record, reviewNote: '첫 줄\n둘째 줄' }), /기록/)
    const unavailable = createHistory(directory, { ...codec, available: async () => false })
    await assert.rejects(unavailable.save({ ...record, text: '덮어쓰지 않습니다.' }), /보안 저장소/)
    await assert.rejects(unavailable.read(), /보안 저장소/)
    assert.deepEqual(await history.read(), [record])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
