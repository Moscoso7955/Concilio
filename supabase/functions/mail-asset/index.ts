// Serves a venue's email-header image straight from the database —
// the bytes live base64 on mail_senders (0035), so the image can't
// "fall out of the system" the way a moved/deleted storage file can.
// Public GET (email clients fetch images anonymously); the entity id
// is the lookup key and the image is already public in every campaign.
// verify_jwt = FALSE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const e = new URL(req.url).searchParams.get("e") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e)) {
    return new Response("Bad request", { status: 400 });
  }
  const { data } = await admin.from("mail_senders")
    .select("header_image_data, header_image_mime").eq("entity_id", e).maybeSingle();
  if (!data?.header_image_data) return new Response("Not found", { status: 404 });
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(data.header_image_data), (c) => c.charCodeAt(0));
  } catch (_) {
    return new Response("Corrupt image data", { status: 500 });
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": data.header_image_mime || "image/png",
      // The saved URL carries a ?v= stamp, so long caching is safe.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
});
