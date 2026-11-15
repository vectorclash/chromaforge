// Anonymous visit events (supabase/migrations/0025_events.sql has the table and what it may
// hold). Added 2026-11-14 after an Instagram ad run where 40 people clicked through, nobody
// bought, and the backend could only say that none of them opened a product page.
//
// Privacy rules this file keeps, and the Privacy page describes:
//   - The visit id lives in sessionStorage: one tab, gone when it closes. No cookie and nothing
//     that recognises a returning visitor.
//   - No user id, email or IP is sent. `signed_in` is a yes/no.
//   - Paths are sent without their query string.
//
// Never throws and never waits: a failed or blocked event is dropped. It is a plain fetch with
// `keepalive`, not the supabase client, so an event sent just before navigating away (Buy Now
// handing off to Stripe) still arrives, and so this file adds nothing to the main bundle.
//
// Off on localhost and under automation (navigator.webdriver), so development and the repo's
// Playwright checks never land in the table. `?track=1` turns it on for the rest of the tab.

import { hasStoredSession } from './sessionHint';

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SESSION_KEY = 'cf-visit';
const FORCE_KEY = 'cf-track';

let state = null;
const onceSent = new Set();

function readSession() {
  try {
    return JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function newId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  // RFC 4122 v4 from getRandomValues, for browsers without randomUUID (Safari < 15.4).
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Where this visit came from. Decided on the visit's first page and kept for the tab, so a
// later page's own referrer (this site) never overwrites it.
function detectSource() {
  const params = new URLSearchParams(window.location.search);
  const utm = params.get('utm_source');
  if (utm) return utm.toLowerCase().slice(0, 40);
  const ua = navigator.userAgent || '';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  try {
    const ref = document.referrer ? new URL(document.referrer).hostname : '';
    if (ref && ref !== window.location.hostname) return ref.replace(/^www\./, '').slice(0, 60);
  } catch {
    // Unparseable referrer: treat as direct.
  }
  return 'direct';
}

function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'phone';
  return 'desktop';
}

function enabled() {
  if (!URL_BASE || !KEY) return false;
  try {
    if (new URLSearchParams(window.location.search).get('track') === '1') {
      window.sessionStorage.setItem(FORCE_KEY, '1');
    }
    if (window.sessionStorage.getItem(FORCE_KEY) === '1') return true;
  } catch {
    // sessionStorage blocked: fall through to the normal rules.
  }
  if (navigator.webdriver) return false;
  const host = window.location.hostname;
  return !(host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.endsWith('.local'));
}

function init() {
  if (state) return state;
  if (typeof window === 'undefined' || !enabled()) {
    state = { off: true };
    return state;
  }
  let s = readSession();
  if (!s || !s.id) {
    const params = new URLSearchParams(window.location.search);
    s = {
      id: newId(),
      source: detectSource(),
      // Ad tags on the landing URL, so one ad can be told from another.
      campaign: params.get('utm_campaign')?.slice(0, 80) || null,
      content: params.get('utm_content')?.slice(0, 80) || null,
      landing: true
    };
  }
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, landing: false }));
  } catch {
    // Not stored: every page load becomes its own visit. Acceptable.
  }
  state = { ...s, device: detectDevice() };
  return state;
}

/**
 * Record one event. Safe to call anywhere, any number of times.
 * @param {string} name one of the names allowed by 0025_events.sql
 * @param {object} [props] small facts about the event
 * @param {{ once?: string }} [opts] `once`: a key; the event is sent at most once per page load
 */
export function track(name, props = {}, opts = {}) {
  try {
    const s = init();
    if (s.off) return;
    if (opts.once) {
      if (onceSent.has(opts.once)) return;
      onceSent.add(opts.once);
    }
    const body = {
      session_id: s.id,
      name,
      path: window.location.pathname.slice(0, 200),
      source: s.source,
      device: s.device,
      props: { ...props, signed_in: hasStoredSession() }
    };
    if (name === 'page_view' && s.landing) {
      body.props.landing = true;
      if (s.campaign) body.props.campaign = s.campaign;
      if (s.content) body.props.ad = s.content;
      s.landing = false;
    }
    fetch(`${URL_BASE}/rest/v1/events`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  } catch {
    // Tracking must never break the page.
  }
}
