# SDD ledger — plan: docs/superpowers/plans/2026-10-16-launch-hardening.md

Branch `launch-hardening`, worktree `.claude/worktrees/launch-hardening`, stacked on `q228-closure-backup-parts` (ce1fda1, PR #32). Spec `docs/superpowers/specs/2026-10-16-launch-hardening-design.md`; plan `docs/superpowers/plans/2026-10-16-launch-hardening.md`. Q243 = design approval (default: proceed); next free Q = Q244.

Baselines at ce1fda1 (2026-10-16, fresh resets): psql runner "All suites passed" (28 suites, qp 119); pnpm test 175 files / 4012 passed + 5 skipped (clamav-live); permission matrix 620; e2e 181 tests (32 of the six closure/export/super specs green across runs; a whole-suite single run is not achievable on this machine: dev server > 3 GB).
Open PRs below this branch: #32 (Q228), #33 (Subprocessors v4, off main).

Phase 10: plan written 2026-10-16; census smoke-tested (87 routes: 47 exact axe, 5 by tail, 35 candidates; 32 candidate unbounded list reads; 31 rate-limit keys, 1 untested; 191 SECURITY DEFINER functions, 107 not named in matrix/census -- all candidates, to be read by hand in Task 1)
Task 1: dispatched 2026-10-16 (base af69ee4, opus) -- launch-gate inventory
Task 1: implementer DONE_WITH_CONCERNS 2026-10-17 -- 8ecbf31 (census), 52cf539 (docs/launch-gates.md); 31 gaps (1 Critical G11, 10 High)
Task 1: review 1 (opus) Needs fixes -- 3 Important: G10/G16 under-graded vs own rubric; G11 remediation misses the confirmations-ON created:true takeover; gate 4 re-measure names the census route verdict (plan-mandated verbatim script)
Task 1: fix round 1 -- 1f2e4fa (G10, G16 -> High: 1 Critical, 12 High, 14 Medium, 4 Low; G11 created:true + forced new password; gate 4 caveat; all 7 Minors fixed too)
Plan: Part B written 2026-10-17 as Tasks 4-16 (numeric so task-brief extracts them); Part C renumbered Tasks 17-18. Order: Task 4 (G11, Critical) runs right after Task 1, before Tasks 2-3; then Tasks 2, 3, 5..16, 17, 18.
Task 4: dispatched 2026-10-17 (base 19c94bf, opus) -- G11 invite pre-hijack (Critical); jumps ahead of Tasks 2-3
Task 1: re-review round 1 (sonnet) -- all findings addressed
Task 1: minor (deferred): G11 item (3) created_at discriminator would refuse a legitimate re-invite (forwarded to Task 4 as a constraint)
Task 1: minor (deferred): G11 cites :258-261 for the signed-up-unconfirmed case; that is GoTrue behaviour to confirm by experiment (forwarded to Task 4)
Task 1: complete 2026-10-17 -- 8ecbf31, 52cf539, 1f2e4fa; plan Tasks 8 and 14 amended from the re-review's out-of-scope notes (per-IP boundary not driven on the shared stack; entities.ts:85-92 fail-open)
Task 2: audit phase dispatched 2026-10-17 (opus, read-only alongside Task 4; writes task-2-findings.md + docs/threat-model.md for G19; fix phase resumes after Task 4)
Task 2: audit phase DONE_WITH_CONCERNS 2026-10-17 -- stopped early on F1 (Critical); 10 findings: 1 Critical (F1 network base table readable cross-tenant over PostgREST, connections-level values + organisation_id/entity_id), 3 High (F2 Admin self-promotes to Owner; F3 GoTrue password/MFA change skips step-up; F4 erasure + close_my_workspace skip step-up = G13 scope gap), 3 Medium (F5 safeNextPath open redirect, F6 auth cookies no Secure, F7 project-wide email limit), 3 Low; findings file truncated inside F7; threat-model + report not written
Plan: amended 2026-10-17 -- F1 appended as Task 19 (runs after Task 4); F4 folded into Task 6 decision 4; Task 2 fix-phase ruling: finish findings F7-F10, finish remaining audit scope, fix F2/F3/F5/F6, write threat-model (G19)
Task 4: implementer DONE_WITH_CONCERNS 2026-10-17 -- df010b2 (accept_invite refuses unconfirmed, migration 20261102010000), 07eb877 (confirmations ON + auth-config test), 90fc99f (refuse to bind an unconfirmed sign-up, pre-call lookup on invited_at), eecd895 (docs, Q244-Q245); both paths reproduced first; 3 mutants red; pnpm test 4015 + 5 skipped, psql All suites passed (FOUNDATION 187), e2e invite-pre-hijack 4/4. Concerns: Q245 residual (GoTrue keeps the first password on unconfirmed re-sign-up), ms race between lookup and invite call (documented), shared stack auth container now runs confirmations ON
Plan: Task 20 appended 2026-10-17 -- Q245 default (forced new password at an address's first proof unless the same browser created it); order now 4 -> 19 -> 20 -> Task 2 fix phase -> 3 -> 5..16 -> 17-18
Task 4: review 1 dispatched (opus, package review-19c94bf..eecd895.diff; coordinator commits e0f58e2 34d6afd d1df1bd 0a13390 excluded by instruction)
Task 4: review 1 (opus) Needs fixes -- Important: (1) G11 marked CLOSED while the Q245 residual is a demonstrated Critical (Task 20 now scheduled); (2) plan-mandated refusal wording "Ask them to confirm it" steers the owner into the residual -- COORDINATOR RULING: the finding governs (the wording was the coordinator's brief text, not a founder decision); plus measure the invitation-first ordering
Task 4: fix round 1 dispatched (resume implementer; base 306fbcd)
Task 4: minor (deferred): no unit test for the new invite-step branches (lookup failed / refuse) -- tests/unit/org/invite-binding.test.ts
Task 4: minor (deferred): invite-pre-hijack test 1 no-invitation assertion lacks a Mailpit presence control; stray await on sync expect
Task 4: minor (deferred): setUpInviteWorld throw -> afterAll derefs undefined world, leaks users, masks error
Task 4: minor (deferred): auth-config.test.ts scanner misses dotted keys and [[array]] headers
Task 4: minor (deferred): path 1 hosted closure rests on a manual setting; fail-closed check of /auth/v1/settings mailer_autoconfirm
Task 4: minor (deferred): narrow the lookup/invite race in the created:true branch (created_at predates the call -> refuse)
Task 4: minor (deferred): invite form now reveals "unconfirmed self-sign-up" (enumeration oracle extended) -- one line in SECURITY.md 10
Task 4: fix round 1 -- d342cf4 (neutral refusal; magic link confirms with P1 intact, recovery kills P1 but no Forgot-password page), e75755c (invitation-first measured: no second residual, test 5), a2034aa (G11 PARTIAL until Task 20); invite-pre-hijack 5/5, unit 2715; re-review dispatched (sonnet)
Plan: Task 20 decision 5 added -- the fix round's measurements (magic-link route, no Forgot-password page, test 5, refusal wording revisit)
Note for Task 17: the app has no Forgot-password page (no resetPasswordForEmail anywhere in app/ or lib/); the emailed sign-in link is the only recovery path -- queue as a founder Q (default: magic link is the recovery path at MVP; Task 20's set-password page could back a reset later)
Task 4: re-review round 1 (sonnet) -- all findings addressed, no new Critical/Important
Task 4: minor (deferred): Q245 text "A password reset replaces the squatter's password" is imprecise (only once a new password is set; no Forgot-password page)
Task 4: complete 2026-10-17 -- df010b2, 07eb877, 90fc99f, eecd895, d342cf4, e75755c, a2034aa; G11 PARTIAL until Task 20 (Q245)
Task 19: dispatched 2026-10-17 (base c06ff6b, opus) -- F1 readable network base table (Critical)
Plan: Tasks 21-25 added 2026-10-18 from the founder's whole-repo audit ("fix all"): 21 member removal/role change (High, after F2), 22 sign out everywhere (High), 23 storage quota + custom-field race, 24 every export in parts, 25 runner-auth helper; Task 2 F3 ruling gains GoTrue security notification emails; order 19 -> 20 -> T2 fix -> 21 -> 22 -> 3 -> 5..16 -> 23..25 -> 17-18
Task 19: implementer 1 stopped by founder mid-task (uncommitted draft edits kept, patch backed up); re-dispatched 2026-10-18 (fresh opus implementer, base dd5dc1e, draft as unreviewed starting point)
Task 19: implementer 2 DONE_WITH_CONCERNS 2026-10-18 -- 8a9a76a, 552279e (definer views + security_barrier, private.network_profile_reaches_caller, network_profile_is_discoverable(id, org default null)); review dispatched (opus, dd5dc1e..552279e, skip b4bb434)
Task 19: review 1 Approved (no Critical/Important); fix round 1 sent for minors 1-3,7 + EXPLAIN measurement
Task 19: minor (deferred): published/deleted_at terms repeated in both views + predicate (partial-index reason; LB13b/c cover drift)
Task 19: minor (deferred): vitest worker-start timeout on publish-editor-flow.test.ts (machine noise; re-run alone 57/57)
Task 19: fix round 1 DONE -- d72d80a, 029808c, 0319234, 76f5dd9 (runner green fresh reset; EXPLAIN: reaches_caller per-row ~12% of row cost, no code change; pre-F1 seq scan ~0.38s @2000 profiles noted); re-review dispatched (sonnet, 43fd639..76f5dd9)
Task 19: re-review 1 all findings ADDRESSED, no new breakage
Task 19: minor (deferred): directory read evaluates presence pair per published row (seq scan + sort, ~0.38s/query @2000 profiles); predates F1 -- final review / perf follow-up
Task 19: complete 2026-10-18 -- 8a9a76a, 552279e, d72d80a, 029808c, 0319234, 76f5dd9
