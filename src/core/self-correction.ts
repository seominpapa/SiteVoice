type Amount = { start: number; end: number; unit: string }
type Clause = { text: string; start: number }
type Edit = { from: number; to: number } & ({ field: string } | { directive: string })
type ScanAmounts = (text: string) => Amount[]

const marker = /(?<![\p{L}\p{N}])(?:그게[ \t]+아니고|아니(?:고|요)?|정정(?:할게요|합니다))(?=[\s,.!?…;。！？])[\s,.!?…;。！？]*/gu
// Treat a decimal point or a thousands separator as part of a number.
const boundary = /(?<!\d)[,.]|[,.](?!\d)|[!?…;。！？\r\n]/u
const boundaryRun = /[,\s.!?…;。！？]+$/u
const maxClauseLength = 200
const unitFamilies = ['km m cm mm', 'kg g t', 'l ml'].map(group => new Set(group.split(' ')))
const comparable = (a: string, b: string) => a === b || unitFamilies.some(group => group.has(a) && group.has(b))

function nearby(text: string, leftEdge: number, leftEnd: number, rightStart: number, rightEdge: number) {
  const start = Math.max(leftEdge, leftEnd - maxClauseLength)
  const before = text.slice(start, leftEnd).replace(boundaryRun, '')
  const clause = before.split(boundary).at(-1) ?? ''
  if (!clause || (start > leftEdge && clause === before)) return
  const trimmed = clause.trimStart()
  const left = { text: trimmed, start: start + before.length - trimmed.length }
  const end = Math.min(rightEdge, rightStart + maxClauseLength)
  const after = text.slice(rightStart, end)
  const right = after.split(boundary)[0]?.trimEnd() ?? ''
  if (!right || (end < rightEdge && !boundary.test(after))) return
  return { left, right }
}

const spacing = (text: string) => text.replace(/\s+/gu, '')
const shape = (text: string, amount: Amount) => spacing(text.slice(0, amount.start) + '#' + text.slice(amount.end))

function fieldBefore(text: string, start: number) {
  const match = /(?<![\p{L}\p{N}])([\p{L}]{2,})(?:[ \t]+([\p{L}]{2,}))?[ \t:：]*$/u
    .exec(text.slice(Math.max(0, start - 60), start))
  if (!match) return ''
  const words = match[2] && !/^(?:이고|그리고|또한|또는)$/u.test(match[1]!) ? [match[1]!, match[2]] : [match[2] ?? match[1]!]
  return `field:${words.map(word => word.replace(/(?<=.)[은는을를]$/u, '').toLowerCase()).join(' ')}`
}

const differentField = /^(?:간격|폭|너비|높이|깊이|길이|거리|기간|수량|속도|두께|금액)(?:[으]?로|[은는이가를을에]|\s|$)/u
// Speech recognition may insert a period just before a spoken repair. Across
// that boundary require a bare replacement or a direct continuation verb.
const directAction = /^(?:[을를]|으?로)?\s*(?:((?:주문|발주|구매|준비|굴착|타설|설치|사용))[하해]|(보내|넣))/u
const simpleEnding = /^(?:입니다|이에요|예요|이야)$/u

function actionAfter(text: string, end: number) {
  const match = directAction.exec(text.slice(end, end + 60).trimStart())
  return match ? `action:${match[1] ?? match[2]}` : ''
}

export function amountField(text: string, amount: Amount) {
  return fieldBefore(text, amount.start) || actionAfter(text, amount.end)
}

function amountEdit(left: Clause, right: string, rightStart: number, scan: ScanAmounts, sameSentence: boolean): Edit | undefined {
  const old = scan(left.text)
  const next = scan(right)
  const a = old.at(-1), b = next[0]
  if (!a || !b) return
  const suffix = right.slice(b.end)
  const tail = suffix.trimStart()
  const field = fieldBefore(left.text, a.start) || actionAfter(right, b.end)
  if ((sameSentence || !tail || simpleEnding.test(tail) || directAction.test(tail)) &&
      a.end === left.text.length && b.start === 0 && comparable(a.unit, b.unit) &&
      !suffix.startsWith('도') &&
      !differentField.test(tail) &&
      !/^(?:또는|혹은|부터|까지|이상|이하|미만|가량|쯤|(?:이)?라(?:고|는|면)|[-~–])/u.test(tail)) {
    return { from: left.start + a.start, to: rightStart, field }
  }
  // Identical wording around a lone quantity identifies the field even if its unit changes.
  if (old.length === 1 && next.length === 1 && shape(left.text, a) !== '#' && shape(left.text, a) === shape(right, b)) {
    return { from: left.start, to: rightStart, field }
  }
}

function directive(text: string) {
  const forbid = /^(.+?)지\s*(?:마(?:세요|십시오|라|요)?|않겠(?:습니다|어요))$/u.exec(text)
  const allow = forbid ? null : /^(.+?)(?:\s*(?:주세요|주십시오|줘요?|주셔요)|세요|십시오|겠(?:습니다|어요))$/u.exec(text)
  const stem = (forbid ?? allow)?.[1]
  if (!stem || /(?:지\s*말고|(?:^|\s)(?:못|안)\s)/u.test(stem)) return
  return { stem: spacing(stem).replace(/해$/u, '하'), negated: !!forbid }
}

function directiveEdit(left: Clause, right: string, rightStart: number): Edit | undefined {
  const a = directive(left.text), b = directive(right)
  if (a && b && a.stem === b.stem && a.negated !== b.negated) {
    return { from: left.start, to: rightStart, directive: a.stem }
  }
}

export function correctionReference(text: string, scan: ScanAmounts, negated: (text: string) => boolean) {
  const markers = [...text.matchAll(marker)]
  const correctedDirectives = new Set<string>()
  const correctedFields = new Set<string>()
  let correctedAmount = false
  let sensitiveNegation = false
  const pieces: string[] = []
  let cursor = 0
  for (const [i, match] of markers.entries()) {
    const from = match.index, to = from + match[0].length
    const prev = markers[i - 1]
    const leftEdge = prev ? prev.index + prev[0].length : 0
    const bounds = nearby(text, leftEdge, from, to, markers[i + 1]?.index ?? text.length)
    if (!bounds) continue
    if (negated(bounds.left.text) || negated(bounds.right)) sensitiveNegation = true
    const gap = text.slice(bounds.left.start + bounds.left.text.length, from)
    const sameSentence = !/[.!?…;。！？\r\n]/u.test(gap)
    const edit = directiveEdit(bounds.left, bounds.right, to) ?? amountEdit(bounds.left, bounds.right, to, scan, sameSentence)
    if (!edit || edit.from < cursor) continue
    if ('directive' in edit) correctedDirectives.add(edit.directive)
    else {
      correctedAmount = true
      if (edit.field) correctedFields.add(edit.field)
    }
    pieces.push(text.slice(cursor, edit.from))
    cursor = edit.to
  }
  return { text: pieces.join('') + text.slice(cursor), correctedDirectives, correctedFields, correctedAmount, sensitiveNegation }
}

function directives(text: string) {
  const polarity = new Map<string, number>()
  for (const clause of text.split(boundary)) {
    const command = directive(clause.trim())
    if (command) polarity.set(command.stem, (polarity.get(command.stem) ?? 0) | (command.negated ? 2 : 1))
  }
  return polarity
}

export function directiveChanged(source: string, output: string, corrected: ReadonlySet<string>) {
  const before = directives(source), after = directives(output)
  return [...before].some(([stem, value]) => (after.has(stem) || corrected.has(stem)) && after.get(stem) !== value)
}

export function negativeClauses(text: string, negated: (text: string) => boolean, normalize: (text: string) => string) {
  return [...new Set(text.split(boundary).flatMap(clause => {
    const command = directive(clause.trim())
    if (command?.negated) return [command.stem]
    return negated(clause) ? [spacing(normalize(clause))] : []
  }))].sort().join('|')
}
