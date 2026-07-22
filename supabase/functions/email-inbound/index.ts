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
// category is a plain nullable string (Anthropic rejects enum on a nullable
// union type); allowed values are enforced via the system prompt below.
const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    vendor: { type: ["string", "null"] },
    invoiceDate: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    category: { type: ["string", "null"] },
  },
  required: ["vendor", "invoiceDate", "amount", "category"],
};
const SYSTEM = `You extract fields from a single overhead bill for bookkeeping.
If a field is not clearly present, return null rather than guessing.
vendor = the company that ISSUED the bill (biller). invoiceDate = ISO YYYY-MM-DD.
amount = total due, numeric only.
category = choose EXACTLY one of these values, or null if unclear: ${CATEGORIES.join(", ")}.`;

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
  // Retry transient capacity errors (529 Overloaded / 429 rate limit).
  let res: Response | null = null, data: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8", max_tokens: 1024, system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: [block, { type: "text", text: "Extract per the schema." }] }],
      }),
    });
    data = await res.json();
    if (res.ok || (res.status !== 529 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res!.ok) {
    // Don't silently file all-null junk — name the failure in the logs.
    console.error("anthropic error", res!.status, data?.error?.message || JSON.stringify(data).slice(0, 300));
    return {};
  }
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
    if (error) console.error("fileInvoice storage error:", error.message);
    else file_url = `storage:${path}`;
  }
  // Landmine 5: dedupe on the source key so provider retries never double-file.
  // NOTE: select-then-insert, NOT upsert — uq_invoices_source_email is a
  // partial unique index, which Postgres can't match for ON CONFLICT, so the
  // upsert errored on every call (and the error was silently ignored).
  const { data: existing } = await admin.from("invoices")
    .select("id").eq("tenant_id", tenantId).eq("source_email_id", sourceKey).maybeSingle();
  if (existing) { console.log("dedupe: already filed", sourceKey); return; }
  const { error: insErr } = await admin.from("invoices").insert({
    tenant_id: tenantId,
    vendor: (extracted.vendor as string) || "Unknown vendor",
    category: (extracted.category as string) || null,
    invoice_date: (extracted.invoiceDate as string) || null,
    amount: (extracted.amount as number) ?? null,
    needs_review: true,
    file_url, file_name: fileName,
    source_email_id: sourceKey,
  });
  if (insErr) console.error("fileInvoice insert error:", insErr.message);
  else console.log("filed invoice", sourceKey, extracted.vendor, extracted.amount);
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
    console.log("event:", payload.type || "?", "| email:", emailId, "| to:", JSON.stringify(recipients));
    const token = (recipients.map(String).join(",").match(/bills-([a-z0-9-]+)@/i) || [])[1];
    if (!token) { console.log("no token in recipients — ignoring"); return new Response("no token", { status: 200 }); }

    const { data: tenant } = await admin.from("tenants").select("id").eq("inbound_token", token).single();
    if (!tenant) { console.log("unknown tenant for token:", token); return new Response("unknown tenant", { status: 200 }); }
    console.log("tenant matched:", token);

    const attachments: Array<Record<string, string>> = email.attachments || [];
    console.log("attachments:", attachments.length, attachments.map((a) => `${a.filename || "?"}[${a.content_type || "?"}] keys:${Object.keys(a).join("+")}`).join(" | ") || "none");
    // Landmine 6: only real bill attachments — PDFs, or images that are NOT inline.
    const real = attachments.filter((a) => {
      const ct = (a.content_type || "").toLowerCase();
      if (ct === "application/pdf") return true;
      if (ct.startsWith("image/")) return (a.content_disposition || "") !== "inline" && !a.content_id;
      return false;
    });

    // Payload shapes vary: bytes may be inlined base64 (`content`) or behind a
    // download URL. Resolve whichever is present.
    async function attachmentBytes(a: Record<string, string>): Promise<Uint8Array | null> {
      if (a.content) return Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
      const url = a.download_url || a.url || a.href;
      if (url) {
        const headers: Record<string, string> = {};
        const key = Deno.env.get("RESEND_API_KEY");
        if (key) headers.Authorization = `Bearer ${key}`;
        const r = await fetch(url, { headers });
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
        console.error("attachment fetch failed:", r.status, url);
      }
      console.error("attachment has no content or usable URL — keys:", Object.keys(a).join(","));
      return null;
    }

    let filedCount = 0;
    if (real.length) {
      for (let i = 0; i < real.length; i++) {
        const a = real[i];
        const bytes = await attachmentBytes(a);
        if (!bytes) continue;
        const extracted = await extract(bytes, a.content_type);
        console.log("extracted:", JSON.stringify(extracted));
        await fileInvoice(tenant.id, `${emailId}:${a.content_id || i}`, extracted, bytes, a.content_type, a.filename || "attachment");
        filedCount++;
      }
      if (!filedCount) console.log("attachments listed but no bytes in payload — falling through to API fetch");
    }
    if (!filedCount) {
      // Tier 2: body text. The email.received payload may be metadata-only
      // (no text/html) — in that case fetch the full email from Resend's API
      // (needs a RESEND_API_KEY secret). Keep html separately for the
      // image-fallback tier below.
      let bodyText: string = email.text || email.body || "";
      let bodyHtml: string = email.html || "";
      let apiAttachments: Array<Record<string, string>> = [];
      if ((!bodyText.trim() && !bodyHtml.trim()) || real.length) {
        console.log("fetching full email from Resend API — payload keys:", Object.keys(email).join(","));
        const key = Deno.env.get("RESEND_API_KEY");
        if (!key) console.error("RESEND_API_KEY not set — cannot fetch email content");
        else {
          for (const url of [
            `https://api.resend.com/emails/inbound/${emailId}`,
            `https://api.resend.com/emails/${emailId}`,
          ]) {
            try {
              const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
              console.log("fetch", url, "→", r.status);
              if (r.ok) {
                const full = await r.json();
                bodyText = full.text || bodyText;
                bodyHtml = full.html || bodyHtml;
                if (Array.isArray(full.attachments)) apiAttachments = full.attachments;
                console.log("API email: text?", !!bodyText.trim(), "html?", !!bodyHtml.trim(), "attachments:", apiAttachments.length, apiAttachments.map((a) => `${a.filename || "?"} keys:${Object.keys(a).join("+")}`).join(" | ") || "none");
                if (bodyText.trim() || bodyHtml.trim() || apiAttachments.length) break;
              }
            } catch (err) { console.error("email fetch failed:", String(err)); }
          }
        }
      }
      // Real bill attachments from the API-fetched email (payload had none/no bytes).
      const apiReal = apiAttachments.filter((a) => {
        const ct = (a.content_type || "").toLowerCase();
        if (ct === "application/pdf") return true;
        if (ct.startsWith("image/")) return (a.content_disposition || "") !== "inline" && !a.content_id;
        return false;
      });
      for (let i = 0; i < apiReal.length; i++) {
        const a = apiReal[i];
        const bytes = await attachmentBytes(a);
        if (!bytes) continue;
        const extracted = await extract(bytes, a.content_type);
        console.log("extracted (api attachment):", JSON.stringify(extracted));
        await fileInvoice(tenant.id, `${emailId}:${a.content_id || a.filename || i}`, extracted, bytes, a.content_type, a.filename || "attachment");
        filedCount++;
      }
      if (filedCount) return new Response("ok", { status: 200 });
      const readable = bodyText.trim() || bodyHtml.trim();
      const meaningful = (x: Record<string, unknown> | null) => !!x && (!!x.vendor || x.amount != null);

      let bodyExtracted: Record<string, unknown> | null = null;
      if (readable) {
        bodyExtracted = await extract(new TextEncoder().encode(bodyText.trim() ? bodyText : bodyHtml), "text/plain");
        console.log("extracted (body):", JSON.stringify(bodyExtracted));
      }

      if (meaningful(bodyExtracted)) {
        const src = bodyText.trim() ? bodyText : bodyHtml;
        const safeHtml = `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font-family:system-ui;padding:1rem">${
          src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre>`;
        await fileInvoice(tenant.id, `${emailId}:body`, bodyExtracted!, new TextEncoder().encode(safeHtml), "text/html", "email-body.html");
      } else {
        // Tier 3: the bill may BE an image in the body — inline CID image
        // attachments (excluded from tier 1 by design) or <img>-linked
        // images in the HTML. Read the actual image bytes with vision and
        // store the image itself as the invoice file. Size floor skips
        // logos/tracking pixels; largest first.
        const candidates: Array<{ bytes: Uint8Array; mime: string; name: string }> = [];
        for (const a of attachments) {
          const ct = (a.content_type || "").toLowerCase();
          if (!ct.startsWith("image/")) continue;
          const bytes = await attachmentBytes(a);
          if (bytes && bytes.length > 15_000) candidates.push({ bytes, mime: ct, name: a.filename || "inline-image" });
        }
        const urls = [...new Set([...bodyHtml.matchAll(/<img[^>]+src=["']?(https?:\/\/[^"'\s>]+)/gi)].map((m) => m[1]))].slice(0, 8);
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (!r.ok) continue;
            const ct = (r.headers.get("content-type") || "").split(";")[0].toLowerCase();
            if (!ct.startsWith("image/")) continue;
            const bytes = new Uint8Array(await r.arrayBuffer());
            if (bytes.length > 15_000) candidates.push({ bytes, mime: ct, name: (u.split("/").pop() || "image").split("?")[0].slice(0, 60) });
          } catch (_) { /* skip unreachable images */ }
        }
        candidates.sort((a, b) => b.bytes.length - a.bytes.length);
        console.log("image fallback candidates:", candidates.length, candidates.map((c) => `${c.name}(${c.bytes.length}b)`).join(", ") || "none");

        let filed = false;
        for (const img of candidates.slice(0, 3)) {
          const x = await extract(img.bytes, img.mime);
          console.log("extracted (image", img.name + "):", JSON.stringify(x));
          if (meaningful(x)) {
            await fileInvoice(tenant.id, `${emailId}:img`, x, img.bytes, img.mime, img.name);
            filed = true;
            break;
          }
        }
        if (!filed && readable) {
          // Nothing meaningful anywhere — file the body anyway (needs_review)
          // so the email isn't lost; the owner fills the fields by hand.
          const src = bodyText.trim() ? bodyText : bodyHtml;
          const safeHtml = `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font-family:system-ui;padding:1rem">${
            src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre>`;
          await fileInvoice(tenant.id, `${emailId}:body`, bodyExtracted || {}, new TextEncoder().encode(safeHtml), "text/html", "email-body.html");
        } else if (!filed) {
          console.error("no email content available — not filing");
          return new Response("no content", { status: 200 });
        }
      }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("email-inbound failure:", e); // log loudly, still 200
    return new Response("logged", { status: 200 });
  }
});
