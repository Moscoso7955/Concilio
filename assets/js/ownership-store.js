/* ============================================================
   Ownership-graph data layer, backed by Supabase.
   Same API as the reference localStorage store — the UI never
   touches the backend directly, so this stays swappable.
   Async (Supabase is remote); shape/behavior is otherwise identical.
   Usage:  const store = createOwnershipStore(supabaseClient)
   ============================================================ */
window.createOwnershipStore = function (supabase) {
  const MAX_LINKS = 4;

  function cleanLinks(links) {
    if (!Array.isArray(links)) return [];
    return links
      .map((l) => ({ label: String(l.label ?? "").trim(), url: String(l.url ?? "").trim() }))
      .filter((l) => l.url !== "" || l.label !== "")
      .slice(0, MAX_LINKS);
  }

  // Optional columns ship in later migrations (`kind` → 0005, `in_reports` →
  // 0007). Until a migration is applied, Postgres rejects the column as
  // undefined (42703) — detect that so we can retry without the optional
  // fields and keep the graph fully usable in the meantime.
  const undefinedColumn = (e) => {
    if (!e) return false;
    if (e.code === "42703" || e.code === "PGRST204") return true; // undefined column / schema cache
    const m = `${e.message || ""} ${e.details || ""} ${e.hint || ""}`;
    return /schema cache/i.test(m) || /\b(kind|in_reports|in_marketing|managed_by)\b/.test(m);
  };
  const stripOptional = (row) => { const r = { ...row }; delete r.kind; delete r.in_reports; delete r.in_marketing; delete r.managed_by; return r; };

  return {
    async loadGraph() {
      const [{ data: entities }, { data: edges }] = await Promise.all([
        supabase.from("ownership_entities").select("*").order("created_at"),
        supabase.from("ownership_edges").select("*").order("created_at"),
      ]);
      return {
        entities: (entities || []).map((e) => ({ ...e, links: Array.isArray(e.links) ? e.links : [] })),
        edges: edges || [],
      };
    },

    async addEntity(input) {
      const row = {
        name: input.name ?? "New box",
        category: input.category ?? null,
        subcategory: input.subcategory ?? null,
        kind: input.kind === "entity" ? "entity" : "individual",
        in_reports: input.in_reports === true,
        email: input.email ?? null,
        notes: input.notes ?? null,
        color: input.color ?? null,
        links: cleanLinks(input.links),
        position_x: input.position_x ?? 0,
        position_y: input.position_y ?? 0,
      };
      let { data, error } = await supabase.from("ownership_entities").insert(row).select().single();
      if (error && undefinedColumn(error)) {
        ({ data, error } = await supabase.from("ownership_entities").insert(stripOptional(row)).select().single());
      }
      if (error) throw error;
      return { ...data, links: Array.isArray(data.links) ? data.links : [] };
    },

    async updateEntity(id, patch) {
      const p = {};
      for (const k of ["name", "category", "subcategory", "kind", "in_reports", "in_marketing", "managed_by", "email", "notes", "color"]) {
        if (patch[k] !== undefined) p[k] = patch[k];
      }
      if (patch.links !== undefined) p.links = cleanLinks(patch.links);
      let { error } = await supabase.from("ownership_entities").update(p).eq("id", id);
      if (error && undefinedColumn(error) && ("kind" in p || "in_reports" in p || "in_marketing" in p || "managed_by" in p)) {
        ({ error } = await supabase.from("ownership_entities").update(stripOptional(p)).eq("id", id));
      }
      if (error) throw error;
    },

    async updateEntityPositions(positions) {
      // One update per node; small graphs, fine to fire in parallel.
      await Promise.all(
        positions.map((p) =>
          supabase.from("ownership_entities").update({ position_x: p.x, position_y: p.y }).eq("id", p.id)),
      );
    },

    async deleteEntity(id) {
      // Edges cascade via the FK (on delete cascade).
      const { error } = await supabase.from("ownership_entities").delete().eq("id", id);
      if (error) throw error;
    },

    async addEdge(input) {
      if (input.parent_id === input.child_id) return { ok: false, error: "An entity cannot own itself" };
      const { data, error } = await supabase
        .from("ownership_edges")
        .insert({ parent_id: input.parent_id, child_id: input.child_id, percentage: input.percentage })
        .select().single();
      if (error) {
        if (error.code === "23505") return { ok: false, error: "That ownership link already exists — edit it instead." };
        if (error.code === "23514") return { ok: false, error: "An entity cannot own itself" };
        return { ok: false, error: error.message };
      }
      return { ok: true, edge: data };
    },

    async updateEdge(id, patch) {
      const { error } = await supabase.from("ownership_edges").update({ percentage: patch.percentage }).eq("id", id);
      if (error) throw error;
    },

    async deleteEdge(id) {
      const { error } = await supabase.from("ownership_edges").delete().eq("id", id);
      if (error) throw error;
    },
  };
};
