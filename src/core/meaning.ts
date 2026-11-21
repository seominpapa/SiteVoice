const units = new Map(Object.entries({
  제곱미터: 'm²', 'm²': 'm²', m2: 'm²', 세제곱미터: 'm³', 'm³': 'm³', m3: 'm³',
  킬로미터: 'km', km: 'km', 센티미터: 'cm', cm: 'cm', 밀리미터: 'mm', mm: 'mm', 미터: 'm', m: 'm',
  킬로그램: 'kg', kg: 'kg', 그램: 'g', g: 'g', 밀리리터: 'ml', ml: 'ml', 리터: 'l', l: 'l',
  퍼센트: '%', '%': '%', 시: '시', 분: '분', 초: '초', 년: '년', 월: '월', 일: '일',
  시간: '시간', 달: '달', 주: '주', 번: '번', 개: '개', 명: '명',
  '억 원': '억원', '만 원': '만원', '천 원': '천원', '백 원': '백원',
  '억원': '억원', '만원': '만원', '천원': '천원', '백원': '백원', 원: '원', 달러: '달러',
  억: '억', 만: '만', 천: '천', 백: '백', 톤: 't', t: 't',
}))
const unitPattern = [...units.keys()].sort((a, b) => b.length - a.length).join('|')
const digit = new Map(Object.entries({ 영: '0', 공: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5',
  육: '6', 칠: '7', 팔: '8', 구: '9', 한: '1', 두: '2', 세: '3', 네: '4',
  다섯: '5', 여섯: '6', 일곱: '7', 여덟: '8', 아홉: '9', 열: '10' }))
const sino = '[영공일이삼사오육칠팔구]'
const spokenNumber = [...digit.keys()].sort((a, b) => b.length - a.length).join('|')
const written = new RegExp(`(?<![a-z\\d])([+−-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)(?:[ \\t]*(${unitPattern})(?![a-z0-9]))?`, 'gi')
const spoken = new RegExp(`(?<![\\p{L}\\p{N}])(${sino}\\s*점\\s*${sino}(?:\\s*${sino})*|${spokenNumber})[ \\t]*(${unitPattern})(?![a-z0-9])`, 'giu')
const negative = /(?:하지[ \t]*마|(?:하면|해선|해서는)[ \t]*안|않(?:았|는|고|다|습|아|을|게)|못[ \t]+|안[ \t]+|금지|없(?:다|습|어요|어야|을)|\b(?:no|not|never|without)\b|n['’]t\b)/iu

function quantity(value: string, unit: string = '') {
  const normalized = value.replaceAll(',', '').replace('−', '-')
    .replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1')
    .replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
  return `${normalized}:${units.get(unit.toLowerCase()) ?? ''}`
}

function quantities(input: string) {
  const text = input.replace(/[\uff00-\uffef]/g, char => char.normalize('NFKC'))
  const output = [...text.matchAll(written)].map(match => quantity(match[1]!, match[2]))
  for (const [phrase, value, unit] of text.matchAll(spoken)) {
    if (phrase === '한번') continue
    const [whole, decimal] = value!.split('점').map(part => part.trim())
    const number = digit.get(whole!)
    if (!number) continue
    const fraction = decimal?.replaceAll(/\s/g, '').split('').map(char => digit.get(char)).join('')
    output.push(quantity(fraction ? `${number}.${fraction}` : number, unit))
  }
  return [...new Set(output)].sort().join('|')
}

export function meaningConcern(raw: string, cleaned: string) {
  // shortcut: checks explicit quantities and common negations; upgrade with evaluated semantic checks.
  if (quantities(raw) !== quantities(cleaned)) return '숫자나 단위가 달라졌을 수 있어요. 확인한 뒤 복사해 주세요.'
  if (negative.test(raw) !== negative.test(cleaned)) return '부정 표현이 달라졌을 수 있어요. 확인한 뒤 복사해 주세요.'
  return undefined
}
