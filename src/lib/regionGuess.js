// Client-side shipping-region guess, timezone-based -- no network call, no third-party IP
// geolocation, so it doesn't touch the Privacy page's "no trackers" promise. Deliberately not
// authoritative: Stripe's hosted Checkout still shows every region option and never cross-checks
// the pick against the address the customer types (see _shared/shipping.ts) -- this only picks
// which option is listed/pre-selected first, cutting down on an honest customer needing to
// manually hunt for their own region in the list.
const CANADA_TIMEZONES = new Set([
  'America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton',
  'America/Goose_Bay', 'America/Toronto', 'America/Nipigon', 'America/Thunder_Bay',
  'America/Iqaluit', 'America/Pangnirtung', 'America/Winnipeg', 'America/Rainy_River',
  'America/Resolute', 'America/Rankin_Inlet', 'America/Regina', 'America/Swift_Current',
  'America/Edmonton', 'America/Cambridge_Bay', 'America/Yellowknife', 'America/Inuvik',
  'America/Creston', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Vancouver',
  'America/Whitehorse', 'America/Dawson'
]);

const UK_TIMEZONES = new Set([
  'Europe/London', 'Europe/Belfast', 'Europe/Jersey', 'Europe/Guernsey', 'Europe/Isle_of_Man'
]);

// Matches the Region union in _shared/shipping.ts -- US/CA/GB map 1:1, AU/NZ share a region,
// everything else offered (see ALLOWED_SHIPPING_COUNTRIES) falls under EU.
export function guessShippingRegion() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return null;
    if (CANADA_TIMEZONES.has(timeZone)) return 'CA';
    if (UK_TIMEZONES.has(timeZone)) return 'GB';
    if (timeZone.startsWith('America/')) return 'US';
    if (timeZone.startsWith('Europe/')) return 'EU';
    if (timeZone.startsWith('Australia/') || timeZone === 'Pacific/Auckland' || timeZone === 'Pacific/Chatham') {
      return 'AU_NZ';
    }
    return null;
  } catch {
    return null;
  }
}
