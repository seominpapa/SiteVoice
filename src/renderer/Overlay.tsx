import { useEffect, useState } from 'react';
import type { OverlayAction, State } from '../shared';
import { browserRecorder, Capture, monitorMic } from './capture';
import { Icon, isActive, phaseLabel } from './presentation';

export function Overlay() {
  const [state, setState] = useState<State>({ phase: 'idle', id: 0 });
  const [level, setLevel] = useState(0);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  useEffect(() => {
    const capture = new Capture({
      stream: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      recorder: browserRecorder,
      meter: monitorMic,
      audio: (id, bytes, mime) => { void window.voice.audio(id, bytes, mime).catch(() => setError(true)); },
      error: (id, reason) => { void window.voice.recordingError(id, reason).catch(() => setError(true)); },
      level: setLevel,
      input: setConnected,
      timeout: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    });
    const unsubscribeState = window.voice.onState((value) => {
      setError(false);
      setState(value);
      setNow(Date.now());
    });
    const unsubscribeRecording = window.voice.onRecording(({ id, command, microphoneId }) => {
      if (command === 'start') void capture.start(id, microphoneId);
      if (command === 'stop') capture.stop(id);
      if (command === 'release') capture.release(id);
    });
    const release = () => capture.release();
    window.addEventListener('pagehide', release);
    void window.voice.ready().catch(() => setError(true));
    return () => {
      unsubscribeState();
      unsubscribeRecording();
      window.removeEventListener('pagehide', release);
      release();
    };
  }, []);
  const recording = state.phase === 'recording';
  const active = isActive(state.phase);
  const copyText = state.phase === 'copy' ? state.cleaned : undefined;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [recording]);
  const seconds = Math.max(0, Math.floor((now - (state.startedAt ?? now)) / 1000));
  const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const action = (value: OverlayAction) => {
    void window.voice.overlayAction(value, state.id).then(() => setError(false)).catch(() => setError(true));
  };
  if (copyText) return <main className={`overlay ${state.reviewNote ? 'overlay-review' : ''}`} data-testid="capture-overlay" aria-label="받아쓴 결과">
    <span className="overlay-icon"><Icon name="result" size={20}/></span>
    <div className="overlay-status">
      <strong role="status">{error ? '결과를 복사할 수 없습니다' : state.reviewNote ?? '붙여넣기 대신 복사'}</strong>
      <p className="overlay-transcript">{copyText}</p>
    </div>
    <div className="overlay-actions">
      <button type="button" className="button primary overlay-copy" aria-label="복사하기" title="복사하기" onClick={() => action('copyResult')}><Icon name="copy" size={23}/></button>
      <button type="button" className="button icon-button" aria-label="표시창 닫기" title="표시창 닫기" onClick={() => action('closeResult')}><Icon name="close" size={18}/></button>
    </div>
  </main>;
  return <main className="overlay" data-testid="capture-overlay" aria-label="음성 입력 상태">
    <span className="overlay-icon"><Icon name={recording ? 'mic' : 'setup'} size={20}/></span>
    <div className="overlay-status"><strong role="status">{error ? '앱 연결에 문제가 있어요' : phaseLabel[state.phase]}</strong><small>{recording ? connected ? '마이크 연결됨' : '마이크 연결 중' : state.phase === 'pasting' ? '원래 입력 칸을 확인합니다' : active ? '잠시만 기다려 주세요' : '결과는 앱에서 확인하세요'}</small></div>
    {recording && <div className="live-signal"><span className="mini-meter" role="meter" aria-label="마이크 입력 신호" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
      {[4, 10, 15, 22, 28, 20, 14, 8, 4].map((height, i) => <i key={i} style={{ height, opacity: level >= i * 11 + 1 ? 1 : 0.24 }}/>)}</span><time>{timestamp}</time></div>}
    <div className="overlay-actions">
      {recording && <button type="button" className="button primary" onClick={() => action('stop')}><Icon name="stop" size={15}/>녹음 종료</button>}
      {active && state.phase !== 'pasting' && <button type="button" className="button icon-button" aria-label="취소" title="취소" onClick={() => action('cancel')}><Icon name="close" size={18}/></button>}
    </div>
  </main>;
}
