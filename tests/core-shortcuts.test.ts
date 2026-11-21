import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultShortcut, migrateShortcut, shortcutFromKey, validateShortcut } from '../src/core/shortcuts.ts'

test('uses the native default on both operating systems and only replaces the old default', () => {
  assert.equal(defaultShortcut('darwin'), 'Fn')
  assert.equal(defaultShortcut('win32'), 'Windows')
  assert.equal(defaultShortcut('linux'), 'CommandOrControl+Shift+Space')
  assert.equal(migrateShortcut('CommandOrControl+Shift+Space', undefined, 'darwin'), 'Fn')
  assert.equal(migrateShortcut('CommandOrControl+Shift+Space', undefined, 'win32'), 'Windows')
  assert.equal(migrateShortcut('CommandOrControl+Shift+Space', 1, 'darwin'), 'CommandOrControl+Shift+Space')
  assert.equal(migrateShortcut('Ctrl+Alt+K', undefined, 'win32'), 'Ctrl+Alt+K')
  assert.equal(validateShortcut('Fn', 'darwin'), 'Fn')
  assert.equal(validateShortcut('Windows', 'win32'), 'Windows')
  assert.throws(() => validateShortcut('Fn', 'win32'))
  assert.throws(() => validateShortcut('Windows', 'darwin'))
})

const key = (code: string, extras = {}) => ({ code, key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...extras })

test('converts keyboard presses while rejecting ordinary typing, repeats and unsupported combinations', () => {
  assert.equal(shortcutFromKey(key('KeyK', { key: 'ㅏ', metaKey: true, shiftKey: true }), 'darwin'), 'Command+Shift+K')
  assert.equal(shortcutFromKey(key('KeyJ', { ctrlKey: true, altKey: true }), 'win32'), 'Control+Alt+J')
  assert.equal(shortcutFromKey(key('Space', { ctrlKey: true }), 'win32'), 'Control+Space')
  assert.equal(shortcutFromKey(key('F8'), 'darwin'), 'F8')
  assert.equal(shortcutFromKey(key('F12'), 'win32'), undefined)
  assert.equal(shortcutFromKey(key('Numpad7', { ctrlKey: true }), 'win32'), 'Control+num7')
  assert.equal(shortcutFromKey(key('ArrowDown', { altKey: true }), 'darwin'), 'Alt+Down')
  assert.equal(shortcutFromKey(key('Equal', { key: '+', ctrlKey: true, shiftKey: true }), 'darwin'), 'Control+Shift+Plus')
  assert.equal(shortcutFromKey(key('KeyK'), 'win32'), undefined)
  assert.equal(shortcutFromKey(key('MetaLeft', { metaKey: true }), 'win32'), undefined)
  assert.equal(shortcutFromKey(key('Fn', { key: 'Fn' }), 'darwin'), undefined)
  assert.equal(shortcutFromKey(key('KeyA', { ctrlKey: true, repeat: true }), 'darwin'), undefined)
  assert.equal(shortcutFromKey(key('Escape', { ctrlKey: true }), 'darwin'), undefined)
  assert.equal(shortcutFromKey(key('KeyZ', { shiftKey: true }), 'win32'), undefined)
  assert.throws(() => validateShortcut('Ctrl+Control+Z', 'win32'))
  assert.throws(() => validateShortcut('Fn+L', 'darwin'))
})
