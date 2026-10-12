import React, { useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button';
import { copyText } from '../utils/clipboard';
import { HASHTAG_SETS, captionFor, designLink, fullCaption, tagLine } from './postText';

// The caption follows the ad (design name, products) until it is typed into; from then on it is
// the typed text, saved with the ad, until Reset hands it back to the ad.
export default function PostCopy({ design, productNames, post, onChange }) {
  const [copied, setCopied] = useState(null); // 'caption' | 'link' | null
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const auto = captionFor(design, productNames);
  const caption = post.caption ?? auto;
  const set = HASHTAG_SETS.find(s => s.id === post.tagSet) ?? HASHTAG_SETS[0];
  const link = designLink(design);

  const copy = async (what, text) => {
    if (!(await copyText(text))) return;
    setCopied(what);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <textarea
        value={caption}
        onChange={e => onChange({ ...post, caption: e.target.value })}
        rows={5}
        aria-label="Caption"
        className="w-full resize-y rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
      />
      {post.caption !== null && post.caption !== auto && (
        <button
          type="button"
          onClick={() => onChange({ ...post, caption: null })}
          className="mt-1 text-xs text-neutral-500 hover:text-white"
        >
          Reset to the ad&rsquo;s caption
        </button>
      )}

      {/* The sets by name; only the chosen one's tags are spelled out, once, underneath. */}
      <p className="mb-1.5 mt-4 text-xs text-neutral-500">
        Hashtags · one set, since Instagram allows 5 per post (caption and first comment together)
      </p>
      <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Hashtags">
        {HASHTAG_SETS.map(s => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={s.id === set.id}
            onClick={() => onChange({ ...post, tagSet: s.id })}
            title={s.hint}
            className={`rounded-md px-2.5 py-1.5 text-left text-sm ${
              s.id === set.id ? 'bg-white/15 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-neutral-400">{tagLine(set)}</p>
      <p className="mt-1 text-xs text-neutral-500">{set.hint}</p>

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => copy('caption', fullCaption(post, design, productNames))}>
          {copied === 'caption' ? 'Copied' : 'Copy caption'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => copy('link', link)}
          title="For a Story link sticker or the bio. Links in a Reel caption aren't clickable."
        >
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p className="mt-2 truncate text-xs text-neutral-500">{link}</p>
    </>
  );
}
