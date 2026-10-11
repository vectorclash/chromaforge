import React from 'react';

// The shop's product-type filter (Aaron, 2026-10-11, grouping "B" of three mocked up:
// https://claude.ai/artifact/5Kzj4jztfJW2WmYiX3i1ZZ). Grouped by what a customer is looking
// for rather than by Printful's catalogue, and sized so no chip is a long scroll on a phone,
// where the shop is a single column.
//
// Kept free of any import beyond React on purpose: RouteSkeleton renders these chips in the
// shop's loading placeholder (so the page lands without moving), and RouteSkeleton is in the
// main bundle -- importing lib/printful here would drag the whole render pipeline in with it.
// That is also why the ids are listed here rather than derived from the product config.
// ShopPage warns in dev if this list and STARTER_PRODUCT_IDS ever disagree.
export const SHOP_CATEGORIES = [
  { key: 'tees', label: 'Tees & tanks', ids: [257, 261, 276] },
  { key: 'hoodies', label: 'Hoodies & jackets', ids: [320, 388, 717, 801, 615, 390] },
  { key: 'bottoms', label: 'Bottoms', ids: [693, 784, 604] },
  { key: 'accessories', label: 'Accessories', ids: [654, 458, 630, 420, 274, 744, 83, 798] }
];

// The active category from a URL's search string (`?type=bottoms`), or null for All. An
// unknown value reads as All rather than an empty shop, so an old or mistyped link still works.
export function shopCategoryFromSearch(search) {
  const type = new URLSearchParams(search).get('type');
  return SHOP_CATEGORIES.find(c => c.key === type) || null;
}

// Same look as the product page's size chips, so the shop's one control reads as part of the
// same set. Wraps rather than scrolling sideways: at phone width it is two rows, and every
// choice stays visible -- a hidden "Accessories" would hide the only way to the phone case.
export default function ShopFilter({ active, onSelect, inert = false }) {
  const options = [{ key: null, label: 'All' }, ...SHOP_CATEGORIES];
  return (
    <div
      className="mb-8 flex flex-wrap gap-2"
      role="group"
      aria-label="Product type"
      {...(inert ? { 'aria-hidden': true, inert: true } : {})}
    >
      {options.map(({ key, label }) => {
        const selected = (active?.key ?? null) === key;
        return (
          <button
            key={key ?? 'all'}
            type="button"
            onClick={() => onSelect?.(key)}
            aria-pressed={selected}
            tabIndex={inert ? -1 : undefined}
            className={
              'cursor-pointer rounded-lg border px-3 py-2 font-quicksand text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-interactive ' +
              (selected ? 'border-accent bg-accent text-ink-950' : 'border-hairline text-text-secondary hover:border-text')
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
