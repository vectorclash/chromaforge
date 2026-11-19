import { useEffect, useState } from 'react';
import { useStudio } from '../context/StudioContext';
import {
  hasInstantMockup,
  instantMockupKey,
  instantViews,
  peekInstantBlank,
  peekInstantMockup,
  requestInstantBlank,
  requestInstantMockup
} from '../lib/instantMockupStore';

// The instant mockup (lib/instantMockup.js) of `productId` wearing `design`, as an image URL, or
// null while it is being made or for a product with no calibration. While a NEW design is being
// made it keeps returning the previous one's URL, so a crossfade has something to fade from.
// `options` are the product page's print options (lib/printful.js's renderAndUploadPrintFiles);
// pass a stable object -- it is part of the cache key. `view` is a view id or a surface name
// ('card', the shop's on-model front); `config` the calibration configuration (null: the default).
export function useInstantMockup(productId, design, options = null, { view = 'card', background = false, config = null, detail = false } = {}) {
  const { renderDesignBlob } = useStudio();
  const key = hasInstantMockup(productId) ? instantMockupKey(productId, design, options, view, config, detail) : null;
  const [state, setState] = useState(() => {
    const cached = peekInstantMockup(key);
    return { key: cached ? key : null, url: cached };
  });
  useEffect(() => {
    if (!key) {
      setState({ key: null, url: null });
      return undefined;
    }
    const cached = peekInstantMockup(key);
    if (cached) {
      setState({ key, url: cached });
      return undefined;
    }
    let live = true;
    // This surface wants the photo until it unmounts or moves to another key; once no surface
    // does, its renders leave the queue (instantMockupStore's heldWork).
    const abort = new AbortController();
    // A failed photo still SETTLES the key, keeping the previous URL: a surface waiting on it
    // (ProductPhoto's loading state) must end rather than wait forever.
    requestInstantMockup(productId, design, options, renderDesignBlob, { view, background, config, detail, signal: abort.signal }).then(url => {
      if (live) setState(prev => ({ key, url: url || prev.url }));
    });
    return () => {
      live = false;
      abort.abort();
    };
    // `key` covers productId, view, design and options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // `settled`: the photo for THIS design, view and options has landed (or failed). Until then
  // `url` is the previous one's.
  return { url: key ? state.url : null, settled: !!key && state.key === key, supported: !!key };
}

// Every calibrated view at once, for the product page's filmstrip: [{ id, name, url }] in strip
// order. The set changes as ONE -- the previous design's thumbnails stay until every view of the
// new one is ready -- so the strip never shows two designs at once.
export function useInstantMockupSet(productId, design, options = null, config = null) {
  const { renderDesignBlob } = useStudio();
  const views = hasInstantMockup(productId) ? instantViews(productId, config, { showsSecondary: !!options?.secondaryDesign }) : [];
  const keys = views.map(v => instantMockupKey(productId, design, options, v.id, config, true));
  const setKey = keys.join('\n');
  const [state, setState] = useState({ setKey: null, urls: null });
  useEffect(() => {
    if (!views.length || keys.some(k => !k)) return undefined;
    let live = true;
    const abort = new AbortController();
    Promise.all(
      views.map(v => requestInstantMockup(productId, design, options, renderDesignBlob, { view: v.id, config, detail: true, signal: abort.signal }))
    ).then(
      urls => {
        if (live && urls.every(Boolean)) setState({ setKey, urls });
      }
    );
    return () => {
      live = false;
      abort.abort();
    };
    // `setKey` covers productId, design and options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setKey]);
  const set = state.urls ? views.map((v, i) => ({ ...v, url: state.urls[i] })) : null;
  return { views: set, settled: !!set && state.setKey === setKey };
}

// The view's blank shirt and fabric mask ({ blank, mask } object URLs), made from the calibration
// alone, or null until ready / for a product with no calibration. See requestInstantBlank.
export function useInstantBlank(productId, view = 'card', config = null) {
  const key = productId && hasInstantMockup(productId) ? `${productId}:${config}:${view}` : null;
  const [state, setState] = useState(() => {
    const ready = key ? peekInstantBlank(productId, view, config) : null;
    return ready ? { key, ...ready } : null;
  });
  useEffect(() => {
    if (!key) {
      setState(null);
      return undefined;
    }
    let live = true;
    requestInstantBlank(productId, view, config).then(b => {
      if (live) setState(b ? { key, ...b } : null);
    });
    return () => {
      live = false;
    };
    // `key` covers productId and view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state : null;
}
