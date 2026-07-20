// Sweeps the design-mockups Storage bucket, which was found (2026-07-19) holding ~357MB
// -- a third of the project's Storage quota -- almost entirely orphaned test-checkout
// debris. Two file populations live there, with different lifetimes:
//
//  - Print-resolution renders (`<userId>/print-<hash-or-timestamp>-<printfileId>.png`,
//    uploaded by render-print-file, up to ~13MB each): per-checkout artifacts. Safe to
//    delete unless referenced by a non-canceled order's print_file_urls (Printful fetches
//    the file at order time; keep anything a live/submitted/failed order points at).
//    An age floor of 24h also protects files uploaded by a checkout still in flight --
//    the render/upload happens BEFORE create-checkout-session writes the pending row, and
//    24h matches the stale-pending-order expiry (0010_..._cron.sql).
//
//  - Mockup source images (content-hashed via uploadMockupSourceImage, ~100-300KB):
//    shared cache entries for mockup previews. Nothing outside this function's own Printful
//    mockup-task fetch (completes within ~3 min of upload) ever reads one again -- deleting
//    one just costs a re-render on the next cache miss -- so anything older than
//    MOCKUP_MAX_AGE_DAYS goes -- EXCEPT files in the keep-list, because label placements'
//    marks are uploaded through the same content-hashed path and DO end up in real orders'
//    print_file_urls.
//
// This deliberately supersedes 0010's "Storage is left untouched" stance for print files:
// that reasoning (files may be shared across orders) is true for content-hashed mockup
// sources but never was for the per-checkout print renders, and even hashed files are safe
// to remove once nothing non-canceled references them.
//
// Invoked daily by pg_cron (migration 0014) and manually for one-off sweeps. verify_jwt =
// false (config.toml) because the cron caller has no user JWT; auth is the X-Cleanup-Key
// shared secret instead (CLEANUP_STORAGE_KEY function secret -- same pattern as
// render-print-file's RENDER_SERVICE_KEY). Plain fetch(), no supabase-js, for the same
// bundle-timeout reason as render-print-file.
//
// Deploy with: npx supabase functions deploy cleanup-storage

const BUCKET = "design-mockups";
const PRINT_MIN_AGE_HOURS = 24;
const MOCKUP_MAX_AGE_DAYS = 3;
const DELETE_BATCH = 100;

Deno.serve(async req => {
  if (req.method !== "POST") {
    return Response.json({ error: { message: "Method not allowed" } }, { status: 405 });
  }

  const cleanupKey = Deno.env.get("CLEANUP_STORAGE_KEY");
  if (!cleanupKey || req.headers.get("X-Cleanup-Key") !== cleanupKey) {
    return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const serviceHeaders = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };

  // Keep-list: every file any non-canceled order's print_file_urls points at. Includes
  // pending (checkout may still complete), submitted (Printful may re-fetch), and failed
  // (resubmittable by hand -- see stripe-webhook's failure handling).
  const itemsRes = await fetch(
    `${supabaseUrl}/rest/v1/order_items?select=print_file_urls,order:orders!inner(status)&order.status=neq.canceled`,
    { headers: serviceHeaders }
  );
  if (!itemsRes.ok) {
    return Response.json({ error: { message: `keep-list query failed (${itemsRes.status})` } }, { status: 500 });
  }
  const items: { print_file_urls: Record<string, string> | null }[] = await itemsRes.json();
  const keep = new Set<string>();
  const pathPrefix = `/storage/v1/object/public/${BUCKET}/`;
  for (const item of items) {
    for (const url of Object.values(item.print_file_urls ?? {})) {
      const idx = typeof url === "string" ? url.indexOf(pathPrefix) : -1;
      if (idx !== -1) keep.add(decodeURIComponent(url.slice(idx + pathPrefix.length)));
    }
  }

  // Walk the bucket: top level is per-user folders; files live one level down.
  const listPage = async (prefix: string, offset: number) => {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...serviceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } })
    });
    if (!res.ok) throw new Error(`list ${prefix || "(root)"} failed (${res.status})`);
    return await res.json() as { name: string; id: string | null; created_at: string | null }[];
  };
  const listAll = async (prefix: string) => {
    const all: { name: string; id: string | null; created_at: string | null }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await listPage(prefix, offset);
      all.push(...page);
      if (page.length < 1000) return all;
    }
  };

  const now = Date.now();
  const printCutoff = now - PRINT_MIN_AGE_HOURS * 3600 * 1000;
  const mockupCutoff = now - MOCKUP_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const toDelete: string[] = [];
  let kept = 0, tooYoung = 0;

  for (const folder of await listAll("")) {
    if (folder.id !== null) continue; // a stray root-level file, not a user folder
    for (const file of await listAll(folder.name)) {
      if (file.id === null) continue;
      const path = `${folder.name}/${file.name}`;
      if (keep.has(path)) { kept++; continue; }
      const created = file.created_at ? Date.parse(file.created_at) : now;
      const cutoff = /^print-/.test(file.name) ? printCutoff : mockupCutoff;
      if (created < cutoff) toDelete.push(path);
      else tooYoung++;
    }
  }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += DELETE_BATCH) {
    const batch = toDelete.slice(i, i + DELETE_BATCH);
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { ...serviceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: batch })
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("batch delete failed", res.status, errBody);
      return Response.json(
        { error: { message: `delete failed after ${deleted} of ${toDelete.length}` } },
        { status: 500 }
      );
    }
    deleted += batch.length;
  }

  const summary = { deleted, keptReferenced: kept, keptTooRecent: tooYoung };
  console.log("cleanup-storage", JSON.stringify(summary));
  return Response.json(summary);
});
