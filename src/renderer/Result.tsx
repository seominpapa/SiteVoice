import type { Action, State } from '../shared';
import { Icon, isActive, phaseLabel } from './presentation';

export function Result({ state, busy, act }: { state: State; busy: boolean; act(action: Action): void }) {
  const active = isActive(state.phase);
  return <>
    <div className="page-title"><span className="eyebrow">음성 작업</span><h1>받아쓴 결과</h1><p>정리한 문장과 실제로 받아쓴 원문을 확인하세요.</p></div>
    <section className="panel result-overview" aria-labelledby="result-status">
      <div className="panel-heading"><span className="panel-icon"><Icon name="result"/></span><div><h2 id="result-status" role="status">{phaseLabel[state.phase]}</h2><p>{state.message || (active ? '작업이 끝나면 이곳에서 결과를 볼 수 있습니다.' : '결과는 닫을 때까지 이 창에서 볼 수 있습니다.')}</p></div></div>
      {active && state.phase !== 'pasting' && <button type="button" className="button secondary" onClick={() => act('cancel')} disabled={busy}>작업 취소</button>}
    </section>
    <section className="panel result-panel" aria-labelledby="cleaned-heading">
      <div className="panel-heading"><h2 id="cleaned-heading">정리한 문장</h2>{state.cleaned && <button type="button" className="button primary" disabled={busy} onClick={() => act('copyCleaned')}><Icon name="copy" size={17}/>정리 결과 복사</button>}</div>
      <p className={`transcript ${state.cleaned ? '' : 'empty'}`}>{state.cleaned || '정리한 문장이 아직 없습니다.'}</p>
    </section>
    <section className="panel result-panel" aria-labelledby="raw-heading">
      <div className="panel-heading"><h2 id="raw-heading">원문 전사</h2>{state.raw && <button type="button" className="button secondary" disabled={busy} onClick={() => act('copyRaw')}><Icon name="copy" size={17}/>원문 복사</button>}</div>
      <p className={`transcript ${state.raw ? '' : 'empty'}`}>{state.raw || '음성을 받아쓰면 여기에 표시됩니다.'}</p>
    </section>
    {!active && state.phase !== 'idle' && <div className="button-row">
      {state.raw && <button type="button" className="button secondary" disabled={busy} onClick={() => act('retry')}>다시 정리</button>}
      <button type="button" className="button subtle" disabled={busy} onClick={() => act('dismiss')}>결과 닫기</button>
    </div>}
  </>;
}
