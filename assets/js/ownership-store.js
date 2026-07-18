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

  // The `kind` column ships in migration 0005. Until it's applied, Postgres
  // rejects it as an undefined column (42703) — detect that so we can retry
  // without it and keep the graph fully usable in the meantime.
  const missingKind = (e) =>
    e && (e.code === "42703" || /column .*kind/i.test(e.message || ""));

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
        email: input.email ?? null,
        notes: input.notes ?? null,
        color: input.color ?? null,
        links: cleanLinks(input.links),
        position_x: input.position_x ?? 0,
        position_y: input.position_y ?? 0,
      };
      let { data, error } = await supabase.from("ownership_entities").insert(row).select().single();
      if (error && missingKind(error)) {
        delete row.kind;
        ({ data, error } = await supabase.from("ownership_entities").insert(row).select().single());
      }
      if (error) throw error;
      return { ...data, links: Array.isArray(data.links) ? data.links : [] };
    },

    async updateEntity(id, patch) {
      const p = {};
      for (const k of ["name", "category", "subcategory", "kind", "email", "notes", "color"]) {
        if (patch[k] !== undefined) p[k] = patch[k];
      }
      if (patch.links !== undefined) p.links = cleanLinks(patch.links);
      let { error } = await supabase.from("ownership_entities").update(p).eq("id", id);
      if (error && missingKind(error) && "kind" in p) {
        delete p.kind;
        ({ error } = await supabase.from("ownership_entities").update(p).eq("id", id));
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
