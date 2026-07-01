// Store-wide purchasing kill switch -- lets real checkout be paused instantly (e.g. a
// Printful/Stripe outage, or just wanting to stop taking orders for a while) without a code
// change or redeploy. Same pattern as PRICE_MARKUP_PERCENT in pricing.ts. Only gates
// checkout/pricing-facing functions -- browsing, mockups, the gallery, and the studio stay
// fully operational regardless of this flag.
//
// Toggle with: npx supabase secrets set STORE_ENABLED=false
// Takes effect on the next request to either function -- no redeploy needed. Unset (or any
// value other than the literal string "false") means enabled, so a fresh project isn't
// accidentally locked out of checkout.
export function isStoreEnabled(): boolean {
  return Deno.env.get("STORE_ENABLED") !== "false";
}
