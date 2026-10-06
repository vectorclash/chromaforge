import React from 'react';
import { SAFE_TOP, SAFE_BOTTOM } from './adComposer';

// A rough stand-in for what Instagram draws over a Reel -- header, the like/comment/share
// column, the caption and the audio line -- plus Meta's safe zone and the 3:4 crop a profile
// grid shows. Drawn over the preview only; never part of the export. Positions are approximate
// (they move between app versions and phones); the safe zone is the part to trust.
const W = 1080;
const H = 1920;
const INK = 'rgba(255,255,255,0.85)';

export default function InstagramOverlay() {
  const safeTop = SAFE_TOP * H;
  const safeBottom = (1 - SAFE_BOTTOM) * H;
  const side = 0.06 * W;
  const gridTop = (H - (W * 4) / 3) / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="ig-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="0" y={H * 0.68} width={W} height={H * 0.32} fill="url(#ig-shade)" />

      <text x="48" y="140" fill={INK} fontSize="58" fontWeight="700" fontFamily="system-ui, sans-serif">
        Reels
      </text>
      <rect x="950" y="92" width="82" height="62" rx="16" fill="none" stroke={INK} strokeWidth="6" />

      {[1190, 1340, 1490, 1640].map(y => (
        <g key={y}>
          <circle cx="1000" cy={y} r="34" fill="none" stroke={INK} strokeWidth="6" />
          <rect x="972" y={y + 52} width="56" height="16" rx="8" fill={INK} opacity="0.7" />
        </g>
      ))}
      <rect x="966" y="1760" width="68" height="68" rx="14" fill="none" stroke={INK} strokeWidth="6" />

      <circle cx="84" cy="1650" r="36" fill="none" stroke={INK} strokeWidth="6" />
      <rect x="138" y="1634" width="230" height="30" rx="15" fill={INK} />
      <rect x="388" y="1630" width="120" height="40" rx="12" fill="none" stroke={INK} strokeWidth="4" />
      <rect x="48" y="1712" width="760" height="24" rx="12" fill={INK} opacity="0.8" />
      <rect x="48" y="1752" width="520" height="24" rx="12" fill={INK} opacity="0.8" />
      <rect x="48" y="1806" width="420" height="22" rx="11" fill={INK} opacity="0.6" />

      <rect
        x={side}
        y={safeTop}
        width={W - 2 * side}
        height={safeBottom - safeTop}
        fill="none"
        stroke="#d1ff1a"
        strokeWidth="4"
        strokeDasharray="22 16"
      />
      <text x={side + 14} y={safeTop + 44} fill="#d1ff1a" fontSize="30" fontFamily="system-ui, sans-serif">
        safe zone
      </text>
      <rect x="2" y={gridTop} width={W - 4} height={(W * 4) / 3} fill="none" stroke="#7dd3fc" strokeWidth="3" strokeDasharray="8 14" />
      <text x={W - 20} y={gridTop - 14} textAnchor="end" fill="#7dd3fc" fontSize="28" fontFamily="system-ui, sans-serif">
        profile grid crop
      </text>
    </svg>
  );
}
