// Store-wide purchasing switch. Only gates checkout: browsing, mockups, the gallery and the studio
// stay fully operational whatever it says. Two switches, either of which closes the store:
//
// 1. STORE_ENABLED (a function secret) -- the manual one. Lets real checkout be paused instantly
//    (a Printful/Stripe outage, a deploy window) without a code change or redeploy:
//      npx supabase secrets set STORE_ENABLED=false
//    Takes effect on the next request. Unset (or any value other than the literal string "false")
//    means enabled, so a fresh project isn't accidentally locked out of checkout.
//
// 2. public.store_state (migration 0024) -- the automatic one. order-watchdog closes it so the
//    store stops taking money for orders it cannot currently fulfil while nobody is watching:
//    - closed_by 'orders': paid orders are failing or piling up. Never reopens by itself; a human
//      does, once they know why it closed:
//        update public.store_state set enabled = true, reason = null, closed_by = null, changed_at = now();
//    - closed_by 'storage': Supabase Storage stopped answering uploads. The watchdog reopens it
//      itself once uploads work again (only a close it made for this reason, never the other).
//    (changed_at matters: the watchdog only counts trouble since the last change, so the orders
//    that closed the store cannot close it again the moment it reopens.)
//
// The database read FAILS OPEN: unreachable, slow, or the table not there yet (functions deployed
// before the migration) all mean "enabled". If the database really is down, checkout cannot write
// its pending order and stops on its own; this must never be the thing that closes a healthy store.

export function isStoreEnabled(): boolean {
  return Deno.env.get("STORE_ENABLED") !== "false";
}

export type StoreState = {
  enabled: boolean;
  reason: string | null;
  changedAt: string | null;
  closedBy: string | null;
  probeFailures: number;
  probeSuccesses: number;
};

const serviceHeaders = () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" };
};
const stateUrl = (query: string) => `${Deno.env.get("SUPABASE_URL")}/rest/v1/store_state?${query}`;

// The automatic switch alone. Null when it cannot be read.
export async function readStoreState(): Promise<StoreState | null> {
  try {
    const res = await fetch(stateUrl("select=*&limit=1"), {
      headers: serviceHeaders(),
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return null;
    const row = (await res.json())?.[0];
    if (!row || typeof row.enabled !== "boolean") return null;
    return {
      enabled: row.enabled,
      reason: row.reason ?? null,
      changedAt: row.changed_at ?? null,
      closedBy: row.closed_by ?? null,
      probeFailures: row.probe_failures ?? 0,
      probeSuccesses: row.probe_successes ?? 0
    };
  } catch {
    return null;
  }
}

// What checkout asks: both switches.
export async function isStoreOpen(): Promise<boolean> {
  if (!isStoreEnabled()) return false;
  const state = await readStoreState();
  return state ? state.enabled : true;
}

// Closes the automatic switch. True only for the call that actually closed it, so the caller
// alerts once however many watchdog passes see the same trouble.
export function closeStore(reason: string, closedBy: "orders" | "storage"): Promise<boolean> {
  return patchState("enabled=eq.true", {
    enabled: false,
    reason,
    closed_by: closedBy,
    changed_at: new Date().toISOString()
  });
}

// Reopens the store, but only a close made for `closedBy`. True if this call reopened it.
export function reopenStore(closedBy: "storage"): Promise<boolean> {
  return patchState(`enabled=eq.false&closed_by=eq.${closedBy}`, {
    enabled: true,
    reason: null,
    closed_by: null,
    changed_at: new Date().toISOString()
  });
}

export async function recordProbe(failures: number, successes: number): Promise<void> {
  await patchState("id=eq.true", { probe_failures: failures, probe_successes: successes });
}

async function patchState(filter: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(stateUrl(filter), {
    method: "PATCH",
    headers: { ...serviceHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`store_state update failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as unknown[]).length > 0;
}
