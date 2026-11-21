import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { defaultShortcut, nativeShortcut, shortcutFromKey } from '../core/shortcuts.ts';
import type { Snapshot } from '../shared';
import { errorMessage, shortcutKeys } from './presentation';

export function ShortcutPicker({ value, platform, status, registered, disabled, onChange, onPermission, onKeyboardSettings }: {
  value: string;
  platform: string;
  status: Snapshot['shortcutPermission'];
  registered: boolean;
  disabled: boolean;
  onChange(value: string): void;
  onPermission(): void;
  onKeyboardSettings(): void;
}) {
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState('');
  const session = useRef<symbol | null>(null);
  const mac = platform === 'darwin';
  const specialKey = nativeShortcut(platform);
  const platformDefault = defaultShortcut(platform);
  const example = mac ? 'Control + Option + Space' : 'Ctrl + Alt + Space';

  const release = useCallback(() => {
    if (!session.current) return;
    session.current = null;
    void window.voice.setShortcutCapture(false).catch(() => undefined);
  }, []);

  function stop(message = '') {
    release();
    setRecording(false);
    setNote(message);
  }

  function saveCandidate(shortcut: string) {
    onChange(shortcut);
    stop('단축키를 선택했습니다. 환경 설정을 저장하면 적용됩니다.');
  }

  useEffect(() => {
    const unsubscribe = window.voice.onShortcutCapture((key) => {
      if (!disabled && session.current && key === specialKey) saveCandidate(key);
    });
    return unsubscribe;
  });
  useEffect(() => {
    const blur = () => {
      if (!session.current) return;
      release();
      setRecording(false);
      setNote('');
    };
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('blur', blur);
      release();
    };
  }, [release]);
  useEffect(() => {
    if (disabled && session.current) {
      release();
      setRecording(false);
      setNote('');
    }
  }, [disabled, release]);

  function start() {
    if (session.current) { stop('단축키 입력을 취소했습니다.'); return; }
    const id = Symbol();
    session.current = id;
    setRecording(true);
    setNote(`키를 누르세요. 예: ${example}. Esc로 취소합니다.`);
    void window.voice.setShortcutCapture(true).then((nativeAvailable) => {
      if (session.current === id && specialKey && !nativeAvailable) {
        setNote(`${specialKey} 단독 입력은 아직 사용할 수 없습니다. 키 조합(예: ${example})은 지금 입력할 수 있습니다.`);
      }
    }).catch((reason: unknown) => {
      if (session.current === id) stop(errorMessage(reason));
    });
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!session.current || disabled) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) { stop(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { stop('단축키 입력을 취소했습니다.'); return; }
    if (event.repeat || ['Shift', 'Alt', 'Control', 'Meta', 'Fn'].includes(event.key)) return;
    const shortcut = shortcutFromKey(event, platform);
    if (shortcut) saveCandidate(shortcut);
    else setNote('보조 키와 함께 누르거나 F1–F24를 사용하세요. Esc로 취소할 수 있습니다.');
  }

  return <div className="shortcut-picker">
    <span className="field-label">전역 단축키</span>
    <div className="shortcut-picker-row">
      <output className="keys" aria-label="설정할 전역 단축키" data-shortcut={value}>
        {shortcutKeys(value, mac).map((key, index) => <kbd key={index}>{key}</kbd>)}
      </output>
      <button type="button" className={`button ${recording ? 'primary' : 'secondary'}`} aria-label="단축키 입력" aria-pressed={recording}
        aria-describedby="shortcut-hint shortcut-capture-status" disabled={disabled} onClick={(event) => { event.currentTarget.focus(); start(); }}
        onBlur={() => { if (session.current) stop(); }} onKeyDown={handleKey}>{recording ? '입력 취소' : '단축키 입력'}</button>
      <button type="button" className="button subtle" disabled={disabled} onClick={() => saveCandidate(platformDefault)}>기본값 사용</button>
    </div>
    <small id="shortcut-hint">키 조합을 직접 누른 뒤 환경 설정을 저장하세요. 기본값: {shortcutKeys(platformDefault, mac).join(' + ')}.</small>
    <p id="shortcut-capture-status" role="status">{note}</p>
    {mac && <div className="button-row shortcut-permission">
      <small>{status === 'ready' ? 'Fn 단독 입력을 감지할 수 있습니다.'
        : 'Fn이 감지되지 않으면 입력 모니터링에서 SiteVoice를 허용하세요. 일반 키 조합은 이 권한 없이도 설정할 수 있습니다.'}</small>
      <button type="button" className="button secondary" disabled={disabled} onClick={onPermission}>입력 모니터링 설정 열기</button></div>}
    {mac && value === 'Fn' && <div className="button-row shortcut-permission">
      <small>Fn을 눌렀을 때 이모지 창도 열리면, 키보드 설정에서 ‘🌐 키를 누를 때 실행할 동작’을 ‘안 함’으로 바꾸세요.</small>
      <button type="button" className="button secondary" disabled={disabled} onClick={onKeyboardSettings}>키보드 설정 열기</button>
    </div>}
    {!registered && !(mac && value === 'Fn') && <p className="inline-error">저장된 전역 단축키가 연결되지 않았습니다. 다른 키 조합을 선택하고 저장해 주세요.</p>}
  </div>;
}
