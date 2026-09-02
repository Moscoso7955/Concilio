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

// Breadcrumbs to console AND the function_logs table (readable via SQL, so
// failures can be diagnosed without dashboard access). Best-effort.
async function dblog(msg: string, detail: unknown = null) {
  console.log(msg, detail ? JSON.stringify(detail).slice(0, 800) : "");
  try { await admin.from("function_logs").insert({ fn: "email-inbound", msg, detail }); } catch (_) { /* table may not exist yet */ }
}

const CATEGORIES = [
  "Utilities", "Phone service", "Rent", "Repairs & maintenance", "Supplies",
  "Software Subscriptions", "Accounting fees", "Legal fees", "Marketing",
  "Office expenses", "Travel", "Travel Meals", "Merchant Processing Fees",
  "Bank fees & service charges", "Contract labor", "Interest Expense",
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

// Chunked base64 — btoa(String.fromCharCode(...bytes)) blows the call stack
// on large files (every byte becomes a function argument).
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function extract(bytes: Uint8Array, mime: string): Promise<Record<string, unknown>> {
  const b64 = toBase64(bytes);
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
    await dblog("anthropic error", { status: res!.status, message: data?.error?.message });
    return {};
  }
  try {
    const { data: t } = await admin.from("tenants").select("id").order("created_at").limit(1).single();
    await admin.from("ai_usage").insert({ tenant_id: t?.id, model: "claude-opus-4-8", input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens, purpose: "email" });
  } catch (_) { /* best-effort */ }
  const tb = (data.content || []).find((b: { type: string }) => b.type === "text");
  return JSON.parse(tb?.text || "{}");
}

// Repair a plain-text body that arrived garbled: UTF-8 read as
// Windows-1252 ("â€™" for apostrophes) and/or pre-escaped HTML entities.
const CP1252_REV: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
  0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
  0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
function fixText(s: string): string {
  let t = s;
  if (/\u00e2\u20ac|\u00c3[\u00a0-\u00ff]/.test(t)) {
    try {
      const bytes = Uint8Array.from([...t].map((ch) => {
        const c = ch.codePointAt(0)!;
        return c <= 0xff ? c : (CP1252_REV[c] ?? 0x3f);
      }));
      t = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_) { /* not mojibake after all — keep the original */ }
  }
  if (/&(lt|gt|quot|#39|amp);/.test(t)) {
    t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  return t;
}

// The file stored for a body-only email: prefer the HTML part so "View"
// renders like the original message; fall back to repaired plain text.
function buildBodyFile(bodyText: string, bodyHtml: string): { bytes: Uint8Array; mime: string; name: string } {
  if (bodyHtml.trim()) {
    const html = /<meta[^>]+charset/i.test(bodyHtml) ? bodyHtml : `<meta charset="utf-8">${bodyHtml}`;
    return { bytes: new TextEncoder().encode(html), mime: "text/html", name: "email.html" };
  }
  const src = fixText(bodyText);
  const safeHtml = `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font-family:system-ui;padding:1rem;max-width:70rem">${
    src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))}</pre>`;
  return { bytes: new TextEncoder().encode(safeHtml), mime: "text/html", name: "email-body.html" };
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
  // Vendor memory: a returning vendor's bill pre-fills its last-used GL
  // code, so repeat bills (e.g. a weekly invoice) are one-click approvals.
  let code: string | null = null;
  const vend = (extracted.vendor as string) || null;
  if (vend) {
    const { data: prev } = await admin.from("invoices").select("code")
      .ilike("vendor", vend).not("code", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    code = (prev?.code as string) ?? null;
  }
  const { error: insErr } = await admin.from("invoices").insert({
    tenant_id: tenantId,
    vendor: vend || "Unknown vendor",
    category: (extracted.category as string) || null,
    code,
    invoice_date: (extracted.invoiceDate as string) || null,
    amount: (extracted.amount as number) ?? null,
    needs_review: true,
    file_url, file_name: fileName,
    source_email_id: sourceKey,
  });
  if (insErr) await dblog("fileInvoice insert error", { sourceKey, error: insErr.message });
  else await dblog("filed invoice", { sourceKey, vendor: extracted.vendor, amount: extracted.amount, fileName });
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
    await dblog("event", { type: payload.type, emailId, to: recipients, payloadKeys: Object.keys(email) });
    // Log retention: trim breadcrumbs older than 30 days (best-effort).
    admin.from("function_logs").delete().lt("created_at", new Date(Date.now() - 30 * 86400_000).toISOString()).then(() => {}, () => {});
    const rec = recipients.map(String).join(",").toLowerCase();
    const token = (rec.match(/bills-([a-z0-9-]+)@/i) || [])[1];
    let tenant: { id: string } | null = null;
    if (token) tenant = (await admin.from("tenants").select("id").eq("inbound_token", token).single()).data;
    // Forgiving routing: ANY address on our inbound subdomain (receipts@,
    // bills@, a typo'd token…) files to the primary tenant. Mail for other
    // domains on the shared Resend account (e.g. Tipsy) is still ignored.
    if (!tenant && rec.includes("@bills.conciliowealth.com")) {
      tenant = (await admin.from("tenants").select("id").order("created_at").limit(1).single()).data;
      if (tenant) console.log("no/unknown token on our domain — defaulting to primary tenant");
    }
    if (!tenant) { console.log("not for us — ignoring:", rec.slice(0, 120)); return new Response("ignored", { status: 200 }); }
    console.log("tenant resolved", token ? `(token: ${token})` : "(domain default)");

    const attachments: Array<Record<string, string>> = email.attachments || [];
    await dblog("payload attachments", { count: attachments.length, each: attachments.map((a) => ({ name: a.filename, type: a.content_type, keys: Object.keys(a) })) });
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
        await dblog("attachment url fetch failed", { status: r.status, url: url.slice(0, 120) });
      }
      await dblog("attachment has no bytes", { keys: Object.keys(a), name: a.filename });
      return null;
    }

    let filedCount = 0;
    if (real.length) {
      for (let i = 0; i < real.length; i++) {
        const a = real[i];
        const bytes = await attachmentBytes(a);
        if (!bytes) continue;
        const extracted = await extract(bytes, a.content_type);
        await dblog("extracted (payload attachment)", extracted);
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
      let rawRef: string | null = null; // full.raw — MIME source (or a URL to it)

      // Fetch one attachment's bytes by its id (the API lists attachments
      // id-only; the content lives behind a per-attachment endpoint).
      async function fetchAttachmentById(attId: string): Promise<Uint8Array | null> {
        const key = Deno.env.get("RESEND_API_KEY");
        if (!key || !attId) return null;
        for (const url of [
          `https://api.resend.com/emails/inbound/${emailId}/attachments/${attId}`,
          `https://api.resend.com/emails/${emailId}/attachments/${attId}`,
        ]) {
          try {
            const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
            await dblog("attachment fetch", { url: url.slice(0, 110), status: r.status, ct: r.headers.get("content-type") });
            if (!r.ok) continue;
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) {
              const j = await r.json();
              if (j.content) return Uint8Array.from(atob(j.content), (c) => c.charCodeAt(0));
              const u = j.download_url || j.url;
              if (u) { const rr = await fetch(u); if (rr.ok) return new Uint8Array(await rr.arrayBuffer()); }
              await dblog("attachment json without content", { keys: Object.keys(j) });
              return null;
            }
            return new Uint8Array(await r.arrayBuffer());
          } catch (e) { await dblog("attachment fetch threw", { err: String(e).slice(0, 150) }); }
        }
        return null;
      }

      // Last resort: pull the attachment's base64 section out of the raw
      // MIME source by filename.
      function attachmentFromRaw(raw: string, filename: string): Uint8Array | null {
        if (!filename) return null;
        const idx = raw.indexOf(filename);
        if (idx < 0) return null;
        const after = raw.slice(idx);
        const headerEnd = after.search(/\r?\n\r?\n/);
        if (headerEnd < 0) return null;
        const bodyStart = headerEnd + (after.slice(headerEnd).match(/^\r?\n\r?\n/)?.[0].length || 2);
        const rest = after.slice(bodyStart);
        const boundary = rest.search(/\r?\n--/);
        const b64 = rest.slice(0, boundary > 0 ? boundary : undefined).replace(/[\s\r\n]/g, "");
        if (b64.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
        try { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return null; }
      }
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
              if (!r.ok) { await dblog("api fetch", { url: url.slice(0, 80), status: r.status, body: (await r.text()).slice(0, 200) }); continue; }
              const full = await r.json();
              bodyText = full.text || bodyText;
              bodyHtml = full.html || bodyHtml;
              if (Array.isArray(full.attachments)) apiAttachments = full.attachments;
              if (typeof full.raw === "string" && full.raw) rawRef = full.raw;
              await dblog("api email", {
                url: url.slice(0, 80), status: r.status, fullKeys: Object.keys(full),
                hasText: !!bodyText.trim(), hasHtml: !!bodyHtml.trim(),
                attachments: apiAttachments.map((a) => ({ name: a.filename, type: a.content_type, keys: Object.keys(a) })),
              });
              if (bodyText.trim() || bodyHtml.trim() || apiAttachments.length) break;
            } catch (err) { await dblog("api fetch threw", { url: url.slice(0, 80), err: String(err).slice(0, 200) }); }
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
        let bytes = a.id ? await fetchAttachmentById(String(a.id)) : null;
        if (!bytes) bytes = await attachmentBytes(a);
        if (!bytes && rawRef) {
          let raw: string | null = rawRef;
          if (rawRef.startsWith("http")) {
            try { const r = await fetch(rawRef); raw = r.ok ? await r.text() : null; } catch { raw = null; }
          }
          if (raw) bytes = attachmentFromRaw(raw, a.filename || "");
          if (bytes) await dblog("attachment recovered from raw MIME", { name: a.filename, bytes: bytes.length });
        }
        if (!bytes) continue;
        const extracted = await extract(bytes, a.content_type);
        await dblog("extracted (api attachment)", extracted);
        await fileInvoice(tenant.id, `${emailId}:${a.content_id || a.filename || i}`, extracted, bytes, a.content_type, a.filename || "attachment");
        filedCount++;
      }
      if (filedCount) return new Response("ok", { status: 200 });
      const readable = bodyText.trim() || bodyHtml.trim();
      const meaningful = (x: Record<string, unknown> | null) => !!x && (!!x.vendor || x.amount != null);

      let bodyExtracted: Record<string, unknown> | null = null;
      if (readable) {
        bodyExtracted = await extract(new TextEncoder().encode(bodyText.trim() ? fixText(bodyText) : bodyHtml), "text/plain");
        await dblog("extracted (body)", bodyExtracted);
      }

      if (meaningful(bodyExtracted)) {
        const f = buildBodyFile(bodyText, bodyHtml);
        await fileInvoice(tenant.id, `${emailId}:body`, bodyExtracted!, f.bytes, f.mime, f.name);
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
        await dblog("image fallback candidates", candidates.map((c) => ({ name: c.name, bytes: c.bytes.length })));

        let filed = false;
        for (const img of candidates.slice(0, 3)) {
          const x = await extract(img.bytes, img.mime);
          await dblog("extracted (image " + img.name + ")", x);
          if (meaningful(x)) {
            await fileInvoice(tenant.id, `${emailId}:img`, x, img.bytes, img.mime, img.name);
            filed = true;
            break;
          }
        }
        if (!filed && readable) {
          // Nothing meaningful anywhere — file the body anyway (needs_review)
          // so the email isn't lost; the owner fills the fields by hand.
          const f = buildBodyFile(bodyText, bodyHtml);
          await fileInvoice(tenant.id, `${emailId}:body`, bodyExtracted || {}, f.bytes, f.mime, f.name);
        } else if (!filed) {
          await dblog("no email content available — not filing");
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
