-- Phase 2 (Core CRM), Task 3 fix round 1: corrections to the notes on the list
-- indexes, and the decision on the four trigram indexes.
--
-- Additive. No previously applied migration is edited -- the precedent Task 1
-- and Task 2 set for every correction in this phase. `comment on index` is
-- used rather than a prose file because these are claims a DBA reads next to
-- the index definition, and the copy that travels is the database's.
--
-- NOTHING HERE CREATES OR DROPS AN INDEX. Two claims are corrected and one
-- decision is recorded with the measurement behind it.
--
-- ===========================================================================
-- CORRECTION 1: "search is trigram-backed ... 1.079 ms" IS WRONG
-- ===========================================================================
-- 20260828180000's header, and the Task 3 report, concluded that the trigram
-- index is unused but the new composite btree serves search at 1.079 ms. The
-- first half is right. The second is true only of the term that fixture used
-- and is the smaller half of the consequence.
--
-- 1.079 ms was measured on a term matching ~4% of the tenant -- dense enough
-- that walking the ordered index and stopping at 26 wins. A user types a
-- surname. Re-measured on 19,882 live rows in one organisation as the real
-- `authenticated` role, on a term matching ONE row:
--
--   page   Index Scan on contacts_organisation_id_idx    39.002 ms
--          Rows Removed by Filter: 20000
--   count  the same shape                                35.926 ms
--
-- So a realistic search is TWO scans of the tenant, ~75 ms of database time at
-- 20k rows, growing linearly with the customer's success. The list's headline
-- property -- O(page) paging -- does not extend to the search path at all.
--
-- ===========================================================================
-- WHY, TESTED RATHER THAN ASSERTED
-- ===========================================================================
-- 20260828180000 deliberately declined to name a mechanism, having watched
-- this phase be bitten three times by comments that stated one instead of
-- measuring it. The mechanism is now established, by a controlled pair.
--
--   select p.proname, p.proleakproof
--     from pg_operator o join pg_proc p on p.oid = o.oprcode
--    where o.oprname in ('~~*','%','>=') and o.oprleft = 'text'::regtype;
--
--     texticlike     f     -- ILIKE
--     similarity_op  f     -- pg_trgm's `%`
--     text_ge        t     -- `>=`
--
-- Postgres will not evaluate a NON-LEAKPROOF qual before an RLS security qual,
-- so a non-leakproof operator can never become an Index Cond on a table with
-- RLS enabled. Same index, same fixture, same session -- the only difference
-- is which operator:
--
--   name >= 'Wilhelmina'      Index Cond: (organisation_id = ... AND name >= ...)
--                             1.425 ms, Heap Fetches: 0
--   name like 'Wilhelmina%'   Index Cond: (organisation_id = ...) only,
--                             20,000 Rows Removed by Filter, 6.853 ms
--
-- That is the whole explanation, and it is a property of RLS plus the
-- operator, not of this schema. It predicts, correctly, every observation:
--
--   * contacts_name_trgm_idx has never been chosen by any application query
--     (0 scans across two full browser walkthroughs and every plan taken);
--   * a composite `gin (organisation_id, name gin_trgm_ops) where deleted_at
--     is null` -- the obvious fix, which the review recommended measuring --
--     was created, ANALYZEd and measured, and is ALSO never chosen: the same
--     selective search stayed at 24.313 ms on contacts_organisation_id_idx.
--     It was dropped again. Adding an index cannot help, because the blocker
--     is not the absence of an index;
--   * the identical statement as `postgres`, where no policy applies, uses
--     contacts_name_trgm_idx in 0.114 ms.
--
-- NO INDEX THIS PROJECT CAN ADD WILL MAKE SEARCH INDEXABLE FROM THE POSTGREST
-- PATH. The ceiling is recorded in FOLLOW-UPS.md as a number, and a real
-- search design is scoped there rather than built here.
--
-- ===========================================================================
-- CORRECTION 2: WHY THE TRIGRAM INDEXES ARE KEPT (the old reason was wrong)
-- ===========================================================================
-- 20260828180000 kept contacts_name_trgm_idx because "it was created for Task
-- 6's dedup lookup, which has no ORDER BY and a different predicate". The
-- review measured that shape and it is a Seq Scan too, so the stated reason
-- does not hold. It was the right decision for the wrong reason.
--
-- The reason that does hold: FOLLOW-UPS.md specifies Task 6's dedup helper as
-- a SECURITY DEFINER function with `search_path` locked and the trigram
-- operator schema-qualified. SECURITY DEFINER does not apply RLS to the table
-- it reads, which is the one context where a non-leakproof operator CAN reach
-- an index. Measured, with exactly that function shape:
--
--   private.dedup_probe(org, name), trigram index present    0.36-0.53 ms
--   the same function, index dropped                        48.1-50.9 ms
--                                                            Seq Scan, 25,000
--                                                            rows filtered
--
-- 142x on the shape the index exists for, in the context Task 6 is already
-- required to use.
--
-- WRITE COST, MEASURED, because "keep it" needs both sides. 2,000 inserts and
-- one bulk update of 2,000 rows, alternated with and without all four trigram
-- indexes so a warm cache favours neither:
--
--   with     2000 inserts  144.7 / 147.1 / 102.7 / 147.1 ms   update 78-99 ms
--   without  2000 inserts   77.0 /  82.9 ms                   update 57-61 ms
--
-- ~+0.033 ms per row inserted, and 5.7 MB per 25,000 contacts. A 10,000-row
-- bulk import pays about a third of a second.
--
-- DECISION: KEEP all four. The cost is small and bounded; the benefit is
-- large, specific, and lands in a task that is already specified to use it.
-- Revisit if Task 6 ships dedup WITHOUT a SECURITY DEFINER helper -- at that
-- point the indexes have no reachable consumer and should be dropped.

comment on index public.contacts_name_trgm_idx is
  'Trigram index on name. NEVER USED BY THE APPLICATION and that is expected, not a defect: ILIKE and the pg_trgm `%` operator are NOT leakproof (pg_proc.proleakproof = false), and Postgres will not evaluate a non-leakproof qual before an RLS security qual, so neither can become an Index Cond on this table. Measured: the same selective search is 39.0 ms as `authenticated` and 0.114 ms as `postgres`. It IS used, and is worth 142x (0.36 ms vs 48-51 ms on 25k rows), inside a SECURITY DEFINER function -- which is exactly how FOLLOW-UPS.md specifies Task 6''s dedup helper. Kept for that consumer. Write cost measured at ~+0.033 ms per inserted row. Drop it if Task 6 ships dedup without a SECURITY DEFINER path.';

comment on index public.companies_name_trgm_idx is
  'See contacts_name_trgm_idx: unusable from the PostgREST path under RLS (non-leakproof operator), 142x inside the SECURITY DEFINER dedup helper Task 6 is specified to write. Kept for that consumer.';

comment on index public.artists_name_trgm_idx is
  'See contacts_name_trgm_idx: unusable from the PostgREST path under RLS (non-leakproof operator), 142x inside the SECURITY DEFINER dedup helper Task 6 is specified to write. Kept for that consumer.';

comment on index public.venues_name_trgm_idx is
  'See contacts_name_trgm_idx: unusable from the PostgREST path under RLS (non-leakproof operator), 142x inside the SECURITY DEFINER dedup helper Task 6 is specified to write. Kept for that consumer.';

-- ===========================================================================
-- CORRECTION 3: the tenant filter IS a plan control, not only a correctness one
-- ===========================================================================
-- 20260828180000 shipped alongside a comment in lib/list/query.ts saying the
-- explicit `organisation_id =` clause "is a CORRECTNESS control, not a
-- performance one", on a measurement taken BEFORE that migration created
-- contacts_org_name_id_live_idx. Both plans were Seq Scans then because
-- neither had an index to use. Re-measured with the index in place, which is
-- the state the code ships in:
--
--   with it      Index Scan using contacts_org_name_id_live_idx
--                1.790 ms   shared hit=317
--   without it   Seq Scan + top-N heapsort of 19,882 rows
--                13.141 ms  shared hit=498
--
-- organisation_id is the index's LEADING COLUMN, so the clause is what makes
-- the index reachable at all. Corrected in the code comment as well, because
-- that is the copy a Task 4 author reads while deciding whether their
-- single-org page needs the clause.

comment on index public.contacts_org_name_id_live_idx is
  'Contacts list, default sort. (organisation_id, name, id) so the keyset tie-break is part of the range; include(owner_user_id) so the RLS record-scope term is answerable without a heap fetch; partial on deleted_at is null because RLS does not hide soft-deleted rows and the query must. THE QUERY''S EXPLICIT `organisation_id =` IS WHAT MAKES THIS INDEX REACHABLE -- it is the leading column, and without the clause the plan is a Seq Scan plus a top-N sort (13.141 ms vs 1.790 ms on 19,882 rows). Search is NOT served by this index for a selective term; see contacts_name_trgm_idx for why no index can be.';

-- ===========================================================================
-- CORRECTION 4 (review M-8): contacts_organisation_id_idx is now a strict
-- prefix of contacts_org_name_id_live_idx. It is NOT redundant.
-- ===========================================================================
comment on index public.contacts_organisation_id_idx is
  'Plain btree on (organisation_id). Looks redundant beside contacts_org_name_id_live_idx, whose leading column it is -- IT IS NOT, and the next person to read the two definitions side by side will reach for `drop index` and be wrong. That one is PARTIAL (`where deleted_at is null`), so it cannot serve any lookup that must reach soft-deleted rows: restore flows, DSR export, retention sweeps, private.entity_org_unchanged(), and Task 6''s merge reading the loser it just soft-deleted. This one is also what the planner falls back to for a search, since no index can serve a non-leakproof operator under RLS.';
