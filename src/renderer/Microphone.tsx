import { useEffect, useRef, useState } from 'react';
import { audioConstraints, meterLevel, micError, monitorMic } from './capture';
import { Icon, permissionLabel } from './presentation';

export function Microphone({ status, deviceId, active, onPermission, onDevice }: {
  status: string; deviceId: string; active: boolean; onPermission(): Promise<unknown>; onDevice?: (id: string) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [feedback, setFeedback] = useState('');
  const stopTest = useRef<() => void>(() => {});
  const refresh = async () => {
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')); }
    catch { setDevices([]); }
  };
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
      stopTest.current();
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    stopTest.current();
    setTesting(false);
    setLevel(0);
  }, [active]);

  async function testMic() {
    if (testing || active) return;
    setLevel(0);
    setTesting(true);
    setFeedback('');
    let terminated = false;
    let stream: MediaStream | undefined;
    let meter: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      terminated = true;
      clearTimeout(timer);
      meter?.();
      stream?.getTracks().forEach((track) => track.stop());
    };
    stopTest.current = stop;
    function finish(message: string) {
      stop();
      setTesting(false);
      setLevel(0);
      setFeedback(message);
    }
    try {
      await onPermission();
      if (terminated) return;
      stream = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
      if (terminated) { stop(); return; }
      let signal = false;
      meter = monitorMic(stream, (rms) => {
        signal ||= rms >= 0.0006;
        setLevel(meterLevel(rms));
      });
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => finish('마이크 연결이 끊어졌습니다.'), { once: true }));
      void refresh();
      timer = setTimeout(() => finish(signal ? '마이크 입력을 확인했습니다.' : '입력 신호가 감지되지 않았습니다. 마이크를 확인해 주세요.'), 3500);
    } catch (error) {
      if (terminated) return;
      const reason = micError(error);
      finish(reason === 'permission' ? '시스템 설정에서 마이크 접근을 허용해 주세요.' : '선택한 마이크에 접근할 수 없습니다. 연결과 권한을 확인해 주세요.');
    }
  }

  return <section className="panel permission" aria-labelledby="mic-heading">
    <div className="panel-heading"><span className="panel-icon"><Icon name="mic"/></span><div><h2 id="mic-heading">마이크 권한</h2><p>목소리가 들어오는지 확인하세요.</p></div><span className="status-badge">{permissionLabel[status] ?? '확인 필요'}</span></div>
    {onDevice && <label className="field">사용할 마이크<select value={deviceId} onChange={(event) => onDevice(event.target.value)} disabled={testing || active}>
      <option value="">시스템 기본 마이크</option>
      {deviceId && !devices.some((device) => device.deviceId === deviceId) && <option value={deviceId}>현재 선택한 마이크 (확인 필요)</option>}
      {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `마이크 ${index + 1}`}</option>)}
    </select></label>}
    <div className="button-row mic-test">
      <button type="button" className="button secondary" disabled={active} onClick={() => testing ? (stopTest.current(), setTesting(false), setLevel(0)) : void testMic()}>{testing ? '마이크 테스트 종료' : '마이크 테스트'}</button>
      {testing && <meter min={0} max={100} value={level} aria-label="마이크 테스트 입력 신호"/>}
      {!testing && feedback && <small role="status">{feedback}</small>}
    </div>
  </section>;
}
