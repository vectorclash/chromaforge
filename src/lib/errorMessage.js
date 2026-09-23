/*
 * Turns whatever an error actually is into a sentence written for the person reading it.
 *
 * WHY THIS EXISTS (Aaron, 2026-09-09: "make sure all user facing error messages sound like
 * they are meant for a human to read. some of the ones I've seen are very machine only
 * feeling"). Seventeen call sites rendered `err.message` straight into the page, and the
 * errors reaching them are not ours: `signInWithEmail` does `if (error) throw error`, so a
 * failed sign-in put GoTrue's own wording on screen. The one that prompted this was
 *
 *     captcha protection: request disallowed (no captcha_token found)
 *
 * which names an internal parameter, blames the request rather than explaining anything, and
 * tells the reader nothing they can act on.
 *
 * THE RULE: a raw message is NEVER rendered. Either a rule below recognises it and returns
 * copy written for a person, or the call site's own fallback is used -- which is why every
 * call site passes one that says what specifically failed ("We couldn't load your orders"),
 * not a shrug. The raw text goes to console.warn so it is still there for support.
 *
 * Rules are ordered and the first match wins, so put the specific ones first. Matching is on
 * a substring pattern rather than an exact string because these providers reword their
 * messages without warning; a pattern survives a rewording that an equality check would not.
 */

// Messages we wrote ourselves and vouch for -- these are already addressed to the reader, so
// they pass through untouched. Kept as an explicit list rather than a "does this look human?"
// heuristic: whether a string is fit to show someone is a decision, and this is where it is
// recorded. Anything not listed and not matched below is treated as internal.
const PASSTHROUGH = [
  /^you must be signed in/i,
  /^the size guide could not be loaded/i,
  /^an account with this email already exists/i
];

const RULES = [
  // --- Cloudflare Turnstile, via GoTrue -------------------------------------------------
  // Both the "no token" and "verification failed" cases land here. They have different
  // causes (the widget never issued one; Cloudflare rejected the one it did) but exactly the
  // same remedy, and the difference is not something the reader can act on differently.
  [/captcha/i, "We couldn't complete the security check. Reload the page and try again."],

  // --- Sign in / sign up ----------------------------------------------------------------
  [/invalid login credentials/i, "That email and password don't match an account."],
  [/email not confirmed/i, 'Confirm your email address first — check your inbox for the link we sent.'],
  [/user already registered/i, 'An account with this email already exists. Sign in instead.'],
  [/signups? (are )?not allowed/i, "New accounts aren't being accepted right now."],
  [/unable to validate email address/i, "That doesn't look like a valid email address."],
  [
    /password should be at least (\d+)/i,
    m => `Your password needs to be at least ${m[1]} characters.`
  ],
  // The dashboard's "Password requirements" rule. GoTrue lists the required character SETS
  // verbatim ("abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789"), so the
  // sentence is built from which sets appear rather than hardcoding today's setting.
  [
    /password should contain at least one character of each: (.*)/i,
    m => {
      const sets = m[1];
      const need = [
        /[a-z]{5}/.test(sets) && 'a lowercase letter',
        /[A-Z]{5}/.test(sets) && 'an uppercase letter',
        /[0-9]{5}/.test(sets) && 'a number',
        /[^A-Za-z0-9,\s.]/.test(sets) && 'a symbol'
      ].filter(Boolean);
      if (need.length === 0) return 'Your password needs a mix of letters, numbers and symbols.';
      const list = need.length > 1 ? `${need.slice(0, -1).join(', ')} and ${need.at(-1)}` : need[0];
      return `Your password needs at least ${list}.`;
    }
  ],
  [/new password should be different/i, 'Your new password needs to be different from your old one.'],

  // GoTrue's own throttle, which carries the wait in the message.
  [
    /you can only request this after (\d+) seconds?/i,
    m => `Please wait ${m[1]} seconds before trying again.`
  ],
  [/email rate limit exceeded|over_email_send_rate_limit/i,
    "We've sent too many emails to this address. Try again in a little while."],

  // --- Email links (confirm, recovery). Ordered BEFORE the session rule below, which also
  // would otherwise say "sign in again" -- wrong advice for someone who has just clicked a
  // confirmation link and has no session to return to. GoTrue uses "token has expired or is
  // invalid" for a spent link, which is why that exact phrasing belongs here and not below.
  [/email link is invalid or has expired|otp_expired|token has expired or is invalid|invalid or has expired/i,
    'That link has expired or has already been used. Request a new one.'],

  // --- Session -------------------------------------------------------------------------
  [/auth session missing|jwt expired|invalid (refresh )?token|session_not_found/i,
    'Your session expired. Sign in again.'],

  // --- Network. Chrome says "Failed to fetch", Safari "Load failed", Firefox its own. ----
  [/failed to fetch|load failed|networkerror|network request failed|err_internet_disconnected/i,
    "We couldn't reach the server. Check your connection and try again."],

  // --- Server-side ----------------------------------------------------------------------
  [/rate ?limit|too many requests|\b429\b/i, 'Too many requests just now. Give it a moment and try again.'],
  [/row-level security|permission denied|not authori[sz]ed|\b40[13]\b/i,
    "You don't have permission to do that."],
  [/payload too large|exceeded the maximum allowed size|\b413\b/i, 'That file is too large.'],
  [/\b(502|503|504)\b|gateway|temporarily unavailable|service unavailable/i,
    'The service is briefly unavailable. Try again in a moment.'],

  // --- Ours, but written for a developer -------------------------------------------------
  // A visitor should never meet these; if the deploy is misconfigured they would, so they get
  // the same treatment as anything else internal rather than instructions about .env files.
  [/supabase is not configured/i, "This feature isn't available right now."]
];

/**
 * @param err       an Error, a string, or anything at all.
 * @param fallback  what to say when nothing recognises it. Say what failed, in this context.
 */
export function humanError(err, fallback) {
  const raw = (typeof err === 'string' ? err : err?.message) || '';

  for (const [pattern, message] of RULES) {
    const match = raw.match(pattern);
    if (match) return typeof message === 'function' ? message(match) : message;
  }

  if (PASSTHROUGH.some(pattern => pattern.test(raw.trim()))) return raw.trim();

  // Not an error condition in itself -- console.warn rather than console.error deliberately,
  // since check-routes-smoke.mjs treats a console error as a broken page.
  if (raw) console.warn('[errorMessage] no human copy for:', raw);
  return fallback;
}
