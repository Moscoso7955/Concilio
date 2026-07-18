// Inbound email → AI-filed invoice. Resend posts here (verify_jwt MUST be false;
// this function does its own signature auth). Bills forwarded to
// bills-<token>@<domain> are parsed and filed with needs_review=true.
//
// NOTE: Resend's inbound payload/field names can vary — the attachment handling
// below assumes `data.attachments[]` with base64 `content`. Confirm against your
// Resend inbound config and adjust field names if delivery filing looks wrong.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET"); // whsec_...
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const CATEGORIES = [
  "Utilities", "Internet & Phone", "Rent", "Insurance", "Repairs & Maintenance",
  "Licenses & Permits", "Waste & Recycling", "Software & Subscriptions",
  "Professional Services", "Other",
];
const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    vendor: { type: ["string", "null"] },
    invoiceDate: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
  },
  required: ["vendor", "invoiceDate", "amount", "category"],
};
const SYSTEM = `You extract fields from a single overhead bill for bookkeeping.
If a field is not clearly present, return null rather than guessing.
vendor = the company that ISSUED the bill (biller). invoiceDate = ISO YYYY-MM-DD.
amount = total due, numeric only. category = one allowed value or null.`;

// --- Landmine 4: verify Resend (Svix) signature, fail CLOSED ---
async function verify(req: Request, body: string): Promise<boolean> {
  if (!WEBHOOK_SECRET) return false; // unset secret → reject, never skip
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  const secretBytes = Uint8Array.from(atob(WEBHOOK_SECRET.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sigHeader.split(" ").some((p) => p.split(",")[1] === expected);
}

async function extract(bytes: Uint8Array, mime: string): Promise<Record<string, unknown>> {
  const b64 = btoa(String.fromCharCode(...bytes));
  let block: unknown;
  if (mime === "application/pdf") block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };
  else if (mime.startsWith("image/")) block = { type: "image", source: { type: "base64", media_type: ["image/png","image/jpeg","image/gif","image/webp"].includes(mime) ? mime : "image/png", data: b64 } };
  else block = { type: "text", text: new TextDecoder().decode(bytes).slice(0, 200_000) };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8", max_tokens: 1024, system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [block, { type: "text", text: "Extract per the schema." }] }],
    }),
  });
  const data = await res.json();
  try {
    const { data: t } = await admin.from("tenants").select("id").order("created_at").limit(1).single();
    await admin.from("ai_usage").insert({ tenant_id: t?.id, model: "claude-opus-4-8", input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens, purpose: "email" });
  } catch (_) { /* best-effort */ }
  const tb = (data.content || []).find((b: { type: string }) => b.type === "text");
  return JSON.parse(tb?.text || "{}");
}

async function fileInvoice(tenantId: string, sourceKey: string, extracted: Record<string, unknown>, bytes: Uint8Array | null, mime: string, fileName: string) {
  let file_url: string | null = null;
  if (bytes) {
    const path = `email/${sourceKey.replace(/[^a-zA-Z0-9._/-]/g, "_")}`;
    const { error } = await admin.storage.from("invoices").upload(path, bytes, { contentType: mime, upsert: true });
    if (!error) file_url = `storage:${path}`;
  }
  // Landmine 5: dedupe on the source key so provider retries never double-file.
  await admin.from("invoices").upsert({
    tenant_id: tenantId,
    vendor: (extracted.vendor as string) || "Unknown vendor",
    category: (extracted.category as string) || null,
    invoice_date: (extracted.invoiceDate as string) || null,
    amount: (extracted.amount as number) ?? null,
    needs_review: true,
    file_url, file_name: fileName,
    source_email_id: sourceKey,
  }, { onConflict: "tenant_id,source_email_id", ignoreDuplicates: true });
}

Deno.serve(async (req) => {
  const raw = await req.text();
  // Landmine 4: reject unauthenticated/invalid — the ONLY non-200 path.
  if (!(await verify(req, raw))) return new Response("invalid signature", { status: 401 });

  // Landmine 5: always 200 past this point (stop provider retry storms); log loudly.
  try {
    const payload = JSON.parse(raw);
    const email = payload.data || payload;
    const emailId: string = email.id || email.email_id || crypto.randomUUID();
    const recipients: string[] = email.to || email.recipients || [];
    const token = (recipients.map(String).join(",").match(/bills-([a-z0-9-]+)@/i) || [])[1];
    if (!token) return new Response("no token", { status: 200 });

    const { data: tenant } = await admin.from("tenants").select("id").eq("inbound_token", token).single();
    if (!tenant) return new Response("unknown tenant", { status: 200 });

    const attachments: Array<Record<string, string>> = email.attachments || [];
    // Landmine 6: only real bill attachments — PDFs, or images that are NOT inline.
    const real = attachments.filter((a) => {
      const ct = (a.content_type || "").toLowerCase();
      if (ct === "application/pdf") return true;
      if (ct.startsWith("image/")) return (a.content_disposition || "") !== "inline" && !a.content_id;
      return false;
    });

    if (real.length) {
      for (let i = 0; i < real.length; i++) {
        const a = real[i];
        if (!a.content) continue; // no bytes available to parse
        const bytes = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
        const extracted = await extract(bytes, a.content_type);
        await fileInvoice(tenant.id, `${emailId}:${a.content_id || i}`, extracted, bytes, a.content_type, a.filename || "attachment");
      }
    } else {
      // No attachments: extract from body text; store the body as a viewable HTML file.
      const bodyText: string = email.text || email.html || email.body || "";
      const extracted = await extract(new TextEncoder().encode(bodyText), "text/plain");
      const safeHtml = `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font-family:system-ui;padding:1rem">${
        bodyText.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre>`;
      await fileInvoice(tenant.id, `${emailId}:body`, extracted, new TextEncoder().encode(safeHtml), "text/html", "email-body.html");
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("email-inbound failure:", e); // log loudly, still 200
    return new Response("logged", { status: 200 });
  }
});
