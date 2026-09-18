// Platform console: delete a workspace outright. Platform admins only.
// Storage rows can't be deleted from SQL, so this function removes the
// workspace's files through the Storage API (service role) and then
// calls platform_delete_workspace(p_ws, p_confirm) AS THE CALLER, so the
// database re-checks platform admin, the typed name, and the guards
// (never the platform workspace, never your own). The cheap checks are
// repeated here first so no file is removed for a request the RPC would
// refuse. Deploy with verify_jwt = FALSE (browser preflight).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const PLATFORM_WS = "00000000-0000-0000-0000-0000000000c0";
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await createClient(SUPABASE_URL, ANON).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: prof } = await admin.from("profiles").select("platform_admin,workspace_id,home_workspace_id").eq("id", user.id).single();
  if (!prof?.platform_admin) return json({ error: "Platform admins only" }, 403);

  let wsId = "", confirm = "";
  try { const b = await req.json(); wsId = String(b.workspace_id || ""); confirm = String(b.confirm || "").trim(); } catch (_) { /* below */ }
  if (!/^[0-9a-f-]{36}$/i.test(wsId)) return json({ error: "workspace_id required" }, 400);
  if (wsId === PLATFORM_WS) return json({ error: "The platform workspace cannot be deleted" }, 400);
  if (wsId === (prof.home_workspace_id || prof.workspace_id)) return json({ error: "You cannot delete your own workspace" }, 400);
  const { data: ws } = await admin.from("workspaces").select("id,name").eq("id", wsId).maybeSingle();
  if (!ws) return json({ error: "Workspace not found" }, 404);
  if (confirm !== ws.name) return json({ error: "Type the workspace name exactly to confirm" }, 400);

  // The caller's own session for the RPCs — the database does the real gating.
  const asUser = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });

  // Files first: list via SQL (allowed), remove via the Storage API (required).
  const { data: files, error: fErr } = await asUser.rpc("platform_workspace_files", { p_ws: wsId });
  if (fErr) return json({ error: "Listing files failed: " + fErr.message }, 500);
  const byBucket = new Map<string, string[]>();
  for (const f of (files || []) as { bucket_id: string; name: string }[]) {
    (byBucket.get(f.bucket_id) || byBucket.set(f.bucket_id, []).get(f.bucket_id)!).push(f.name);
  }
  let removed = 0;
  const failed: string[] = [];
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100);
      const { data, error } = await admin.storage.from(bucket).remove(batch);
      if (error) failed.push(`${bucket}: ${error.message}`);
      else removed += (data || []).length;
    }
  }
  if (failed.length) return json({ error: "Some files could not be removed — nothing else was deleted. " + failed.join("; ") }, 500);

  const { data, error } = await asUser.rpc("platform_delete_workspace", { p_ws: wsId, p_confirm: confirm });
  if (error) return json({ error: error.message }, 400);
  try { await admin.from("function_logs").insert({ fn: "platform-delete-workspace", msg: "deleted", detail: { ...data, files: removed, by: user.email } }); } catch (_) { /* best effort */ }
  return json({ ...(data as Record<string, unknown>), files: removed });
});
