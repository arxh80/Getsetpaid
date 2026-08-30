-- Corrects two things in the notes `20260828190000` put on the four trigram
-- indexes. Additive and idempotent: `comment on index` overwrites, so this
-- supersedes that migration's values without amending an applied file.
--
-- WHY A SECOND MIGRATION RATHER THAN AN EDIT. Foundation's `20260826154304`
-- was amended in place across three fix rounds AFTER it had been applied to
-- the hosted project, and `db push` skips a version the remote already
-- records -- so the hosted database still holds whichever revision it got and
-- no push will ever correct it. That is the failure this project does not
-- repeat, regardless of whether a particular file happens to be unapplied
-- today.
--
-- ===========================================================================
-- CORRECTION 1 (the clause was one clause too strong)
-- ===========================================================================
--
-- `20260828190000`, lib/list/query.ts and FOLLOW-UPS.md all said:
--
--   "...so a non-leakproof operator can never become an Index Cond on a table
--    with RLS enabled."
--
-- RLS being ENABLED on the table is not the condition. The condition is that
-- RLS security quals actually apply TO THIS CALLER. Measured: `contacts` has
-- relrowsecurity = t, `postgres` has rolbypassrls = t, and as `postgres` the
-- trigram index IS chosen -- and is still chosen after
--
--   alter table public.contacts force row level security;
--
-- (0.045 ms with FORCE on, 0.044 ms off; identical plans). So the same
-- paragraph's own `postgres` control was a counter-example to its own sentence.
--
-- This is load-bearing rather than pedantic: the entire SECURITY DEFINER
-- consequence -- the fix FOLLOW-UPS.md specifies for Task 6's dedup helper --
-- turns on exactly this distinction. If the condition really were "RLS enabled
-- on the table", a definer function reading `contacts` would gain nothing.
--
-- The correct statement, used below:
--
--   Postgres will not promote a non-leakproof qual to an index qual on a
--   relation that carries RLS security quals for the current caller. A role
--   RLS does not apply to (BYPASSRLS, or the table owner without FORCE ROW
--   LEVEL SECURITY) has no such quals -- which is why the same statement as
--   `postgres` uses the trigram index, and why a SECURITY DEFINER function
--   owned by such a role can too.
--
-- Also worth recording: `20260828190000`'s controlled pair (`name >= 'x'`
-- against `name like 'x%'`) varies leakproofness AND which index can serve the
-- operator, so it is suggestive, not decisive. The decisive experiment holds
-- role, RLS, index, statement and session fixed and flips ONLY
-- pg_proc.proleakproof:
--
--   texticlike     f -> t   27.379 ms Seq Scan -> 0.855 ms Bitmap Index Scan
--                           Index Cond: (name ~~* '%Wilhelmina%')
--   similarity_op  f -> t   31.345 ms          -> 0.566 ms
--
-- ===========================================================================
-- CORRECTION 2 (two write-cost numbers that do not reproduce)
-- ===========================================================================
--
-- Re-measured over three further alternated rounds -- 2,000 inserts, an update
-- of the INDEXED column on those rows, an update of a NON-indexed column, then
-- a delete -- after a discarded warm-up:
--
--   "~+0.033 ms per inserted row"  ->  +0.01-0.03 ms (+24.0 ms per 2,000)
--   "~+35% on a bulk update"       ->  ~2.0x (125.5 ms vs 61.5 ms) WHEN THE
--                                      INDEXED COLUMN IS THE ONE UPDATED.
--                                      +35% is what you get updating some
--                                      other column, so the original
--                                      understated the worst case ~3x.
--                                      Updating a non-indexed column is a HOT
--                                      update and costs nothing measurable;
--                                      deletes are noise.
--   "5.7 MB per 25,000 contacts"   ->  824 kB for 25,411 rows here
--                                      (pg_relation_size), against 8,624 kB
--                                      for contacts_org_name_id_live_idx and
--                                      an 11 MB heap. Trigram index size is
--                                      dominated by DISTINCT TRIGRAM COUNT, so
--                                      this is fixture-dependent: a bare
--                                      "5.7 MB per 25,000" reads as a property
--                                      of the schema and is not one.
--
-- The benefit was also reproduced independently and is larger than claimed:
-- 0.159 ms against 31.233 ms over 20 calls each inside a real SECURITY DEFINER
-- probe -- 196x, not 142x.
--
-- THE DECISION DOES NOT MOVE: keep all four. 196x on the one shape the index
-- exists for, against ~0.02 ms per inserted row, is not a close call. Only the
-- numbers a DBA would use to size a bulk import change.

comment on index public.contacts_name_trgm_idx is
  'Trigram index on name. NEVER USED FROM THE POSTGREST PATH and that is expected, not a defect: ILIKE and the pg_trgm `%` operator are NOT leakproof (pg_proc.proleakproof = false), and Postgres will not promote a non-leakproof qual to an index qual on a relation carrying RLS security quals FOR THE CURRENT CALLER. Note the caller, not the table: `contacts` has relrowsecurity = t and `postgres` still uses this index (0.114 ms against 39.0 ms as `authenticated`), and still does under FORCE ROW LEVEL SECURITY, because it is BYPASSRLS. That is precisely why the index IS reachable, and worth 196x (0.159 ms vs 31.2 ms on 25k rows), inside a SECURITY DEFINER function owned by the table owner -- which is exactly how FOLLOW-UPS.md specifies Task 6''s dedup helper. Kept for that consumer. Write cost: +0.01-0.03 ms per inserted row; a bulk update OF THIS COLUMN roughly doubles; updating other columns is a HOT update and costs nothing measurable. Size is fixture-dependent (dominated by distinct trigram count): 824 kB per 25k rows here, budget 1-6 MB. Drop it if Task 6 ships dedup without a SECURITY DEFINER path -- at that point it has no reachable consumer at all.';

comment on index public.companies_name_trgm_idx is
  'See contacts_name_trgm_idx: unreachable from the PostgREST path because a non-leakproof operator cannot be promoted to an index qual for a caller RLS applies to; 196x inside the SECURITY DEFINER dedup helper Task 6 is specified to write, which is owned by the table owner and so has no such quals. Kept for that consumer.';

comment on index public.artists_name_trgm_idx is
  'See contacts_name_trgm_idx: unreachable from the PostgREST path because a non-leakproof operator cannot be promoted to an index qual for a caller RLS applies to; 196x inside the SECURITY DEFINER dedup helper Task 6 is specified to write, which is owned by the table owner and so has no such quals. Kept for that consumer.';

comment on index public.venues_name_trgm_idx is
  'See contacts_name_trgm_idx: unreachable from the PostgREST path because a non-leakproof operator cannot be promoted to an index qual for a caller RLS applies to; 196x inside the SECURITY DEFINER dedup helper Task 6 is specified to write, which is owned by the table owner and so has no such quals. Kept for that consumer.';

-- contacts_organisation_id_idx's note ends with the same over-strong phrasing
-- ("no index can serve a non-leakproof operator under RLS"). Same correction:
-- it is the caller, not the table.
comment on index public.contacts_organisation_id_idx is
  'Plain btree on (organisation_id). Looks redundant beside contacts_org_name_id_live_idx, whose leading column it is -- IT IS NOT, and the next person to read the two definitions side by side will reach for `drop index` and be wrong. That one is PARTIAL (`where deleted_at is null`), so it cannot serve any lookup that must reach soft-deleted rows: restore flows, DSR export, retention sweeps, private.entity_org_unchanged(), and Task 6''s merge reading the loser it just soft-deleted. This one is also what the planner falls back to for a search, because no index can serve a non-leakproof operator for a caller that RLS applies to -- which is every `authenticated` session, though not `postgres` and not a SECURITY DEFINER body owned by the table owner.';
