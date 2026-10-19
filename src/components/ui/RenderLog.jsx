import React, { useEffect, useState } from 'react';
import { renderLogEnabled, renderWorkerStatus, subscribeRenderLog } from '../../render/renderOffThread';

// A diagnostic readout for devices that misbehave where a test browser does not (2026-10-19:
// Aaron's iPhone and desktop browser stuttered on things headless Chromium and WebKit render
// smoothly). Off unless turned on: add ?renderlog=1 to any URL once (it is remembered), and
// ?renderlog=0 to turn it off. Shows each render -- size, queue priority, worker or page, how
// long it waited, where its time went -- and every frame over 50ms, all as times from the last
// tap, so a screenshot says what happened.
function readFlag() {
  try {
    const q = new URLSearchParams(window.location.search).get('renderlog');
    if (q === '1') localStorage.setItem('cf-debug:render', '1');
    if (q === '0') localStorage.removeItem('cf-debug:render');
  } catch {
    /* storage unavailable: stays off */
  }
  return renderLogEnabled();
}

export default function RenderLog() {
  const [on] = useState(readFlag);
  const [entries, setEntries] = useState([]);
  const [tapAt, setTapAt] = useState(null);
  const [stalls, setStalls] = useState([]);

  useEffect(() => {
    if (!on) return undefined;
    const unsub = subscribeRenderLog(log => setEntries(log.slice(-14)));
    const onTap = () => {
      setTapAt(performance.timeOrigin + performance.now());
      setStalls([]);
    };
    document.addEventListener('pointerdown', onTap, true);
    let last = 0;
    let raf = 0;
    const loop = t => {
      if (last && t - last > 50) {
        const at = performance.timeOrigin + t;
        const gap = Math.round(t - last);
        setStalls(s => [...s.slice(-11), { at, gap }]);
      }
      last = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      unsub();
      document.removeEventListener('pointerdown', onTap, true);
      cancelAnimationFrame(raf);
    };
  }, [on]);

  if (!on) return null;
  const rel = at => (tapAt ? `+${Math.round(at - tapAt)}` : Math.round(at % 100000));
  return (
    <div
      className="pointer-events-none fixed bottom-2 left-2 z-[9999] max-w-[calc(100vw-16px)] rounded bg-black/80 p-2 font-mono text-[9px] leading-tight text-lime-300"
      aria-hidden
    >
      <div>{renderWorkerStatus()} · times from last tap</div>
      {entries.map((e, i) => (
        <div key={i} className={e.path === 'worker' ? '' : 'text-amber-300'}>
          {rel(e.at)} {e.size} p{e.priority} {e.path} wait{e.wait} {e.phases} ={e.total}
        </div>
      ))}
      <div className="text-red-300">
        stalls &gt;50ms: {stalls.length ? stalls.map(s => `${rel(s.at)}:${s.gap}`).join(' ') : 'none'}
      </div>
    </div>
  );
}
