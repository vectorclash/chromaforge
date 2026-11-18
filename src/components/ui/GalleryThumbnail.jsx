import React, { useEffect, useMemo, useRef, useState } from 'react';
import FadeImage, { THUMBNAIL_RETRIES } from './FadeImage';
import { requestSlot, watchNear, alreadyFetched } from '../../utils/thumbnailQueue';
import { getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';
import { useStudio } from '../../context/StudioContext';

// A gallery card's image. If it never loads (after FadeImage's own retries, which cover Storage
// refusing a burst of requests), the image hides as it always did -- unless the person looking at
// it is the design's owner, whose browser then makes the thumbnail again and shows it. A save
// whose thumbnail failed, or whose tab closed before the upload, is therefore fixed the next time
// its owner sees it (2026-10-28, a 3D save that came back with no thumbnail).
//
// The browser cannot tell a missing file from a refused one (an <img> error is an error), so a
// card ASKS Storage before repairing (2026-11-18): a burst of 429s once had the owner's browser
// re-render and re-upload a thumbnail that was there all along. Present, or refused, or
// unreachable: the card just tries to show it again a little later. Only a definite not-found
// (Storage answers a missing public object with 400 or 404) is repaired.
const RECHECK_MS = 20000;
const MAX_RECHECKS = 3;

async function thumbnailExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return 'present';
    if (res.status === 400 || res.status === 404) return 'missing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export default function GalleryThumbnail({ design, className }) {
  const { user } = useAuth();
  const { repairThumbnail } = useStudio();
  const [missing, setMissing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  // Bumped after a repair, so the card asks for the new file instead of the cached failure
  const [version, setVersion] = useState(0);

  const base = getThumbnailUrl(design.user_id, design.id);
  const src = version ? `${base}?v=${version}` : base;

  // Paced loading (utils/thumbnailQueue.js): the card asks for its image only once it is near the
  // screen, and only when one of a few request slots is free. A thumbnail this page has already
  // fetched skips all of it -- the preloaded first screen, or a card seen earlier in the visit.
  const cached = useMemo(() => alreadyFetched(base), [base]);
  const [granted, setGranted] = useState(cached);
  const probeRef = useRef(null);
  const releaseRef = useRef(null);
  useEffect(() => {
    if (cached) {
      setGranted(true);
      return undefined;
    }
    setGranted(false);
    const box = probeRef.current?.parentElement;
    if (!box) {
      setGranted(true);
      return undefined;
    }
    let cancel = null;
    let unwatch = null;
    unwatch = watchNear(box, near => {
      if (near && !cancel) {
        cancel = requestSlot(box, release => {
          releaseRef.current = release;
          // Granted: stop watching. A card scrolled away mid-request keeps its slot until the
          // request settles -- the bytes are already on their way.
          unwatch?.();
          unwatch = null;
          setGranted(true);
        });
      } else if (!near && cancel && !releaseRef.current) {
        // Flicked past before its turn came: leave the queue without ever asking.
        cancel();
        cancel = null;
      }
    });
    return () => {
      unwatch?.();
      cancel?.();
      releaseRef.current = null;
    };
  }, [base, cached]);
  const onAttempt = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  const rechecks = useRef(0);
  const repaired = useRef(false); // one repair per card, ever
  const recheckTimer = useRef(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(recheckTimer.current);
    },
    []
  );

  // Show the file again (a new URL, so not the cached failure), a little later.
  const showAgain = () => {
    if (rechecks.current >= MAX_RECHECKS) return;
    rechecks.current += 1;
    recheckTimer.current = setTimeout(() => {
      if (!mounted.current) return;
      setMissing(false);
      setVersion(Date.now());
    }, RECHECK_MS * (0.75 + Math.random() * 0.5));
  };

  const onError = async () => {
    setMissing(true);
    if (repairing) return;
    const state = await thumbnailExists(base);
    if (!mounted.current) return;
    if (state !== 'missing') {
      showAgain();
      return;
    }
    if (repaired.current || !user || design.user_id !== user.id) return;
    repaired.current = true;
    setRepairing(true);
    repairThumbnail(design).then(ok => {
      if (!mounted.current) return;
      setRepairing(false);
      if (!ok) return;
      setMissing(false);
      setVersion(Date.now());
    });
  };

  return (
    <>
      <span ref={probeRef} hidden />
      <FadeImage
        src={granted ? src : null}
        onAttempt={onAttempt}
        alt={design.title || 'Untitled design'}
        retries={THUMBNAIL_RETRIES}
        onError={onError}
        className={className}
        style={missing ? { visibility: 'hidden' } : undefined}
      />
      {repairing && <div className="absolute inset-0 animate-pulse bg-ink-700" />}
    </>
  );
}
