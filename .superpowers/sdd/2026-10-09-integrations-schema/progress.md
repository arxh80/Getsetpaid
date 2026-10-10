# SDD ledger — plan: docs/superpowers/plans/2026-10-09-integrations-schema.md
Task 1: dispatched (base 01a0d31)
Task 4: implemented (docs/integrations-discovery.md + Q232; uncommitted until Task 1 lands; recommends Google Calendar; gaps labelled: Calendar scope sensitivity, Fatsoma no API, Intuit/Xero/Microsoft partial)
Task 1: implemented d7545ad (DONE_WITH_CONCERNS: interim retention/fk-less/export rows for Task 3; provider guard definer; attribution no-op under definer RPCs; CRLF -> fixed by .gitattributes b55054d)
Task 1: review NEEDS FIXES (1C: view_crm conjunct of person-scoped read has no mutant; 1I: four CHECKs untested; 1I plan-mandated: owner_user_id set null vs erase_account -> ROUTED to Task 3, carried in its brief; 4 minors in task-1-review.md)
Task 1: fix round 1/5 dispatched (resume implementer)
Task 1: minor (deferred): M4 interim export phrase misdescribes integration tables as platform records -> Task 3 replaces it
Task 1: minor (deferred): M5 revoked is terminal for status only; freeze organisation_id/owner_user_id/everything on a revoked row -> Task 2's guard rebuild
Task 1: minor (deferred): M6 IT4 does not check REFERENCES/TRIGGER (covered by privilege census)
Task 1: minor (deferred): M7 tests/unit/legal/storage-census.test.ts 5s timeout under load (pre-existing, = F-T8-1) -> Task 5
Task 1: fix round 1/5 (2 addressed, 0 open; commits 439cb71..82d6771)
Task 1: complete (commits 01a0d31..82d6771, review clean after round 1; suite ig pinned 56, runner 27 suites 4333)
Task 2: dispatched (base 82d6771)
Task 2: implemented 82d6771..90b0499 (DONE_WITH_CONCERNS: token unreadable in 'error' blocks retry -> queue; service_role reads vault directly by default; purge leaves secrets -> Task 3; new lifecycle-ignoring role helper to keep refusal order; real bug found+fixed: cross-org revoke via NULL fallthrough)
Task 2: review NEEDS FIXES (C1: role half of server-session rail has no assertion/mutant; 7 minors)
Task 2: minor (deferred): m1 server audit rows show tombstone actor in tenant audit viewer -> Task 5 docs / final review
Task 2: minor (deferred): m2 server RPCs ignore lifecycle/tier (no caller today) -> SECURITY.md note in Task 5; enforce when first connector lands
Task 2: minor (deferred): m3 active-only token read blocks retry (plan-mandated) -> queued Q233
Task 2: minor (deferred): m5 admin can create person-scoped connection for another member; OAuth callback must bind to owner_user_id -> SECURITY.md/FOLLOW-UPS in Task 5
Task 2: fix round 1/5 dispatched (C1 + m4 fail-closed freeze + m6 dangling secret + m7 invoker)
Task 2: fix round 1 agent stopped by API limit, nothing landed (tip 14a022e); resumed same agent with db-reset instruction
Task 2: fix round 1/5 (4 addressed, 0 open; commits 14a022e..054dea0)
Task 2: complete (commits 82d6771..054dea0, review clean after round 1; ig pinned 146, runner 27 suites 4423)
Task 3: dispatched (base 054dea0)
Controller: founder rulings 2026-10-10 recorded; Q189 + Q228 (contact-us, multi-part any-size closure backup, keep delete-without-backup) scheduled as follow-up branches off main after Phase 9 PR
Task 3: implementer DONE_WITH_CONCERNS (commits 054dea0..a58561e; ig 191, runner 27 suites 4469; concerns: revoke-in-place on out-of-erasure account delete, data-retention v8 published, network_leakage_phase6 not re-runnable on one DB)
Task 3: review dispatched (opus, package review-054dea0..a58561e.diff)
Task 3: review Needs fixes — 3 Critical (unmeasured guards: sweep Vault delete; name-clause secret lookup x3 sites; membership trigger org-equality), 1 Important (false comment in export_catalogue body)
Task 3: minor (deferred): retention_clock_columns note omits guard's out-of-band revoked_at writer
Task 3: minor (deferred): IX5/IN4 `>= 1` terms loose
Task 3: concerns adjudicated — out-of-band revoke ACCEPT; data-retention v8 ACCEPT; network_leakage_phase6 not re-runnable = pre-existing, own follow-up (not this task)
Task 3: fix round 1 dispatched (resume implementer)
Task 3: fix round 1 committed f70a0e3+1a50967 (run 6 green, vitest 168/3821, ig 195); re-review dispatched
Task 4: committed 439cb71 (never reviewed); review dispatched
Task 3: fix round 1/5 (4 addressed, 0 open; commits a58561e..1a50967)
Task 3: complete (commits 054dea0..1a50967, review clean after round 1; ig pinned 195, runner 27 suites 4473)
Task 5: dispatched (base 1a50967, sonnet; carries deferred minors M7, T2 m1/m2/m5)
Task 4: review Needs fixes (3 Important: inference-as-fact in recommendation; Xero/QBO/Graph Mail scopes unconfirmed; Q232 Fatsoma overstated)
Task 4: minor (deferred): Xero tier pricing sourced to Apideck only; MS publisher-verification cost third-party; Skiddle sub-processor call for counsel
Task 4: fix round 1/5 dispatched (fresh sonnet; original implementer unavailable)
Task 4: fix round 1/5 (3 addressed, 0 open; a183155) + controller nit fix (Fatsoma/MS consent caveat/ranking wording)
Task 4: minor (deferred): Xero/QBO scopes unconfirmed from vendor pages (unreadable to tools) -> founder confirms at app registration; Mail.ReadBasic gloss unsourced
Task 4: complete (commits 439cb71, a183155 + nit; re-review clean)
Task 5: complete (docs, 12 mutants all red/control green, gates green; 4 e2e RAM-timeouts green in isolation)
Task 5: implementer DONE_WITH_CONCERNS (commits 1a50967..5666782 minus Task 4's a183155/309cf17; 11/11 mutants red; e2e 172/4 fail under RAM starvation, failing specs green in isolation; Q236 queued; audit-actor note placed in SECURITY § 4 per brief)
Task 5: review dispatched (package review-1a50967..5666782.diff)
Task 5: review Needs fixes (0C, 3I: e2e gate not green cold + ledger overstates; Q236 docs prescribe option (a) vs default (b); run.sh logs date's $? not python's; 5 minors folded into round 1)
Task 5: fix round 1/5 dispatched (resume implementer)
