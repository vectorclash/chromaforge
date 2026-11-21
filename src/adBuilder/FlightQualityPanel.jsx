import React from 'react';

// The ad builder's Flight quality section (flightQuality.js): how the flight is rendered in every
// export. (Not FlightQuality.jsx: macOS's case-insensitive filesystem would resolve
// ./flightQuality to it -- the PostCopy/postText trap.)

function Choice({ value, options, onChange, label }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2 py-1 text-sm tabular-nums ${
            value === v ? 'bg-white/15 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-400">{label}</span>
      {children}
    </div>
  );
}

/** @param {{ value: { nebula: string, stars: string, blur: number }, onChange: (v: any) => void }} props */
export default function FlightQualityPanel({ value, onChange }) {
  const set = patch => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-2.5 text-sm">
      <p className="text-xs text-neutral-500">
        How the flight renders in every exported file and post. The preview keeps the site&rsquo;s flight so it
        plays in real time.
      </p>
      <Row label="Nebula">
        <Choice
          label="Nebula"
          value={value.nebula}
          onChange={nebula => set({ nebula })}
          options={[['site', 'Site'], ['high', 'High'], ['ultra', 'Ultra'], ['blender', 'New']]}
        />
      </Row>
      <Row label="Stars">
        <Choice
          label="Stars"
          value={value.stars}
          onChange={stars => set({ stars })}
          options={[['site', 'Site'], ['more', 'More'], ['deep', 'More + deep']]}
        />
      </Row>
      <div>
        <Row label="Flight blur">
          <Choice
            label="Flight motion blur"
            value={value.blur}
            onChange={blur => set({ blur })}
            options={[[0, 'Off'], [90, '90°'], [180, '180°']]}
          />
        </Row>
        <p className="mt-1 text-xs text-neutral-500">
          For the Reel, the Flight mode, feed flight clips and the stock master. The Explainer has its own
          motion blur.
        </p>
      </div>
    </div>
  );
}
