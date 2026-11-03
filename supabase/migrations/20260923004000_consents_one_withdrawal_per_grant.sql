-- ===========================================================================
-- Phase 8 Task 2, fix round 1 (review finding M2):
-- one withdrawal per grant, structurally.
-- ===========================================================================
-- private.consents_before_insert() serialises events per (user, purpose) with
-- an advisory lock and then reads the newest event. That alternation held
-- only under READ COMMITTED: two parallel withdrawals under REPEATABLE READ
-- both took their snapshot before either inserted, both waited on the lock,
-- both read the same grant as "newest" from their stale snapshots, and both
-- committed -- two withdrawal rows naming one grant (measured by the review;
-- not reachable over PostgREST, which runs READ COMMITTED, but reachable from
-- any direct database session).
--
-- THE FIX: a UNIQUE index on withdraws_id. A grant can be ended exactly once;
-- the second withdrawal is refused with 23505 whatever the isolation level
-- (unique checks see concurrently committed rows). Grants carry
-- withdraws_id = null, and nulls are distinct, so grants are unaffected.
--
-- Existing rows satisfy it: the alternation rule makes a second withdrawal of
-- one grant unreachable at READ COMMITTED, which is every client path, and
-- the index build itself fails loudly (rather than silently) if any database
-- holds such a pair -- in which case keep the earliest withdrawal and decide
-- the rest by hand; the ledger is evidence and must not be "fixed" blindly.
--
-- The unique index replaces the plain foreign-key index of the same column
-- (CLAUDE.md: index every foreign key -- the unique index serves the
-- ON DELETE CASCADE lookup just as well).
-- ===========================================================================

create unique index consents_withdraws_id_key on public.consents (withdraws_id);

drop index public.consents_withdraws_id_idx;

comment on index public.consents_withdraws_id_key is
  'One withdrawal per grant, whatever the isolation level (20260923004000, review finding M2). Also the foreign-key index for withdraws_id.';
