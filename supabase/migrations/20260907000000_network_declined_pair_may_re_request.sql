-- Phase 6 (Network), post-Task-6: Q79 CHANGED BY THE FOUNDER (2026-09-07) --
-- a DECLINED pair may re-request. Declined is no longer terminal FOR THE PAIR.
--
-- ===========================================================================
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
-- ===========================================================================
-- Q79 shipped as: pending -> accepted | declined | withdrawn, with the
-- live-pair partial unique index covering ('pending','accepted','declined') so
-- a declined pair could never be asked again -- "declined is final" was the
-- one zero-cost anti-harassment control in a product with no blocking or
-- moderation subsystem. The founder reversed that half on 2026-09-07 (the
-- ruling Q79's own default anticipated: "Founder can enable re-requests by
-- narrowing the index"): an organisation that was declined MAY send a fresh
-- request to the same profile.
--
-- ONE THING CHANGES: the partial predicate narrows to ('pending','accepted').
-- A declined row no longer occupies the pair's slot, so a fresh INSERT for the
-- same (from_organisation_id, to_network_profile_id) succeeds -- a NEW row
-- beside the old record, never a resurrection of the old one.
--
-- EVERYTHING ELSE HOLDS:
--   * The ROW stays terminal. private.network_request_status_transition_guard
--     is untouched: a declined row's status is immutable for every writer,
--     `postgres` included (rls_phase6_network.sql NR10). The old decline stays
--     on the books, which is the append-only shape the table comment promises
--     ("a richer record than a tombstone").
--   * `withdrawn` behaviour is unchanged -- it was never in the predicate.
--   * A PENDING or ACCEPTED request still blocks the pair. NR6c is the new
--     assertion that the narrowed index still refuses a duplicate while the
--     re-request stands, so the narrowing cannot drift into "no index at all".
--
-- ===========================================================================
-- THE RESIDUAL, STATED SO NOBODY REDISCOVERS IT AS A FINDING
-- ===========================================================================
-- Re-request-after-decline reopens the harassment/spam vector the old
-- predicate closed: a declined organisation can decline-and-be-asked-again
-- indefinitely, and nothing meters it -- there is still no blocking, reporting
-- or moderation subsystem, and SECURITY.md § 5's 30 req/min network rate limit
-- is NOT IMPLEMENTED (deferred to Phase 7, Q86/Q87). The mitigation is that
-- Phase 7 limiter, NOT anything in this migration. FOLLOW-UPS.md's Q79 entry
-- and DECISIONS-QUEUE.md carry the same flag.
--
-- ===========================================================================
-- ADDITIVE, PER THE STANDING RULE
-- ===========================================================================
-- No shipped migration file is edited. An index's predicate cannot be ALTERed,
-- so this is drop-and-recreate UNDER THE SAME NAME -- the name is load-bearing
-- (20260904000000's comments, lib/network/connections.ts and the psql suite
-- all cite network_connection_requests_live_pair). The `--` block comments in
-- 20260904000000 still carry the old wording, immutably; the re-issued
-- `comment on` statements below are the correction of record, per the
-- 20260904007000 precedent (a later migration may additively reissue a live
-- object's comment; it may not rewrite a shipped file). D3 (every FK's leading
-- column indexed) keeps holding through the recreate because the column list
-- is unchanged and both statements run in this migration's one transaction.

drop index public.network_connection_requests_live_pair;

-- Q79 as changed 2026-09-07: only a LIVE request occupies the pair's slot.
create unique index network_connection_requests_live_pair
  on public.network_connection_requests (from_organisation_id, to_network_profile_id)
  where status in ('pending','accepted');

comment on index public.network_connection_requests_live_pair is
  'Q79, AS CHANGED BY THE FOUNDER 2026-09-07 (shipped in 20260904000000 covering declined too; narrowed by 20260907000000): only a LIVE request occupies the pair. Partial on status in (pending,accepted) -- a second request to the same profile is 23505 while either stands, and a DECLINED or WITHDRAWN pair is free to ask again with a FRESH row (the old row itself stays immutable; the transition guard is untouched). The pair is (from_organisation_id, to_network_profile_id): an organisation, not a profile, is the unit on the sending side, because Q80''s symmetry is org-to-org. The re-request spam vector this reopens is mitigated by the Phase 7 network rate limiter (Q86/Q87), not by this index.';

-- The INSERT policy's comment cited the old three-status predicate in its last
-- sentence; re-issued with only that sentence changed (20260904007000
-- precedent -- the policy itself is untouched).
comment on policy "network_connection_requests_insert_manage_connections" on public.network_connection_requests is
  'PERMITS: sending a connection request FROM one of your own published, live profiles (Q78) TO another organisation''s published, live profile, when the caller holds manage_network_connections at aal2 in the sending organisation AND that organisation''s plan permits network_publish. DOES NOT PERMIT: a FREE-tier organisation sending at all (42501, Q76/N7); sending from an organisation the caller is not in; sending from a DRAFT profile, or one belonging to somebody else; and -- the subtle one -- FORGING to_organisation_id. That column is client-supplied on a table the client may INSERT into, and the second inline exists is what makes it honest: the named to_network_profile_id must really belong to the named to_organisation_id, so a caller cannot address a request at an organisation whose profile they did not pick. Sending to YOURSELF is refused by network_connection_requests_not_self (23514), not here, so it holds for every writer. A repeat send while a PENDING or ACCEPTED request stands is 23505 from network_connection_requests_live_pair; a DECLINED pair may re-request (Q79, as changed 2026-09-07 -- see 20260907000000).';

-- The sender-withdraws policy's comment said withdrawing "frees the pair for
-- exactly one retry" -- language that made sense only while a decline kept the
-- pair blocked. Re-issued (second time; the first was 20260904007000) with the
-- Q79 sentence corrected and nothing else changed.
comment on policy "network_connection_requests_update_sender_withdraws"
  on public.network_connection_requests is
  'PERMITS: the SENDING organisation to withdraw its own request, and NOTHING ELSE -- the WITH CHECK pins status to exactly ''withdrawn'' AND repeats the from_organisation_id term. DOES NOT PERMIT: the sender accepting or declining its own request (the whole reason this is a separate policy rather than an `or` branch of the recipient one); the RECIPIENT withdrawing -- and that second one is why the WITH CHECK repeats the organisation term rather than carrying the status alone as the Task 1 brief specified. PostgreSQL ORs permissive policies in BOTH clauses, so a bare `status = ''withdrawn''` here would be satisfied by a recipient whose USING passed through the OTHER update policy; measured on this stack. NO network_publish TERM, DELIBERATELY: withdrawing is how a Free-tier organisation retracts a request it can no longer act on, and gating the retraction behind the tier would strand it. Withdrawing frees the pair for a fresh request (Q79, network_connection_requests_live_pair -- and since 2026-09-07 a DECLINE frees the pair too; see 20260907000000). The BEFORE UPDATE transition guard additionally refuses withdrawing an already-terminal request. THE BEHAVIOURAL GUARD IS rls_phase6_network.sql NU5/NU5c, ON A **PENDING** ROW: 20260904003000''s own block comment cited NU5 while NU5 ran against a row the previous assertion had just made terminal, so the transition TRIGGER refused it (23514) and the assertion stayed green with this term removed -- it measured the trigger, not the policy. See 20260904007000. NU5 now expects 42501 on a pending row with the SENDER''s identical statement as the positive control, and is red without this term.';
