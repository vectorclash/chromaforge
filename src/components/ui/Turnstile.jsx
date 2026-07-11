import { useEffect, useRef } from 'react';

// Cloudflare Turnstile widget, for Supabase Auth's CAPTCHA protection (enabled in the
// Supabase dashboard -- Auth -> Attack Protection). Once that flag is on, GoTrue rejects
// every password-based auth call (sign up, sign in, password reset) without a valid
// captchaToken, so this must be mounted on each of those forms.
//
// Guarded the same way as the Supabase client itself: if VITE_TURNSTILE_SITE_KEY isn't
// set, this renders nothing and onToken never fires -- correct for an environment where
// the dashboard flag is off (auth calls simply omit the token). Don't enable one without
// the other or every email/password auth attempt fails.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => {
        scriptPromise = null; // allow a retry on the next mount
        reject(new Error('Failed to load Turnstile'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

// onToken fires with a fresh token when the (usually invisible) challenge passes, and
// with null when the token expires or errors out. resetSignal: bump this counter after
// every auth submission, successful or not -- tokens are single-use, so the widget must
// issue a new one before the user can retry.
export default function Turnstile({ onToken, resetSignal = 0 }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!SITE_KEY) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then(turnstile => {
        if (cancelled || !containerRef.current) return;
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          theme: 'dark',
          // 'flexible' stretches the widget to the form's width instead of the fixed
          // 300px box; 'interaction-only' keeps it invisible unless Cloudflare actually
          // needs the visitor to interact (most humans just get a silent token), so the
          // form usually looks exactly as it did before CAPTCHA existed.
          size: 'flexible',
          appearance: 'interaction-only',
          callback: token => onTokenRef.current?.(token),
          'expired-token-callback': () => onTokenRef.current?.(null),
          'error-callback': () => onTokenRef.current?.(null)
        });
      })
      .catch(() => {
        // Script blocked/unreachable: leave the token empty. Supabase rejects the auth
        // call with its own clear error, which the form already surfaces.
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current !== null) {
      window.turnstile?.reset(widgetIdRef.current);
    }
  }, [resetSignal]);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} />;
}
