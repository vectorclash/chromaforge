// Per-user rate limiting via the `check_rate_limit` Postgres function (see
// 0009_rate_limits.sql for why: verify_jwt + a real-user check stops anonymous scripts,
// but nothing previously stopped a signed-up account -- free to create -- from scripting
// a flood of requests against endpoints that trigger real spend (Fly.io render compute,
// Printful mockup/order quota). Fixed-window counter, atomic on the DB side so concurrent
// requests from the same user can't race past the cap.
//
// Call with the plain REST RPC endpoint (not supabase-js) so this has zero imports --
// render-print-file and printful-mockup avoid the SDK entirely (see their own header
// comments: pulling it in made bundling time out on deploy), and this needs to work from
// both of those and from create-checkout-session (which does use the SDK) alike.
export async function checkRateLimit(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_action: action,
      p_limit: limit,
      p_window_seconds: windowSeconds
    })
  });
  // Fail closed: if the rate-limit check itself is broken/unreachable, don't let the
  // request through un-throttled -- these endpoints exist specifically to bound cost.
  if (!res.ok) return false;
  return (await res.json()) === true;
}
