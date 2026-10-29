import React, { useState } from 'react';
import FadeImage, { THUMBNAIL_RETRIES } from './FadeImage';
import { getThumbnailUrl } from '../../lib/designs';
import { useAuth } from '../../context/AuthContext';
import { useStudio } from '../../context/StudioContext';

// A gallery card's image. If it never loads (after FadeImage's own retries, which cover Storage
// refusing a burst of requests), the image hides as it always did -- unless the person looking at
// it is the design's owner, whose browser then makes the thumbnail again and shows it. A save
// whose thumbnail failed, or whose tab closed before the upload, is therefore fixed the next time
// its owner sees it (2026-10-28, a 3D save that came back with no thumbnail).
export default function GalleryThumbnail({ design, className }) {
  const { user } = useAuth();
  const { repairThumbnail } = useStudio();
  const [missing, setMissing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  // Bumped after a repair, so the card asks for the new file instead of the cached failure
  const [version, setVersion] = useState(0);

  const base = getThumbnailUrl(design.user_id, design.id);
  const src = version ? `${base}?v=${version}` : base;

  const onError = () => {
    setMissing(true);
    if (repairing || version || !user || design.user_id !== user.id) return;
    setRepairing(true);
    repairThumbnail(design).then(ok => {
      setRepairing(false);
      if (!ok) return;
      setMissing(false);
      setVersion(Date.now());
    });
  };

  return (
    <>
      <FadeImage
        src={src}
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
