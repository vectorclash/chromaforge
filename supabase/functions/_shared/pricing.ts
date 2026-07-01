// Flat percentage retail markup over Printful's cost price. Shared by every function that
// touches a price -- printful-catalog (what the customer sees on the product page) and
// create-checkout-session (what Stripe actually charges) -- so the displayed price and the
// charged price can never drift apart from applying the markup in only one place.
//
// Update the percentage with:
//   npx supabase secrets set PRICE_MARKUP_PERCENT=35
// Takes effect on the next request to either function -- no redeploy needed.
export function applyMarkup(costCents: number): number {
  const percent = Number(Deno.env.get("PRICE_MARKUP_PERCENT") ?? "0");
  return Math.round(costCents * (1 + percent / 100));
}
