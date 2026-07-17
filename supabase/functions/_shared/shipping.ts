// Weight-class + region shipping rates, replacing the old single SHIPPING_FLAT_CENTS number
// that everything used to share. That single number was losing money on almost every order
// once checked against Printful's real AOP shipping-rate tables (2026-07-02) -- up to $6 on
// an AOP hoodie shipped to Australia/NZ, and every Canada order, every heavier garment.
//
// True per-address dynamic shipping (Stripe calculating the real rate off the address the
// customer actually types) requires switching from hosted Checkout to Stripe's embedded
// (Elements) Checkout, which also disables Apple Pay/Google Pay entirely -- see
// docs.stripe.com/payments/advanced/shipping. Decided against that trade for this store.
// Instead: the product's weight class IS known automatically server-side (no guessing --
// we know exactly what was bought), so Stripe's `shipping_options` array offers one
// correctly-priced choice per broad region, and the customer picks whichever matches their
// own address. Stripe does not cross-check the selected option against the shipping address
// they actually enter in hosted Checkout -- an honest customer picking the wrong region is a
// known, accepted gap of this approach (not a bug), same spirit as the flat rate's
// documented "this averages out" tradeoff before it.

type WeightClass = "light" | "heavy";

// Verified against Printful's AOP ("all-over print" -- the only print type this store uses,
// see printful.js's header comment) shipping-rate tables, 2026-07-02: T-shirts/shorts/
// leggings ("light") vs. hoodies/sweatshirts/jackets/joggers ("heavy"). The 3 non-clothing
// starter products (tote bag, crossbody bag, pillow) aren't covered by either clothing
// table -- Printful prices bags/home-goods on a separate table that hasn't been looked up
// yet. Defaulted to "light" as the closer approximation (smaller/lighter than a garment) --
// revisit if actual bag/pillow rates turn out to differ meaningfully once checked.
const WEIGHT_CLASS_BY_PRODUCT_ID: Record<number, WeightClass> = {
  257: "light", // All-Over Print Men's Crew Neck T-Shirt
  261: "light", // All-Over Print Women's Crew Neck T-Shirt
  693: "light", // All-Over Print Recycled Unisex Mesh Shorts
  320: "heavy", // All-Over Print Recycled Unisex Sweatshirt
  388: "heavy", // All-Over Print Recycled Unisex Hoodie
  717: "heavy", // All-Over Print Recycled Unisex Zip Hoodie
  784: "heavy", // All-Over Print Unisex Wide-Leg Joggers
  801: "heavy", // All-Over Print Recycled Unisex Track Jacket
  274: "light", // All-Over Print Large Tote Bag w/ Pocket -- approximated, see comment above
  744: "light", // All-Over Print Utility Crossbody Bag -- approximated, see comment above
  83: "light", // All-Over Print Basic Pillow -- approximated, see comment above
};

type Region = "US" | "CA" | "GB" | "EU" | "AU_NZ";

// Every country in ALLOWED_SHIPPING_COUNTRIES (create-checkout-session/index.ts) needs to
// fall under one of these five regions -- US, CA, GB map 1:1; AU/NZ share a region; every
// remaining allowed country (IE, DE, FR, ES, IT, NL, BE, AT, SE, DK, FI, PT, PL) is EU.
// Keep that list and this region set in sync if either changes.
const REGION_ORDER: Region[] = ["US", "CA", "GB", "EU", "AU_NZ"];

const REGION_LABEL: Record<Region, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  EU: "Europe",
  AU_NZ: "Australia / New Zealand",
};

// Printful's real per-region cost (from the tables above) plus a ~$1.50 margin buffer,
// rounded to a natural price point. Re-derive from Printful's live shipping-rate tables if
// these drift -- don't just nudge a single number the way SHIPPING_FLAT_CENTS used to be.
const RATE_CENTS: Record<WeightClass, Record<Region, number>> = {
  light: { US: 599, CA: 849, GB: 599, EU: 649, AU_NZ: 949 },
  heavy: { US: 949, CA: 1099, GB: 849, EU: 849, AU_NZ: 1349 },
};

const DEFAULT_REGION: Region = "US";

function weightClassFor(productId: number): WeightClass {
  // Unknown product (shouldn't happen for the 11 starter products, but a new product added
  // to the catalog without updating this map first would hit this): assume the pricier
  // tier rather than silently undercharge shipping.
  return WEIGHT_CLASS_BY_PRODUCT_ID[productId] ?? "heavy";
}

// SHIPPING_FLAT_CENTS still works as an emergency override -- set it and every product goes
// back to a single flat rate (or 0 to disable shipping entirely), no redeploy needed, same
// escape hatch as before. Leave it unset to use the weight-class/region table above.
function flatOverrideCents(): number | null {
  const raw = Deno.env.get("SHIPPING_FLAT_CENTS");
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function isRegion(value: unknown): value is Region {
  return typeof value === "string" && (REGION_ORDER as readonly string[]).includes(value);
}

// deno-lint-ignore no-explicit-any
export function buildShippingOptions(productId: number, preferredRegion?: unknown): any[] {
  const override = flatOverrideCents();
  if (override !== null) {
    if (override === 0) return [];
    return [
      {
        shipping_rate_data: {
          display_name: "Standard shipping",
          type: "fixed_amount",
          fixed_amount: { amount: override, currency: "usd" },
          tax_behavior: "exclusive"
        }
      }
    ];
  }

  const rates = RATE_CENTS[weightClassFor(productId)];
  // Stripe Checkout pre-selects whichever shipping option is listed first -- it never
  // cross-checks the pick against the address the customer types (see this file's header
  // comment), so a client-supplied guess (regionGuess.js, timezone-based) just moves the
  // likely match to the front instead of leaving every customer looking at a US-first list.
  // Falls back to the untouched REGION_ORDER for a missing/invalid guess.
  const order = isRegion(preferredRegion)
    ? [preferredRegion, ...REGION_ORDER.filter(region => region !== preferredRegion)]
    : REGION_ORDER;
  return order.map(region => ({
    shipping_rate_data: {
      display_name: `Shipping – ${REGION_LABEL[region]}`,
      type: "fixed_amount",
      fixed_amount: { amount: rates[region], currency: "usd" },
      tax_behavior: "exclusive"
    }
  }));
}

// Used only for the *pending* order row's estimated total, before the customer has picked a
// region -- stripe-webhook overwrites this with Stripe's authoritative total once payment
// completes (same as it already does for tax). Estimates off the US rate since that's the
// most common destination; being off for other regions here only affects the estimate, not
// what the customer is actually charged.
export function estimateShippingCents(productId: number): number {
  const override = flatOverrideCents();
  if (override !== null) return override;
  return RATE_CENTS[weightClassFor(productId)][DEFAULT_REGION];
}
