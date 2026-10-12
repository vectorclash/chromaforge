import React from 'react';
import Button from '../components/ui/Button';
import {
  MAX_SLIDES,
  SLIDE_LABELS,
  everyAngleSlides,
  singlePhotoSlides,
  makeSlide
} from './feedPost';

// The slides of a feed post, in order. Photos come from the products above; the rest are made
// from the design. Two starting points match the two shapes of post: every angle (a carousel) and
// a single photo standing in its own artwork (one image).
export default function FeedSlides({ slides, onChange, photos, labelOf, index, onSelect }) {
  const full = slides.length >= MAX_SLIDES;
  const move = (i, d) => {
    const next = [...slides];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
    onSelect(i + d);
  };
  const remove = i => {
    onChange(slides.filter((_, k) => k !== i));
    onSelect(Math.max(0, Math.min(index, slides.length - 2)));
  };
  const add = s => {
    onChange([...slides, s]);
    onSelect(slides.length);
  };
  const urls = photos.map(p => p.url);

  return (
    <>
      <p className="mb-1.5 text-xs text-neutral-500">Start from</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (onChange(everyAngleSlides(urls)), onSelect(0))}
        >
          Every angle
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (onChange(singlePhotoSlides(urls[0])), onSelect(0))}
          title="One photo set into its own artwork, posted as a single image"
        >
          One photo
        </Button>
      </div>

      <ol className="mt-3 flex flex-col gap-1">
        {slides.map((s, i) => (
          <li
            key={s.id}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              i === index ? 'bg-white/10 text-white' : 'text-neutral-300 hover:bg-white/5'
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => onSelect(i)}
            >
              <span className="mr-2 inline-block w-4 text-right tabular-nums text-neutral-500">
                {i + 1}
              </span>
              {s.type === 'photo' ? labelOf(s.url) : SLIDE_LABELS[s.type]}
              {s.type === 'flight' && <span className="text-neutral-500"> · video</span>}
            </button>
            <button
              type="button"
              aria-label="Move up"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              className="px-1 text-neutral-500 hover:text-white disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Move down"
              disabled={i === slides.length - 1}
              onClick={() => move(i, 1)}
              className="px-1 text-neutral-500 hover:text-white disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label="Remove slide"
              onClick={() => remove(i)}
              className="px-1 text-neutral-500 hover:text-red-300"
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {!slides.length && <p className="text-xs text-neutral-500">No slides yet.</p>}

      <p className="mb-1.5 mt-4 text-xs text-neutral-500">
        Add a slide{' '}
        {full && <span className="text-amber-300/90">· Instagram takes at most {MAX_SLIDES}</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {['art', 'macro', 'flight', 'seed'].map(type => (
          <button
            key={type}
            type="button"
            disabled={full}
            onClick={() => add(makeSlide(type))}
            className="rounded-md bg-white/5 px-2.5 py-1 text-sm text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            + {SLIDE_LABELS[type]}
          </button>
        ))}
      </div>
      {photos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {photos.map(p => (
            <button
              key={p.url}
              type="button"
              disabled={full}
              onClick={() => add(makeSlide('photo', p.url))}
              title={`Add ${labelOf(p.url)}`}
              className="h-14 w-14 overflow-hidden rounded bg-neutral-800 ring-1 ring-white/10 hover:ring-white/40 disabled:opacity-40"
            >
              <img src={p.url} alt="" className="h-full w-full object-contain" />
            </button>
          ))}
        </div>
      )}
      {!photos.length && (
        <p className="mt-2 text-xs text-neutral-500">
          Product photos chosen above can be added as slides.
        </p>
      )}
    </>
  );
}
