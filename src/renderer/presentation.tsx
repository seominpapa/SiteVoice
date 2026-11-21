import type { Phase } from '../shared';

const paths = {
  mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 1 0 14 0v-1M12 19v3m-4 0h8"/></>,
  setup: <><path d="M12 2v5m0 10v5M2 12h5m10 0h5M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3"/><circle cx="12" cy="12" r="3"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><rect x="7" y="4" width="3" height="4" rx="1"/><rect x="14" y="10" width="3" height="4" rx="1"/><rect x="8" y="16" width="3" height="4" rx="1"/></>,
  result: <><rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6m-6 4h6m-6 4h4"/></>,
  key: <><circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-3-3 3-3m-6 0 2-2"/></>,
  shield: <><path d="m12 2 8 3v6c0 5-3 8-8 11-5-3-8-6-8-11V5z"/><path d="m9 12 2 2 4-4"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon: <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z"/>,
  update: <path d="M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-2l2 3M4 15l2 3a8 8 0 0 0 13-2"/>,
};

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export const phaseLabel: Record<Phase, string> = {
  idle: '대기 중', recording: '녹음 중', transcribing: '음성 전사 중', cleaning: '문장 정리 중',
  pasting: '입력 대상 확인 중', completed: '처리 완료', copy: '복사 대기', failed: '처리 실패', cancelled: '취소됨',
};

export function isActive(phase: Phase) {
  return ['recording', 'transcribing', 'cleaning', 'pasting'].includes(phase);
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '작업을 완료하지 못했습니다. 다시 시도해 주세요.';
}

export const permissionLabel: Record<string, string> = {
  granted: '허용됨', denied: '허용 안 됨', 'not-determined': '권한 확인 필요', restricted: '시스템에서 제한됨',
  available: '사용 가능', unavailable: '자동 입력 제한', unknown: '직접 확인 필요', delegated: '직접 확인 필요',
};

export function Brand({ name }: { name: string }) {
  return <div className="brand"><span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4"/></svg></span><strong>{name}</strong></div>;
}

export function VoiceStudio() {
  return <svg className="studio" viewBox="0 0 360 220" aria-hidden="true">
    <defs>
      <linearGradient id="mic-shell" x2="1" y2="0">
        <stop stopColor="#24292e"/><stop offset=".24" stopColor="#60686f"/><stop offset=".45" stopColor="#353b40"/><stop offset="1" stopColor="#15181c"/>
      </linearGradient>
      <linearGradient id="mic-metal" x2=".93" y2=".5">
        <stop stopColor="#9ba1a6"/><stop offset=".28" stopColor="#5a6168"/><stop offset="1" stopColor="#303438"/>
      </linearGradient>
      <pattern id="mic-grid" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".75" fill="#101317"/></pattern>
      <radialGradient id="mic-floor"><stop stopColor="#12161a" stopOpacity=".23"/><stop offset="1" stopColor="#12161a" stopOpacity="0"/></radialGradient>
    </defs>
    <g className="studio-rules" fill="none">
      <path d="M48 36h14m-7-7v14m245-7h14m-7-7v14M48 178h14m-7-7v14m245-7h14m-7-7v14M55 108h252" strokeDasharray="2 3"/>
      <circle cx="181" cy="108" r="73"/><circle cx="181" cy="108" r="88" strokeDasharray="2 5"/>
    </g>
    <g className="studio-signal" fill="none" strokeLinecap="round" strokeWidth="2">
      <path d="M68 105v6m9-10v14m9-22v30m9-26v22m9-31v40m9-26v12m9-19v26m9-32v38m9-26v14m9-30v46m9-27v8m46-9v10m9-23v36m9-35v34m9-22v10m9-27v44m9-30v16m9-34v52m9-40v28m9-23v18m9-15v12m9-9v6"/>
    </g>
    <ellipse cx="178" cy="187" rx="88" ry="16" fill="url(#mic-floor)"/>
    <g transform="rotate(23 180 108)">
      <rect x="155" y="27" width="50" height="153" rx="25" fill="url(#mic-shell)" stroke="#23272a"/>
      <rect x="157" y="29" width="46" height="77" rx="23" fill="url(#mic-metal)"/>
      <rect x="157" y="29" width="46" height="77" rx="23" fill="url(#mic-grid)" opacity=".81"/>
      <path d="M163 109h34m-33 3h32" stroke="#14171a" opacity=".64"/>
      <circle cx="180" cy="132" r="9" fill="#101418" stroke="#616870"/>
      <circle cx="180" cy="132" r="3" fill="#4b9fff"/>
      <path d="M170 157h20" stroke="#7d858c" strokeWidth="2" strokeLinecap="round" opacity=".7"/>
    </g>
  </svg>;
}
