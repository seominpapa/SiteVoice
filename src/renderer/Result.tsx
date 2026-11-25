import type { Action, HistoryEntry, State } from '../shared';
import { Icon, isActive, phaseLabel } from './presentation';

const localTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const seconds = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const transcriptionMode = {
  live: '실시간 전사',
  file: '녹음 후 파일 전사',
  fallback: '실시간 전사 실패 후 파일로 전사',
};

function duration(ms: number) {
  return ms < 1_000 ? `${Math.round(ms)}밀리초` : `${seconds.format(ms / 1_000)}초`;
}

function RecentDiagnostics({ diagnostics }: { diagnostics: NonNullable<State['diagnostics']> }) {
  const time = diagnostics.recordedAt === undefined ? undefined : new Date(diagnostics.recordedAt);
  return <details className="panel result-diagnostics">
    <summary>최근 받아쓰기 진단</summary>
    <dl>
      {time && <div><dt>녹음 시각</dt><dd><time dateTime={time.toISOString()}>{localTime.format(time)}</time></dd></div>}
      <div><dt>전사 방식</dt><dd>{transcriptionMode[diagnostics.transcriptionMode]}</dd></div>
      <div><dt>사용한 전사 모델</dt><dd><code>{diagnostics.transcriptionModel}</code></dd></div>
      <div><dt>녹음 길이</dt><dd>{duration(diagnostics.recordingMs)}</dd></div>
      <div><dt>녹음 종료 후 전사</dt><dd>{duration(diagnostics.transcriptionMs)}</dd></div>
      <div><dt>문장 정리</dt><dd>
        {duration(diagnostics.cleanupMs)}
        {diagnostics.cleanupRetried && ' · 다시 정리'}
      </dd></div>
    </dl>
  </details>;
}

function ResultText({ recordedAt, text, reviewNote, disabled, copy }: {
  recordedAt?: number; text: string; reviewNote?: string; disabled: boolean; copy(): void;
}) {
  const time = recordedAt === undefined ? undefined : new Date(recordedAt);
  return <>
    <div className="panel-heading">
      {time && <time dateTime={time.toISOString()}>{localTime.format(time)}</time>}
      <button type="button" className="button primary" disabled={disabled} onClick={copy}><Icon name="copy" size={17}/>결과 복사</button>
    </div>
    {reviewNote && <p className="inline-error">{reviewNote}</p>}
    <p className="transcript">{text}</p>
  </>;
}

export function Result({ state, history, historyWarning, busy, act, copyHistory }: {
  state: State; history: HistoryEntry[]; historyWarning?: string; busy: boolean;
  act(action: Action): void; copyHistory(id: string): void;
}) {
  const active = isActive(state.phase);
  const currentText = state.cleaned ?? state.raw;
  const saved = history.find(entry => entry.id === state.resultId);
  const current = !active && state.phase !== 'cancelled' && currentText !== saved?.text ? currentText : undefined;
  const showStatus = active || state.phase === 'failed' || (!current && !history.length && !historyWarning);
  return <>
    <div className="page-title"><span className="eyebrow">음성 작업</span><h1>받아쓴 결과</h1></div>
    {historyWarning && <p className="notice inline-error" role="alert">{historyWarning}</p>}
    {showStatus && <section className="panel result-overview" aria-labelledby="result-status">
      <div className="panel-heading"><span className="panel-icon"><Icon name="result"/></span><div><h2 id="result-status" role="status">{phaseLabel[state.phase]}</h2><p>{state.message || (active ? '작업이 끝나면 이곳에서 결과를 볼 수 있습니다.' : '아직 받아쓴 결과가 없습니다.')}</p></div></div>
      {active && state.phase !== 'pasting' && <button type="button" className="button secondary" onClick={() => act('cancel')} disabled={busy}>작업 취소</button>}
    </section>}
    {current && <section className="panel result-panel" aria-label="현재 결과">
      <ResultText recordedAt={state.resultAt} text={current} reviewNote={state.reviewNote}
        disabled={busy} copy={() => act(state.cleaned ? 'copyCleaned' : 'copyRaw')}/>
    </section>}
    {!active && state.raw && <div className="button-row">
      <button type="button" className="button secondary" disabled={busy} onClick={() => act('retry')}>최근 결과 다시 정리</button>
    </div>}
    {!active && state.diagnostics && <RecentDiagnostics diagnostics={state.diagnostics}/>}
    {history.length > 0 && <ol className="result-history" role="list" aria-label="받아쓰기 기록">
      {history.map(entry => <li className="panel result-panel" key={entry.id}>
        <ResultText recordedAt={entry.recordedAt} text={entry.text} reviewNote={entry.reviewNote}
          disabled={busy || active} copy={() => copyHistory(entry.id)}/>
      </li>)}
    </ol>}
  </>;
}
