// Share links only ever exist for a design that's already saved to Supabase (see
// DisplayCanvas.jsx's shareUrl construction, set only alongside isSaved: true) -- an
// unsaved design has no permanent home to link to, and can still be kept via Download.
// That means a share link is just `?id=<the design's real database row id>`, resolved via
// lib/designs.js's getDesign(id): no encoding/decoding, no length limit, no localStorage
// fallback. This replaces an earlier version that base64-encoded the full design payload
// into the URL (with a localStorage-backed short-id fallback for oversized ones) -- that
// approach produced multi-hundred/thousand-character URLs for animations (each frame adds
// its own seed/colors), and the "too long" fallback wasn't a real fix anyway: a
// localStorage-backed id only resolves on the same browser that generated it, so it could
// never actually be shared with anyone. Real database ids are short (a UUID), have no
// practical length ceiling regardless of frame count, and work on any device.

export function getDesignIdFromUrl() {
  return new URLSearchParams(window.location.search).get('id');
}

// Split out from buildShareUrl so the share-link UI can show this part immediately (even
// mid-save, before the real id exists) and reveal just the id once it's known -- see
// DisplayCanvas.jsx's share-link box, which types the id in via GSAP's TextPlugin onto this
// static prefix rather than swapping the whole string in at once.
export function getShareUrlPrefix() {
  return `${window.location.origin}${window.location.pathname}?id=`;
}

export function buildShareUrl(designId) {
  return getShareUrlPrefix() + designId;
}
