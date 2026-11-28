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

test('the number guard treats a consecutive list as formatting without losing quantities inside items', () => {
  assert.equal(meaningConcern(
    '두 가지 기능을 하는 앱을 만들고 싶어. 잘 듣고 잘 말하고',
    '2가지 기능을 하는 앱을 만들고 싶어.\n1. 잘 듣고\n2. 잘 말하고'
  ), undefined)
  assert.equal(meaningConcern(
    '도면을 2장 검토하고 결과를 공유해요.',
    '할 일\n1. 도면을 2장 검토해요.\n2. 결과를 공유해요.'
  ), undefined)
  assert.equal(meaningConcern(
    '첫 번째, 깊이 3.5m를 확인해요. 두 번째, 비용 3만원을 검토해요.',
    '1. 깊이 3.5m를 확인해요.\n2. 비용 3만원을 검토해요.'
  ), undefined)
  assert.equal(meaningConcern(
    '할 일:\n1. 도면을 확인해요.\n2. 사진과 자료를 정리해요.',
    '1. 도면을 확인해요.\n2. 사진과 자료를 정리해요.'
  ), undefined)
  for (const [raw, cleaned] of [
    ['두 가지 기능을 하는 앱을 만들고 싶어. 잘 듣고 잘 말하고', '기능을 하는 앱을 만들고 싶어.\n1. 잘 듣고\n2. 잘 말하고'],
    ['깊이 3.5m를 확인해요.', '1. 깊이 35m를 확인해요.\n2. 기록해요.'],
    ['도면을 검토하고 결과를 공유해요.', '1. 도면을 검토해요.\n3. 결과를 공유해요.'],
    ['도면을 검토하고 결과를 공유해요.', '1. 도면을 검토하고 결과를 공유해요.'],
    ['도면을 검토하고 결과를 공유해요.', '1.5m 도면을 검토해요.\n2. 결과를 공유해요.'],
    ['두 번째 도면을 검토하고 세 번째 도면은 남겨요.', '1. 도면을 검토해요.\n2. 도면을 남겨요.'],
  ]) assert.ok(meaningConcern(raw, cleaned), raw + ' -> ' + cleaned)
})

test('uses the last quantity or polarity in a clear same-item correction', () => {
  for (const [raw, cleaned] of [
    ['철근 50개, 아니 15개 주문해 줘.', '철근 15개 주문해 줘.'],
    ['철근 50개. 아니, 15개 주문해 줘.', '철근 15개 주문해 줘.'],
    ['도면 5장, 아니요. 3장만 보내 주세요.', '도면 3장만 보내 주세요.'],
    ['3m, 아니 2m를 굴착해요.', '2m를 굴착해요.'],
    ['깊이 3.50미터, 아니 삼 점 오오 미터로 해 주세요.', '깊이 3.55m로 해 주세요.'],
    ['길이는 3m, 아니 30cm야.', '길이는 30cm야.'],
    ['굴착 깊이는 3m입니다. 정정할게요. 굴착 깊이는 2m입니다.', '굴착 깊이는 2m입니다.'],
    ['철근 50개 아니 30개, 아니 15개 주문해 줘.', '철근 15개 주문해 줘.'],
    ['벽은 2m입니다. 깊이는 2m, 아니 3m예요.', '벽은 2m이고 깊이는 3m예요.'],
    ['보내지 마세요. 그게 아니고 보내 주세요.', '보내 주세요.'],
    ['도면을 보내 주세요. 정정할게요. 도면을 보내지 마세요.', '도면을 보내지 마세요.'],
    ['도면은 보내지 마세요. 아니, 도면은 보내 주세요. 사진은 공유하지 마세요.', '도면은 보내 주세요. 사진은 공유하지 마세요.'],
    ['도면을 포함하지 마세요. 아니, 도면을 포함해 주세요.', '도면을 포함해 주세요.'],
    ['도면을 보내지 않겠습니다. 정정할게요. 도면을 보내겠습니다.', '도면을 보내겠습니다.'],
    ['보내지 마세요. 아니 보내 주세요. 정정할게요. 보내지 마세요.', '보내지 마세요.'],
  ]) assert.equal(meaningConcern(raw, cleaned), undefined, raw + ' -> ' + cleaned)
})

test('keeps review when a correction is ambiguous or the output changed the final intent', () => {
  for (const [raw, cleaned] of [
    ['깊이는 3m, 아니 2m로 해요.', '깊이는 20m로 해요.'],
    ['깊이는 3m, 아니 2m로 해요.', '깊이는 2cm로 해요.'],
    ['깊이는 3m, 아니 2m로 해요.', '깊이는 3m와 2m로 해요.'],
    ['깊이는 3m, 아니 2m고 길이는 4m예요.', '깊이는 2m고 길이는 5m예요.'],
    ['벽은 2m입니다. 깊이는 2m, 아니 3m예요.', '깊이는 3m예요.'],
    ['철근 50개, 아니 15개 주문. 볼트 5개 주문.', '철근 5개 주문. 볼트 15개 주문.'],
    ['철근 50개, 아니 15개 주문. 볼트 15개 주문.', '볼트 15개 주문.'],
    ['철근은 50개였어요. 아니, 철근은 15개였어요.', '볼트는 15개였어요.'],
    ['가로 철근 50개, 아니 15개 주문해 줘.', '세로 철근 15개 주문해 줘.'],
    ['3m, 아니 2m를 굴착해요.', '높이는 2m입니다.'],
    ['굴착 깊이는 3m. 아니, 2m 간격으로 표식을 설치해 주세요.', '2m 간격으로 표식을 설치해 주세요.'],
    ['깊이는 3m, 아니 2m 간격으로 표식을 설치해 주세요.', '깊이는 2m 간격으로 표식을 설치해 주세요.'],
    ['깊이는 3m 또는 2m예요.', '깊이는 2m예요.'],
    ['깊이는 3m, 아니면 2m로 해요.', '깊이는 2m로 해요.'],
    ['깊이는 3m, 아니 길이는 2m예요.', '길이는 2m예요.'],
    ['철근 50개, 아니 15개도 필요해요.', '철근 15개도 필요해요.'],
    ['도면 5장, 아니요. 3장만 보내 주세요.', '도면 3건만 보내 주세요.'],
    ['길이는 3m, 아니 2m라고 쓰면 안 돼요.', '길이는 2m라고 쓰면 안 돼요.'],
    ['깊이는 3m, 아니 지점 2부터 확인하세요.', '지점 2부터 확인하세요.'],
    ['보내지 마세요. 그게 아니고 공유해 주세요.', '공유해 주세요.'],
    ['계약서는 보내지 마세요. 그게 아니고 견적서는 보내 주세요.', '견적서는 보내 주세요.'],
    ['도면은 보내지 마세요. 아니 도면은 보내 주세요. 사진은 공유하지 마세요.', '도면은 보내지 마세요. 사진은 공유해 주세요.'],
    ['도면은 보내지 마세요. 아니 도면은 보내 주세요. 사진은 공유하지 마세요.', '도면은 보내 주세요. 사진은 공유해 주세요.'],
    ['승인하지 마세요. 아니, 승인해 주세요. 사진은 공유하지 마세요.', '승인해 주세요. 사진을 공유하세요. 도면은 보내지 마세요.'],
    ['목록을 보냅니다. 아니, 사진은 공유하지 마세요. 계약서는 보내지 마세요.', '계약서는 보내지 마세요.'],
    ['철근 50개, 아니 15개 주문하면 안 돼. 다음 주에 주문해.', '철근 15개 주문해. 다른 일을 하면 안 돼.'],
    ['도면을 보내 주세요. 정정할게요. 도면을 보내지 마세요.', '도면을 보내 주세요.'],
  ]) assert.ok(meaningConcern(raw, cleaned), raw + ' -> ' + cleaned)
})
