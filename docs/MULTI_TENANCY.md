# Concilio as a user-based product — multi-tenancy plan

Noted 2026-09-02. Design only; nothing implemented yet.

**Decision (Christian, 2026-09-02):** signup creates a workspace the
user can invite others into. One workspace per person in v1; a
switcher and multi-membership come later.

## Where we are

The portal inherited from Callidus is **single-tenant**: one database,
one set of owners, one ownership graph. Sign-in is gated by an
`allowed_owners` allowlist enforced in the signup trigger; anyone not
pre-approved is rejected at the door. Every RLS policy resolves access
through global helpers (`is_admin`, `is_member`, `is_staff`,
`can_market`, `visible_entity_ids`, `manages_entity`) that answer "is
this person an admin/member of *the* portal", never "of *which*
workspace". 24 tables, 46 policies, all built on that assumption.

## Where we're going

Anyone can sign up (email magic link or Google), and on first sign-in
gets their own space where the node system — the ownership graph of
boxes and percentage edges, units, reports, documents, distributions —
works exactly as it does today, scoped to them.

## Shape: workspaces, not per-user rows

The natural tenancy unit is a **workspace** (an org), not the user:

- A user signs up → a workspace is created with them as its admin.
- Every domain table gains `workspace_id` (uuid, not null, FK).
- `workspace_members (workspace_id, user_id, role)` replaces
  `allowed_owners` as the access model. The existing roles table and
  tab permissions carry over, scoped per workspace.
- The global helpers become workspace-aware:
  `is_admin(ws)`, `is_member(ws)`, `visible_entity_ids(ws)` …, and
  every policy adds `workspace_id = current_workspace()`.
- Invites move from "add to allowlist" to "invite to my workspace" —
  the same portal UI (Owners tab), now writing to `workspace_members`.
  The partner-link protocol (publish/subscribe feeds between portals)
  becomes a link between two workspaces in the same database, which is
  simpler than today's cross-database version.
- The public coming-soon page and `site_content` stay platform-level.

Why workspaces over a personal space per user: the graph already has
multiple humans on it — owners, principals, accountants, partners
receiving distributions. A user who signs up alone still gets a
one-member workspace, so the simple case costs nothing, and the
multi-owner case (the reason the node system exists) keeps working.

## Sequence

1. **Schema** — `workspaces`, `workspace_members`, `workspace_id` on
   every domain table, current-workspace helper, rewrite the helpers
   and all policies. Migrate the existing single tenant into workspace
   #1 so nothing already entered is lost.
2. **Signup** — drop the allowlist rejection in `handle_new_user`;
   create profile + workspace + admin membership instead. Google and
   magic-link both flow through it unchanged.
3. **Portal** — workspace context in the client (one workspace per
   user to start; a switcher later), scope every query, replace the
   Owners tab's allowlist writes with membership writes, add a
   first-run "name your workspace" step.
4. **Edge functions** — every function that reads/writes domain data
   takes the workspace from the caller's membership, never from a
   global lookup.
5. **Billing / plans** — out of scope for the first cut, but
   `workspaces` is where a plan column will live.

## Open questions
- Does the existing Callidus/FBH data migrate in as workspace #1, or
  does Concilio start empty? (The Concilio database is empty today, so
  this only matters if Callidus data is imported later.)
- Sequencing: the workspace signup trigger replaces the allowlist
  trigger, so land it after Google OAuth + Resend are verified working
  against the current trigger, not in the middle.
