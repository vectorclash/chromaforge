// Proxies Printful's public catalog (GET /products, GET /products/:id) so the browser
// never needs the Printful private API token -- that token can create real orders and
// manage files, so it must stay server-side. This function only ever reads catalog data;
// it has no write path to Printful, which keeps its blast radius small even if something
// upstream of it were ever compromised.
//
// Deploy with: npx supabase functions deploy printful-catalog
// Set the secret once with: npx supabase secrets set PRINTFUL_API_KEY=<key>

const PRINTFUL_API_BASE = "https://api.printful.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!apiKey) {
    return Response.json(
      { error: "PRINTFUL_API_KEY is not configured on this function" },
      { status: 500, headers: corsHeaders }
    );
  }

  const url = new URL(req.url);
  // /printful-catalog            -> GET /products (list)
  // /printful-catalog?id=123     -> GET /products/123 (one product + variants)
  const productId = url.searchParams.get("id");
  const categoryId = url.searchParams.get("category_id");

  const printfulUrl = new URL(`${PRINTFUL_API_BASE}/products${productId ? `/${productId}` : ""}`);
  if (categoryId) printfulUrl.searchParams.set("category_id", categoryId);

  const printfulRes = await fetch(printfulUrl, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const data = await printfulRes.json();
  return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
});
