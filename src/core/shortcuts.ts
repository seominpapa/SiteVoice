import { ServiceError } from './errors.ts'

const legacyDefault = 'CommandOrControl+Shift+Space'
const modifiers = new Map(Object.entries({
  command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl',
  commandorcontrol: 'cmdctrl', cmdorctrl: 'cmdctrl',
  alt: 'alt', option: 'alt', altgr: 'altgr', shift: 'shift',
  super: 'super', meta: 'super',
}))
const functionKey = /^f(?:[1-9]|1\d|2[0-4])$/i
const acceleratorKey = /^(?:[a-z0-9]|space|tab|enter|return|insert|delete|backspace|home|end|pageup|pagedown|up|down|left|right|num[0-9]|plus)$/i

export function nativeShortcut(platform: string) {
  if (platform === 'darwin') return 'Fn'
  if (platform === 'win32') return 'Windows'
}
export function defaultShortcut(platform: string) { return nativeShortcut(platform) ?? legacyDefault }
export function migrateShortcut(value: unknown, version: unknown, platform: string) {
  return version === undefined && value === legacyDefault ? defaultShortcut(platform) : value
}

export function validateShortcut(value: unknown, platform: string): string {
  const input = typeof value === 'string' && value.length <= 80 ? value.trim() : ''
  if (input && input === nativeShortcut(platform)) return input
  const parts = input.split('+')
  const key = parts.pop() ?? ''
  const group = parts.map(part => modifiers.get(part.toLowerCase()))
  const fn = functionKey.test(key) && (platform !== 'win32' || key.toUpperCase() !== 'F12')
  const modifierValid = !group.includes(undefined) && new Set(group).size === group.length &&
    !(group.includes('cmdctrl') && (group.includes('cmd') || group.includes('ctrl')))
  if ((fn || acceleratorKey.test(key)) && modifierValid &&
      (group.some(part => part !== 'shift') || (fn && !group.length))) return input
  throw new ServiceError('단축키를 확인해 주세요. 기능 키 또는 보조 키와 함께 눌러 설정하세요.')
}

type Key = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>
const namedKeys = ['Space', 'Tab', 'Enter', 'Insert', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown']

function acceleratorFor(event: Key) {
  const { code } = event
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6)
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code.slice(5)
  if (functionKey.test(code) || namedKeys.includes(code)) return code
  if (event.key === '+') return 'Plus'
}
export function shortcutFromKey(event: Key, platform: string) {
  if (event.repeat || event.getModifierState?.('Fn') || event.getModifierState?.('AltGraph')) return
  const key = acceleratorFor(event)
  if (!key) return
  const input = [
    event.metaKey && (platform === 'darwin' ? 'Command' : 'Super'),
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    key,
  ].filter(Boolean).join('+')
  try { return validateShortcut(input, platform) }
  catch { return undefined }
}
