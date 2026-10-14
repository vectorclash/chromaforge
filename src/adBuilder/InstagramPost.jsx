import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import ConfirmDialog from '../components/ui/ConfirmDialog';

// Posts to @chromaforge.app through the dev server (scripts/ad-builder-instagram.mjs), which holds
// the token and does the uploading: a Reel (whose cover is the frame under the playhead, as with
// the Cover button), or a feed post -- one image, or a carousel of images and videos.
//
// `buildFiles` returns { video, cover } for a Reel, or { items: [{ type, blob }] } for a feed post.

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const sendFile = async blob =>
  (
    await api('/__ads/instagram/file', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob
    })
  ).id;

// Where a new token is made: the Chromaforge Poster app's Instagram API setup page. Linked whenever
// Instagram says the problem is the token or the app's access rather than the post.
const DEVELOPER_DASHBOARD = 'https://developers.facebook.com/apps/';

const DashboardLink = () => (
  <a
    href={DEVELOPER_DASHBOARD}
    target="_blank"
    rel="noreferrer"
    className="underline underline-offset-2 hover:text-white"
  >
    Open the Meta developer dashboard
  </a>
);

const when = iso =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

const NOUN = { reel: 'Reel', image: 'image', carousel: 'carousel' };

const TONES = {
  neutral: 'border-white/15 bg-white/5',
  success: 'border-[#d1ff1a]/50 bg-[#d1ff1a]/10',
  error: 'border-red-400/40 bg-red-500/10 text-red-200'
};

function Card({ tone = 'neutral', children, cardRef = undefined }) {
  return (
    <div
      ref={cardRef}
      className={`mt-4 animate-fade-in rounded-lg border p-3 text-sm ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}

function Row({ label, hint, on, onToggle, disabled }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm">{label}</p>
        <p className="text-xs text-neutral-500">{hint}</p>
      </div>
      <Toggle
        className="shrink-0"
        on={on}
        onClick={onToggle}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

export default function InstagramPost({
  kind = 'reel',
  blocked = null,
  canPost,
  caption,
  posted,
  buildFiles,
  onPosted,
  progress,
  durationSec,
  coverNote = 'The cover is the frame under the playhead.'
}) {
  const [setup, setSetup] = useState(null); // the dev server's status answer
  const [shareToFeed, setShareToFeed] = useState(true);
  const [trial, setTrial] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stage, setStage] = useState(null); // null | text while a post is under way
  const [result, setResult] = useState(null); // { error, authError? } | { permalink, note? }
  const alive = useRef(true);
  // The progress card while a post is under way, then the result card: each is scrolled into view
  // as it appears, since Post sits at the bottom of a long panel and the work takes minutes.
  const stageCard = useRef(null);
  const resultCard = useRef(null);
  const posting = !!stage;
  useEffect(() => {
    if (posting) stageCard.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [posting]);
  useEffect(() => {
    if (result) resultCard.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [result]);
  // Set on mount as well as cleared on unmount: StrictMode unmounts and remounts once in dev.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const check = useCallback(() => {
    setSetup(null);
    api('/__ads/instagram/status')
      .then(s => alive.current && setSetup(s))
      .catch(e => alive.current && setSetup({ error: e.message }));
  }, []);
  useEffect(check, [check]);

  const ready = setup?.account && setup.sshKey;
  const tooLong = caption.length > 2200;
  const tooShort = kind === 'reel' && durationSec < 3; // Instagram's Reel minimum

  const post = async () => {
    setConfirming(false);
    setResult(null);
    try {
      setStage('Rendering for Instagram');
      const files = await buildFiles();
      setStage('Handing the files to the dev server');
      let body;
      if (files.items) {
        const items = [];
        for (const it of files.items) items.push({ type: it.type, id: await sendFile(it.blob) });
        body = { items, caption };
      } else {
        const video = await sendFile(files.video);
        // A cover is optional: without one Instagram uses the video's first frame.
        const cover = files.cover ? await sendFile(files.cover) : undefined;
        body = { video, cover, caption, shareToFeed, trial };
      }
      const { job } = await api('/__ads/instagram/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        const j = await api(`/__ads/instagram/jobs/${job}`);
        if (!alive.current) return;
        setStage(j.stage);
        if (!j.done) continue;
        if (j.error) throw Object.assign(new Error(j.error), { authError: j.authError });
        await onPosted({
          at: new Date().toISOString(),
          permalink: j.permalink,
          mediaId: j.mediaId,
          kind,
          trial: kind === 'reel' && trial
        });
        setResult({ permalink: j.permalink, note: j.cleanupError });
        check();
        break;
      }
    } catch (e) {
      if (alive.current) setResult({ error: e.message, authError: !!e.authError });
    } finally {
      if (alive.current) setStage(null);
    }
  };

  return (
    <div className="mt-5 border-t border-white/10 pt-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">Post to Instagram</h3>
        <button type="button" onClick={check} className="text-xs text-neutral-500 hover:text-white">
          {setup ? 'Check again' : 'Checking…'}
        </button>
      </div>

      {setup && !ready && (
        <ul className="mt-2 list-disc pl-4 text-xs text-amber-300/90">
          {!setup.token && <li>Add INSTAGRAM_ACCESS_TOKEN to .env.local, then Check again.</li>}
          {setup.token && !setup.account && (
            <li>
              Instagram refused the token: {setup.error || 'unknown error'} <DashboardLink />
            </li>
          )}
          {!setup.sshKey && <li>No SSH key at {setup.sshKeyPath}.</li>}
          {!setup.token && setup.error && <li>{setup.error}</li>}
        </ul>
      )}
      {ready && (
        <p className="mt-1 text-xs text-neutral-500">
          As @{setup.account}
          {setup.quota &&
            ` · ${setup.quota.used} of ${setup.quota.total} API posts used in the last 24h`}
        </p>
      )}

      {kind === 'reel' && (
        <div className="mt-3 flex flex-col gap-3">
          <Row
            label="Also show in the grid"
            hint="Off keeps it in the Reels tab only."
            on={shareToFeed}
            onToggle={() => setShareToFeed(v => !v)}
            disabled={!!stage}
          />
          <Row
            label="Trial reel"
            hint="Shown to non-followers first, then shared to followers if it does well."
            on={trial}
            onToggle={() => setTrial(v => !v)}
            disabled={!!stage}
          />
        </div>
      )}

      <div className="mt-4">
        <Button
          className="w-full"
          disabled={!ready || !canPost || !!stage || tooLong || tooShort || !!blocked}
          onClick={() => setConfirming(true)}
        >
          {stage ? 'Posting…' : `Post ${NOUN[kind]}`}
        </Button>
        {kind === 'reel' && (
          <p className="mt-2 text-center text-xs text-neutral-500">{coverNote}</p>
        )}
      </div>
      {blocked && <Card tone="error">{blocked}</Card>}
      {tooShort && (
        <Card tone="error">
          Instagram needs a Reel of at least 3 seconds; this one is {durationSec.toFixed(1)}s.
        </Card>
      )}
      {tooLong && (
        <Card tone="error">The caption is over Instagram&rsquo;s 2,200-character limit.</Card>
      )}

      {stage && (
        <Card cardRef={stageCard}>
          <p className="text-sm text-white">{progress ? progress.label : stage}</p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
            {progress && progress.progress > 0 ? (
              <div
                className="h-full rounded-full bg-[#d1ff1a] transition-[width] duration-300"
                style={{ width: `${Math.round(progress.progress * 100)}%` }}
              />
            ) : (
              <div className="h-full w-full animate-pulse rounded-full bg-[#d1ff1a]/50" />
            )}
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Usually 1&ndash;3 minutes. Keep this tab open.
          </p>
        </Card>
      )}
      {result?.error && (
        <Card tone="error" cardRef={resultCard}>
          <p className="text-sm font-semibold">Not posted</p>
          <p className="mt-1 text-xs">{result.error}</p>
          {result.authError && (
            <p className="mt-1 text-xs">
              <DashboardLink />
            </p>
          )}
        </Card>
      )}
      {result && !result.error && (
        <Card tone="success" cardRef={resultCard}>
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <span
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d1ff1a] text-xs text-black"
            >
              ✓
            </span>
            Published to @{setup?.account || 'chromaforge.app'}
          </p>
          {result.permalink && (
            <a
              href={result.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded-md bg-[#d1ff1a] px-3 py-1.5 text-sm font-semibold text-black hover:bg-white"
            >
              Open on Instagram ↗
            </a>
          )}
          {result.note && <p className="mt-2 text-xs text-amber-300/90">{result.note}</p>}
        </Card>
      )}

      {posted.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
            Posted from this ad
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {[...posted].reverse().map(p => (
              <li key={p.at} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-neutral-300">
                  {when(p.at)}
                  {p.kind && p.kind !== 'reel' && (
                    <span className="text-neutral-500"> · {p.kind}</span>
                  )}
                  {p.trial && <span className="text-neutral-500"> · trial</span>}
                </span>
                {p.permalink && (
                  <a
                    href={p.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-neutral-400 underline hover:text-white"
                  >
                    View ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* On the body, not in place: the builder's panel has will-change: transform (see
          AdBuilder), which makes it the containing block of anything fixed inside it. In place,
          the "full-screen" dialog sat at the top of the panel's scrolled content, and its
          autofocused button scrolled the panel up to it -- the jump back to the top on Post. */}
      {createPortal(
        <ConfirmDialog
          open={confirming}
          title={`Post this ${NOUN[kind]}?`}
          message={
            posted.length
              ? 'This has been posted before. It goes out publicly to @chromaforge.app again, and can only be deleted from the app.'
              : 'It goes out publicly to @chromaforge.app, and can only be deleted from the app.'
          }
          confirmLabel="Post"
          onConfirm={post}
          onCancel={() => setConfirming(false)}
        />,
        document.body
      )}
    </div>
  );
}
