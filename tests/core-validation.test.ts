import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, MAX_AUDIO_BYTES, validateAudio, validateSettings } from '../src/core/validation.ts'
import { meaningConcern } from '../src/core/meaning.ts'

test('settings validate every IPC field and normalize the dictionary', () => {
  const terms = [
    { term: ' SiteCAD ', meaning: ' ' },
    { term: '흙막이', meaning: ' 흙이 무너지지 않게 지지하는 구조물 ' },
    { term: 'SiteCAD', meaning: '도면 검토 앱' },
    { term: '숏크리트'.normalize('NFD'), meaning: '뿜어 붙이는 콘크리트'.normalize('NFD') },
  ]
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, terms }).terms, [
    { term: 'SiteCAD', meaning: '도면 검토 앱' },
    { term: '흙막이', meaning: '흙이 무너지지 않게 지지하는 구조물' },
    { term: '숏크리트', meaning: '뿜어 붙이는 콘크리트' },
  ])
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, terms: [
    { term: 'SiteCAD', meaning: '도면 검토 앱' },
    { term: 'SiteCAD', meaning: '별개의 용어' },
  ] }), /서로 다른 뜻/)
  assert.throws(() => validateSettings(null))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, transcriptionModel: '../models' }))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, cleanupModel: 'https://model-id' }))
  for (const bad of [
    [3], ['SiteCAD'], [{ term: 'SiteCAD' }], [{ term: ' ', meaning: '도면 검토 앱' }],
    [{ term: '현장\nA', meaning: '' }], [{ term: '현장', meaning: '설명\u2028줄 바꿈' }],
    [{ term: '현장', meaning: '설명\nbreak' }], [{ term: '현장', meaning: '가'.repeat(301) }],
    [{ term: '가'.repeat(81), meaning: '' }], [{ term: '현장', meaning: 3 }],
    [{ term: '현장', meaning: '공사 현장', extra: true }], Array(65).fill({ term: '현장', meaning: '' }),
  ]) assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, terms: bad }), /용어/)
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, microphoneId: false }))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, shortcut: 'Shift+S' }))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, shortcut: 'Ctrl+Control+Space' }))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, shortcut: 'Control+Enter+Space' }))
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, debug: true }))
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, shortcut: ' CommandOrControl+Alt+F8 ' }).shortcut,
    'CommandOrControl+Alt+F8')
})

test('audio IPC is bounded and permits only the expected formats with container headers', () => {
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]).buffer
  const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]).buffer
  assert.equal(validateAudio(webm, 'audio/webm;codecs=opus').extension, 'webm')
  assert.equal(validateAudio(mp4, 'audio/mp4').extension, 'mp4')
  assert.throws(() => validateAudio(Buffer.from(webm), 'audio/webm'))
  assert.throws(() => validateAudio(webm, 'video/webm'))
  assert.throws(() => validateAudio(webm, 'audio/mp4'))
  assert.throws(() => validateAudio(new ArrayBuffer(0), 'audio/webm'))
  assert.throws(() => validateAudio(new ArrayBuffer(MAX_AUDIO_BYTES + 1), 'audio/webm'))
})

test('meaning guard tolerates equivalent notation and repeated quantity but catches certain risky edits', () => {
  assert.equal(meaningConcern('오후 세 시에 SiteCAD로 봐요.', '오후 3시에 SiteCAD로 봐요.'), undefined)
  assert.equal(meaningConcern('3.50 미터, 다시 3.5미터로요.', '3.5 m로요.'), undefined)
  assert.equal(meaningConcern('삼 점 오 미터입니다.', '3.5미터입니다.'), undefined)
  assert.equal(meaningConcern('1,000 원이에요.', '1000원이에요.'), undefined)
  assert.equal(meaningConcern('SiteCAD와 흙막이, 숏크리트예요.', 'SiteCAD, 흙막이와 숏크리트예요.'), undefined)
  assert.equal(meaningConcern('하지 마세요. 하지 마세요.', '작업하지 마세요.'), undefined)
  for (const [a, b] of [
    ['3.5미터', '35미터'], ['3m', '3km'], ['5m', '5cm'], ['3억원', '3만원'],
    ['3달러', '3원'], ['-2.5m', '2.5m'], ['작업하지 마세요.', '작업하세요.'],
    ['do not send this', 'send this'], ['보고해요.', '보고하지 마세요.'],
  ]) assert.ok(meaningConcern(a, b), a + ' -> ' + b)
})
