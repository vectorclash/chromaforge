import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import ConfirmDialog from '../components/ui/ConfirmDialog';

// Posts the ad as a Reel to @chromaforge.app through the dev server (scripts/ad-builder-
// instagram.mjs), which holds the token and does the uploading. The cover is the frame under the
// playhead, as with the Cover button.

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

const when = iso =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

function Row({ label, hint, on, onToggle, disabled }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm">{label}</p>
        <p className="text-xs text-neutral-500">{hint}</p>
      </div>
      <Toggle on={on} onClick={onToggle} disabled={disabled} aria-label={label} />
    </div>
  );
}

export default function InstagramPost({
  canPost,
  caption,
  posted,
  buildFiles,
  onPosted,
  progress,
  durationSec
}) {
  const [setup, setSetup] = useState(null); // the dev server's status answer
  const [shareToFeed, setShareToFeed] = useState(true);
  const [trial, setTrial] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stage, setStage] = useState(null); // null | text while a post is under way
  const [result, setResult] = useState(null); // { error } | { permalink, note? }
  const alive = useRef(true);
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
  const tooShort = durationSec < 3; // Instagram's Reel minimum

  const post = async () => {
    setConfirming(false);
    setResult(null);
    try {
      setStage('Rendering for Instagram');
      const files = await buildFiles();
      setStage('Handing the files to the dev server');
      const [video, cover] = [await sendFile(files.video), await sendFile(files.cover)];
      const { job } = await api('/__ads/instagram/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video, cover, caption, shareToFeed, trial })
      });
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        const j = await api(`/__ads/instagram/jobs/${job}`);
        if (!alive.current) return;
        setStage(j.stage);
        if (!j.done) continue;
        if (j.error) throw new Error(j.error);
        await onPosted({
          at: new Date().toISOString(),
          permalink: j.permalink,
          mediaId: j.mediaId,
          trial
        });
        setResult({ permalink: j.permalink, note: j.cleanupError });
        check();
        break;
      }
    } catch (e) {
      if (alive.current) setResult({ error: e.message });
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
            <li>Instagram refused the token: {setup.error || 'unknown error'}</li>
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

      <div className="mt-3 flex items-center gap-2">
        <Button
          disabled={!ready || !canPost || !!stage || tooLong || tooShort}
          onClick={() => setConfirming(true)}
        >
          {stage ? 'Posting…' : 'Post Reel'}
        </Button>
        <span className="text-xs text-neutral-500">Cover: the frame under the playhead.</span>
      </div>
      {tooShort && (
        <p className="mt-2 text-xs text-red-300">
          Instagram needs a Reel of at least 3 seconds; this one is {durationSec.toFixed(1)}s.
        </p>
      )}
      {tooLong && (
        <p className="mt-2 text-xs text-red-300">Over Instagram&rsquo;s 2,200-character limit.</p>
      )}
      {stage && (
        <p className="mt-2 text-xs text-neutral-300">
          {progress
            ? `${progress.label} ${progress.progress > 0 ? `${Math.round(progress.progress * 100)}%` : ''}`
            : `${stage}…`}
        </p>
      )}
      {result?.error && <p className="mt-2 text-xs text-red-300">Not posted: {result.error}</p>}
      {result && !result.error && (
        <p className="mt-2 text-xs text-neutral-300">
          Published.{' '}
          {result.permalink && (
            <a
              href={result.permalink}
              target="_blank"
              rel="noreferrer"
              className="text-[#d1ff1a] underline"
            >
              Open it on Instagram
            </a>
          )}
          {result.note && <span className="block text-amber-300/90">{result.note}</span>}
        </p>
      )}

      {posted.length > 0 && (
        <ul className="mt-3 text-xs text-neutral-500">
          {posted.map(p => (
            <li key={p.at}>
              Posted {when(p.at)}
              {p.trial && ' as a trial'}
              {p.permalink && (
                <>
                  {' · '}
                  <a
                    href={p.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-white"
                  >
                    link
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirming}
        title="Post this Reel?"
        message={
          posted.length
            ? 'This ad has been posted before. It goes out publicly to @chromaforge.app again, and can only be deleted from the app.'
            : 'It goes out publicly to @chromaforge.app, and can only be deleted from the app.'
        }
        confirmLabel="Post"
        onConfirm={post}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
