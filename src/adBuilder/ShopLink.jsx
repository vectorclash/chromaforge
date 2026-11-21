import React, { useEffect, useRef, useState } from 'react';
import Button from '../components/ui/Button';
import { copyText } from '../utils/clipboard';
import { shopLink } from './postText';

// A link to the store, opening already wearing the chosen design (`?id=`, lib/linkedDesign.js): the
// shop, or one product page. For an ad's Shop Now button. The target is saved with the ad
// (`post.linkTarget`); `adProductIds` (the products this ad shows) are offered first, and the first
// of them is the default.
export default function ShopLink({ design, post, onChange, catalog = [], adProductIds = [] }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const target = post.linkTarget ?? adProductIds[0] ?? 'shop';
  const url = shopLink(design, target);
  const linkable = Boolean(design?.id);
  const nameOf = p => p.title.replace(/^All-Over Print\s*/, '');
  const adProducts = adProductIds.map(id => catalog.find(c => c.id === id)).filter(Boolean);
  const otherProducts = catalog.filter(c => !adProductIds.includes(c.id));

  const copy = async () => {
    if (!(await copyText(url))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-4">
      <p className="mb-1.5 text-xs text-neutral-500">Store link · opens wearing this design</p>
      <div className="flex items-center gap-2">
        <select
          value={String(target)}
          onChange={e => onChange({ ...post, linkTarget: e.target.value === 'shop' ? 'shop' : Number(e.target.value) })}
          aria-label="Store link goes to"
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
        <Button size="sm" variant="ghost" onClick={copy} disabled={!linkable}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <input
        readOnly
        value={linkable ? url : ''}
        placeholder="Pick a saved design above"
        onFocus={e => e.target.select()}
        aria-label="Store link"
        className="mt-1.5 w-full rounded-md border border-white/10 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-300"
      />
      {design && !linkable && (
        <p className="mt-1 text-xs text-amber-400">
          This design isn&rsquo;t saved, so it can&rsquo;t be linked. Pick one of your saved designs, or save it in the studio first.
        </p>
      )}
    </div>
  );
}
