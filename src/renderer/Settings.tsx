import { useState } from 'react';
import type { KeyAction, Settings, Snapshot } from '../shared';
import { Icon } from './presentation';
import { ShortcutPicker } from './ShortcutPicker';

export function KeyPanel({ snapshot, busy, onKey }: {
  snapshot: Snapshot; busy: boolean; onKey(action: KeyAction, value?: string): Promise<boolean>;
}) {
  const [key, setKey] = useState('');
  const store = async () => { if (await onKey('save', key.trim())) setKey(''); };
  return <section className="panel key-panel" aria-labelledby="key-heading">
    <div className="panel-heading"><span className="panel-icon"><Icon name="key"/></span><div><h2 id="key-heading">OpenAI 연결</h2><p>개인 API 키로 음성 전사와 문장 정리를 요청합니다.</p></div><span className="status-badge">{snapshot.keyStored ? '키 저장됨' : '키 미등록'}</span></div>
    <form onSubmit={(event) => { event.preventDefault(); void store(); }}>
      <label className="field">OpenAI API 키<input type="password" placeholder={snapshot.keyStored ? '교체할 키를 입력하세요' : 'sk-…'} autoComplete="off" spellCheck={false} value={key} maxLength={1024} disabled={!snapshot.protectedStorage} onChange={(event) => setKey(event.target.value)}/></label>
      <div className="button-row"><button className="button primary" type="submit" disabled={busy || !snapshot.protectedStorage || !key.trim()}>{snapshot.keyStored ? '키 교체' : '키 저장'}</button>
        {snapshot.keyStored && <><button className="button secondary" type="button" disabled={busy} onClick={() => void onKey('verify')}>키 확인</button><button className="button subtle danger" type="button" disabled={busy} onClick={() => void onKey('delete')}>키 삭제</button></>}
      </div>
    </form>
    {!snapshot.protectedStorage && <p className="inline-error">이 환경에서는 키를 안전하게 저장할 수 없습니다.</p>}
    <p className="privacy"><Icon name="shield" size={17}/><span>키는 운영체제의 보안 저장소로 보호합니다. 전사할 음성과 문장 정리용 텍스트는 OpenAI로 전송되며, 앱은 결과를 디스크에 저장하지 않습니다.</span></p>
  </section>;
}

export function SettingsFields({ draft, change, snapshot, disabled, onShortcutPermission }: {
  draft: Settings; change(next: Settings): void; snapshot: Snapshot; disabled: boolean; onShortcutPermission(): void;
}) {
  const [term, setTerm] = useState('');
  const terms = draft.terms;
  return <>
    <section className="panel" aria-labelledby="models-heading">
      <div className="panel-heading"><span className="panel-icon"><Icon name="setup"/></span><div><h2 id="models-heading">모델과 단축키</h2><p>전사와 문장 정리에 사용할 모델을 따로 지정할 수 있습니다.</p></div></div>
      <div className="columns">
        <label className="field">음성 전사 모델<input value={draft.transcriptionModel} maxLength={128} onChange={(event) => change({ ...draft, transcriptionModel: event.target.value })} spellCheck={false}/></label>
        <label className="field">문장 정리 모델<input value={draft.cleanupModel} maxLength={128} onChange={(event) => change({ ...draft, cleanupModel: event.target.value })} spellCheck={false}/></label>
      </div>
      <ShortcutPicker value={draft.shortcut} platform={snapshot.platform} status={snapshot.shortcutPermission}
        registered={snapshot.shortcutRegistered} disabled={disabled} onPermission={onShortcutPermission}
        onChange={(shortcut) => change({ ...draft, shortcut })}/>
    </section>
    <section className="panel" aria-labelledby="terms-heading">
      <div className="panel-heading"><span className="panel-icon"><Icon name="result"/></span><div><h2 id="terms-heading">개인 용어 사전</h2><p>현장명, 인명, 전문 용어를 전사에 참고합니다.</p></div></div>
      {terms.length > 0 && <ul className="terms">{terms.map((item, index) => <li key={index}>
        <input aria-label={`등록 용어 ${index + 1}`} spellCheck={false} maxLength={80} value={item} onChange={(event) => change({ ...draft, terms: terms.map((value, i) => i === index ? event.target.value : value) })}/>
        <button type="button" className="button icon-button" aria-label={`${index + 1}번 용어 삭제`} onClick={() => change({ ...draft, terms: terms.filter((_, i) => i !== index) })}><Icon name="close" size={17}/></button>
      </li>)}</ul>}
      <form className="term-form" onSubmit={(event) => {
        event.preventDefault();
        const value = term.trim();
        if (!value || terms.some((item) => item.trim() === value) || terms.length >= 64) return;
        change({ ...draft, terms: [...terms, value] });
        setTerm('');
      }}>
        <label className="field">새 용어<input placeholder="예: SiteCAD, 흙막이, 숏크리트" spellCheck={false} maxLength={80} value={term} onChange={(event) => setTerm(event.target.value)}/></label>
        <button className="button secondary" disabled={!term.trim() || terms.some((item) => item.trim() === term.trim()) || terms.length >= 64}>용어 추가</button>
      </form>
      <small>자동 치환은 하지 않습니다. 용어 수정 후 환경 설정을 저장하세요.</small>
    </section>
  </>;
}
