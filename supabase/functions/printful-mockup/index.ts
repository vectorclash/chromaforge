// Creates and polls Printful mockup-generation tasks. This is the one function in the
// pair that *writes* to Printful (printful-catalog is read-only) -- it asks Printful to
// render our artwork onto a product. Mockup generation does not create a real order or
// charge anything; it's a free preview render. Still gated behind verify_jwt so only
// signed-in app users can spend Printful's (rate-limited) mockup quota.
//
// Deploy with: npx supabase functions deploy printful-mockup

const PRINTFUL_API_BASE = "https://api.printful.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const apiKey = Deno.env.get("PRINTFUL_API_KEY");
  if (!apiKey) {
    return Response.json(
      { error: "PRINTFUL_API_KEY is not configured on this function" },
      { status: 500, headers: corsHeaders }
    );
  }

  const url = new URL(req.url);

  if (req.method === "POST") {
    // Create a mockup task: { productId, variantIds, files: [{ placement, image_url }] }
    const body = await req.json();
    const { productId, variantIds, files, format = "jpg" } = body;

    const printfulRes = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/create-task/${productId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ variant_ids: variantIds, files, format })
      }
    );
    const data = await printfulRes.json();
    return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
  }

  if (req.method === "GET") {
    // Poll a task: /printful-mockup?task_key=xxx
    const taskKey = url.searchParams.get("task_key");
    if (!taskKey) {
      return Response.json({ error: "task_key is required" }, { status: 400, headers: corsHeaders });
    }

    const printfulRes = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const data = await printfulRes.json();
    return Response.json(data, { status: printfulRes.status, headers: corsHeaders });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });
});
