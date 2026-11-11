// Tests the two things a print file needs from Supabase Storage: an upload that answers, and a
// public read of what was uploaded (how Printful fetches it). Written after 2026-11-04, when for
// about twenty minutes every upload saved its file and then never answered -- mockups failed, and
// an order paid in that window could not have had its print files made.
//
// Two callers:
// - create-checkout-session, on every Buy Now, alongside its Printful price check: no test, no
//   order. This is the one that stops a purchase at the moment Storage is down.
// - order-watchdog, every five minutes: closes checkout for everyone after two failures running,
//   so later customers are told up front rather than each waiting out a failed test.
//
// What it cannot see: Printful being unable to fetch from Supabase while everyone else can. That
// shows up as paid orders failing, which the watchdog's order check closes the store on.
//
// A healthy upload answers in well under a second.

const BUCKET = "design-mockups";
// A 1x1 PNG (the bucket only accepts images).
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  c => c.charCodeAt(0)
);

// `name` keeps callers off each other's file (two uploads to one path at once can refuse each
// other): "watchdog", or "checkout-<user id>". Everything lives in the bucket's _health folder,
// beside the per-user folders; cleanup-storage sweeps it like any old mockup file, and the next
// test simply writes its file again.
// Returns null when both steps worked, otherwise what went wrong.
export async function probeStorage(name: string, timeoutMs: number): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const path = `_health/${name}.png`;
  try {
    const up = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "image/png",
        "x-upsert": "true"
      },
      body: PNG,
      signal: AbortSignal.timeout(timeoutMs)
    });
    await up.body?.cancel();
    if (!up.ok) return `upload answered ${up.status}`;
  } catch (err) {
    return `upload did not answer within ${timeoutMs / 1000}s (${err instanceof Error ? err.name : err})`;
  }
  try {
    const read = await fetch(`${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    await read.body?.cancel();
    if (!read.ok) return `public read answered ${read.status}`;
  } catch (err) {
    return `public read did not answer (${err instanceof Error ? err.name : err})`;
  }
  return null;
}
