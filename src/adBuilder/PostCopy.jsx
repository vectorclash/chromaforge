import React, { useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button';
import { copyText } from '../utils/clipboard';
import { HASHTAG_SETS, captionFor, designLink, fullCaption, shopLink, tagLine } from './postText';

// The caption follows the ad (design name, products; the garment's credit in the explainer) until it is typed into; from then on it is
// the typed text, saved with the ad, until Reset hands it back to the ad.
// `catalog` is every product ({ id, title }); `adProductIds` the ones this ad shows, offered first.
export default function PostCopy({ design, productNames, captionOpts, post, onChange, catalog = [], adProductIds = [] }) {
  const [copied, setCopied] = useState(null); // 'caption' | 'link' | 'shop' | null
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const auto = captionFor(design, productNames, captionOpts);
  const caption = post.caption ?? auto;
  const set = HASHTAG_SETS.find(s => s.id === post.tagSet) ?? HASHTAG_SETS[0];
  const link = designLink(design);
  // The shop link's target: what was picked for this ad, else its first product, else the shop.
  const target = post.linkTarget ?? adProductIds[0] ?? 'shop';
  const shopUrl = shopLink(design, target);
  const nameOf = p => p.title.replace(/^All-Over Print\s*/, '');
  const adProducts = adProductIds.map(id => catalog.find(c => c.id === id)).filter(Boolean);
  const otherProducts = catalog.filter(c => !adProductIds.includes(c.id));

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
        <Button size="sm" variant="ghost" onClick={() => copy('caption', fullCaption(post, design, productNames, captionOpts))}>
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

      {/* For the paid ad made from this Reel later: its Shop Now link, landing on the shop or a
          product already wearing this design. */}
      <p className="mb-1.5 mt-4 text-xs text-neutral-500">Shop link · for the ad's Shop Now button</p>
      <div className="flex items-center gap-2">
        <select
          value={String(target)}
          onChange={e => onChange({ ...post, linkTarget: e.target.value === 'shop' ? 'shop' : Number(e.target.value) })}
          aria-label="Shop link goes to"
          className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-2 py-1.5 text-sm"
        >
          <option value="shop">The shop (every product)</option>
          {adProducts.length > 0 && (
            <optgroup label="In this ad">
              {adProducts.map(p => (
                <option key={p.id} value={p.id}>
                  {nameOf(p)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={adProducts.length ? 'Other products' : 'Products'}>
            {otherProducts.map(p => (
              <option key={p.id} value={p.id}>
                {nameOf(p)}
              </option>
            ))}
          </optgroup>
        </select>
        <Button size="sm" variant="ghost" onClick={() => copy('shop', shopUrl)} disabled={!design?.id}>
          {copied === 'shop' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <input
        readOnly
        value={shopUrl}
        onFocus={e => e.target.select()}
        aria-label="Shop link"
        className="mt-1.5 w-full rounded-md border border-white/10 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-300"
      />
      {!design?.id && (
        <p className="mt-1 text-xs text-amber-400">Save this design first: only a saved design can be linked.</p>
      )}
    </>
  );
}
