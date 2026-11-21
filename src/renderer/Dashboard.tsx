import { useEffect, useRef, useState } from 'react';
import type { Action, KeyAction, Settings, Snapshot, State } from '../shared';
import { Microphone } from './Microphone';
import { Brand, errorMessage, Icon, isActive, permissionLabel, phaseLabel, VoiceStudio } from './presentation';
import { Result } from './Result';
import { KeyPanel, SettingsFields } from './Settings';

type Page = 'setup' | 'settings' | 'result';
const pages = [ ['setup', '시작하기'], ['settings', '환경 설정'], ['result', '결과'] ] as const;
const actionNotice: Partial<Record<Action, string>> = { copyRaw: '원문을 복사했습니다.', copyCleaned: '정리한 문장을 복사했습니다.' };
const keyNotice: Record<KeyAction, string> = { save: 'API 키를 저장했습니다.', verify: '키가 모델 조회에 사용할 수 있는 상태입니다.', delete: '저장한 API 키를 삭제했습니다.' };

function shortcutKeys(shortcut: string, isMac: boolean) {
  const labels: Record<string, string> = { CommandOrControl: isMac ? '⌘' : 'Ctrl', CmdOrCtrl: isMac ? '⌘' : 'Ctrl', Command: '⌘', Control: 'Ctrl', Shift: 'Shift', Alt: isMac ? '⌥' : 'Alt', Option: '⌥' };
  return shortcut.split('+').map((key) => labels[key] || key);
}

export function Dashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Settings>();
  const [page, setPage] = useState<Page>('setup');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [updateStatus, setUpdateStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const latest = useRef<State | undefined>(undefined);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    const unsubscribe = window.voice.onState((state) => {
      if (latest.current && state.id < latest.current.id) return;
      const previous = latest.current;
      latest.current = state;
      setSnapshot((current) => current && { ...current, state });
      if (state.phase !== 'idle' && !isActive(state.phase) && (previous?.id !== state.id || previous.phase !== state.phase)) {
        setPage('result');
        setNotice('');
        setError('');
      }
    });
    let mounted = true;
    void window.voice.get().then((value) => {
      if (!mounted) return;
      document.title = value.name;
      const state = latest.current ?? value.state;
      latest.current = state;
      setSnapshot({ ...value, state });
      setDraft(value.settings);
      if (state.phase !== 'idle' && !isActive(state.phase)) setPage('result');
    }).catch((reason: unknown) => { if (mounted) setError(errorMessage(reason)); });
    const refreshPermissions = () => {
      void window.voice.get().then((value) => {
        if (!mounted) return;
        setSnapshot((current) => current && ({ ...current, microphone: value.microphone, accessibility: value.accessibility }));
      }).catch(() => { /* A permission refresh should not cover an existing result or error. */ });
    };
    window.addEventListener('focus', refreshPermissions);
    return () => { mounted = false; unsubscribe(); window.removeEventListener('focus', refreshPermissions); };
  }, []);
  useEffect(() => { content.current?.scrollTo(0, 0); }, [page]);

  function receive(value: Snapshot) {
    const state = latest.current && latest.current.id >= value.state.id ? latest.current : value.state;
    latest.current = state;
    setSnapshot({ ...value, state });
  }

  async function run(work: () => Promise<void>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const perform = (work: () => Promise<Snapshot>, message = '', replaceDraft = false) => run(async () => {
    const value = await work();
    receive(value);
    if (replaceDraft) setDraft(value.settings);
    setNotice(message);
  });
  const checkUpdate = () => void run(async () => {
    setUpdateStatus('업데이트 확인 중…');
    try {
      setUpdateStatus(await window.voice.checkUpdate());
    } catch (reason) {
      setUpdateStatus(errorMessage(reason));
    }
  });

  const act = (action: Action) => void perform(() => window.voice.action(action), actionNotice[action]);
  const switchPage = (next: Page) => { setNotice(''); setError(''); setPage(next); };
  const key = (action: KeyAction, value?: string) => perform(() => window.voice.key(action, value), keyNotice[action]);
  if (!snapshot || !draft) return <main className="loading" role={error ? 'alert' : 'status'}>{error || '앱 설정을 불러오는 중입니다.'}</main>;

  const mac = snapshot.platform === 'darwin';
  const active = isActive(snapshot.state.phase);
  const warning = snapshot.state.phase === 'idle' ? snapshot.state.message : undefined;
  const shortcuts = shortcutKeys(snapshot.settings.shortcut, mac);
  const permissionCard = <section className="panel permission" aria-labelledby="target-heading">
    <div className="panel-heading"><span className="panel-icon"><Icon name="shield"/></span><div><h2 id="target-heading">{mac ? '손쉬운 사용 권한' : '자동 입력 권한'}</h2><p>{mac ? '다른 앱의 입력 칸을 확인하고 붙여넣으려면 이 권한이 필요합니다.' : 'Windows가 입력을 허용하는 편집기에만 붙여넣습니다.'}</p></div><span className="status-badge">{permissionLabel[snapshot.accessibility] ?? '확인 필요'}</span></div>
    <div className="button-row"><button type="button" className="button secondary" disabled={busy || active} onClick={() => void perform(() => window.voice.permission('accessibility'))}>{mac ? '권한 확인 · 설정 열기' : '자동 입력 상태 확인'}</button></div>
  </section>;
  const micro = <Microphone key={page} status={snapshot.microphone} deviceId={draft.microphoneId} active={active} onPermission={async () => receive(await window.voice.permission('microphone'))}
    onDevice={page === 'settings' ? (microphoneId) => setDraft({ ...draft, microphoneId }) : undefined}/>;

  return <div className="app-shell">
    <header className="topbar">
      <Brand name={snapshot.name}/>
      <nav aria-label="앱 메뉴">{pages.map(([id, label]) => <button type="button" aria-current={page === id ? 'page' : undefined} aria-description={id === 'result' && (snapshot.state.raw || snapshot.state.cleaned) ? '저장되지 않은 결과가 있습니다.' : undefined} className={`nav-item ${page === id ? 'selected' : ''}`} onClick={() => switchPage(id)} key={id}>{label}{id === 'result' && (snapshot.state.raw || snapshot.state.cleaned) && <span className="nav-dot" aria-hidden="true"/>}</button>)}</nav>
      <div className="theme-toggle" role="group" aria-label="화면 테마">
        <button type="button" aria-pressed={snapshot.theme === 'light'} disabled={busy || active} onClick={() => void perform(() => window.voice.setTheme('light'))}><Icon name="sun" size={15}/>밝게</button>
        <button type="button" aria-pressed={snapshot.theme === 'dark'} disabled={busy || active} onClick={() => void perform(() => window.voice.setTheme('dark'))}><Icon name="moon" size={15}/>어둡게</button>
      </div>
    </header>
    <main className="content" ref={content}>
      <div className="content-inner">
        {(error || notice || warning) && <div className={`notice ${error || (!notice && warning) ? 'inline-error' : ''}`} role={error || (!notice && warning) ? 'alert' : 'status'}>{error || notice || warning}{(error || notice) && <button type="button" className="button icon-button" aria-label="알림 닫기" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" size={16}/></button>}</div>}
        {page === 'setup' && <>
          <header className="hero"><div className="hero-copy"><span className="eyebrow">데스크톱 음성 입력</span><h1>말하면,<br/>문장이 됩니다.</h1><p>전사와 문장 정리를 거쳐<br/>방금 쓰던 곳에 입력합니다.</p></div><VoiceStudio/></header>
          <div className="start-strip"><div><h2>녹음 준비</h2><p>{!snapshot.keyStored ? '먼저 API 키를 저장해 주세요.' : '전역 단축키를 눌러 녹음을 시작하고 종료하세요.'}</p></div><div className="start-shortcut"><span>전역 단축키</span><div className="keys">{shortcuts.map((item, index) => <kbd key={index}>{item}</kbd>)}</div></div><button type="button" className="button primary" disabled={!snapshot.keyStored || busy || active} onClick={() => act('start')}><Icon name="mic" size={17}/>녹음 시작</button></div>
          <KeyPanel snapshot={snapshot} busy={busy || active} onKey={key}/>
          <div className="setup-tools">{micro}{permissionCard}</div>
        </>}
        {page === 'settings' && <>
          <div className="page-title"><span className="eyebrow">기기 및 연결</span><h1>환경 설정</h1><p>모델, 단축키, 마이크와 자주 쓰는 이름을 설정하세요.</p></div>
          <section className="panel" aria-labelledby="update-heading">
            <div className="panel-heading"><span className="panel-icon"><Icon name="update"/></span><div><h2 id="update-heading">앱 업데이트</h2><p>현재 버전 {snapshot.version}</p></div><button type="button" className="button secondary" onClick={checkUpdate} disabled={busy || active || !snapshot.updatesAvailable}>업데이트 확인</button></div>
            <div className="update-controls"><label><input type="checkbox" checked={snapshot.autoUpdate} disabled={busy || active} onChange={(event) => { const enabled = event.target.checked; void perform(() => window.voice.setAutoUpdate(enabled)); }}/>앱을 시작할 때 업데이트 자동 확인</label>
              <p role="status">{snapshot.updatesAvailable ? updateStatus : '이 설치본에는 업데이트 서버가 설정되어 있지 않습니다.'}</p>
            </div>
          </section>
          <KeyPanel snapshot={snapshot} busy={busy || active} onKey={key}/>
          <SettingsFields draft={draft} change={setDraft} shortcutRegistered={snapshot.shortcutRegistered} platform={snapshot.platform}/>
          {micro}{permissionCard}
          <div className="settings-save"><p>API 키 변경은 즉시 반영됩니다.</p><button type="button" className="button primary" disabled={busy || active || JSON.stringify(draft) === JSON.stringify(snapshot.settings)} onClick={() => void perform(() => window.voice.save(draft), '환경 설정을 저장했습니다.', true)}>환경 설정 저장<Icon name="arrow" size={16}/></button></div>
        </>}
        {page === 'result' && <Result state={snapshot.state} busy={busy} act={act}/>}
        <footer className="tray-label"><i aria-hidden="true" className={active ? 'live' : ''}/>{active ? phaseLabel[snapshot.state.phase] : mac ? '메뉴 막대에서 실행 중' : '시스템 트레이에서 실행 중'}</footer>
      </div>
    </main>
  </div>;
}
