-- Phase 7 Task 5, fix round 1, minor M5: the incident-alert list is paginated,
-- so it needs the index a keyset pager reads.
--
-- The list shipped as a flat `limit 50` with no cursor and no filter. That
-- satisfies CLAUDE.md's page-size ceiling and NOT its "Paginate everything. No
-- unbounded list endpoint" rule -- and finding I1's flood scenario turns the
-- 50-row cap into an operator-facing failure rather than a nicety: alerts a
-- caller could file at ~2/minute would push every real one off the operator's
-- only triage surface, with no way to reach them from the UI at all.
--
-- `incident_alerts_created_at_idx` (created_at desc) already exists and orders
-- the page. The keyset predicate is the two-part `(created_at, id)` shape
-- lib/list/query.ts documents at length -- a redundant range bound plus an
-- OR'd exact tie-break -- so the tie-break column belongs in the index or the
-- planner re-sorts every page. The audit log viewer's
-- `audit_events_created_at_id_desc_idx` (20260908010000) is the same index for
-- the same reason; this is its sibling.
--
-- The older single-column index is LEFT IN PLACE deliberately: it is what the
-- health snapshot's four `created_at >= now() - interval` abuse counts read,
-- and those never touch `id`.
--
-- ADDITIVE.

create index incident_alerts_created_at_id_desc_idx
  on public.incident_alerts (created_at desc, id desc);

comment on index public.incident_alerts_created_at_id_desc_idx is
  'Backs the /super/health alert list''s keyset pager (lib/admin/health.ts): ORDER BY created_at desc, id desc with the (created_at, id) tie-break predicate. Sibling of audit_events_created_at_id_desc_idx, added when the list stopped being a flat 50-row ceiling (fix round 1, M5).';
