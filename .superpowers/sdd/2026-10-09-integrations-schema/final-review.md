# Phase 9 final whole-branch review (9a47016..d4d4ca8)

Reviewer: opus, read-only. Base 9a47016 equals origin/main 769d8cb by content (empty diff). The local `main` ref is stale (f034723), so the PR must target `origin/main`.

## Deferred-minor adjudication

- **T1 M4** (the interim export phrase): RESOLVED. 20261030003000 (7) replaces all three interim `excused` rows with `exported`. The self-check at :1641 refuses any excused integration table. The `contract.ts` WORKSPACE_EXCLUDED_TABLES phrases are gone; the net diff to `lib/export/contract.ts` is the ACCOUNT_EXPORT_INCLUDES sentence only.
- **T1 M5** (revoked is terminal for status only): RESOLVED. The guard now freezes the whole row as jsonb minus the three person columns (20261030002000:51, rebuilt at 20261030003000:105-117). Measured by IT10c/c2/c3/e; M11, m4 and T9 kill it.
- **T1 M6** (IT4 without REFERENCES/TRIGGER): RESOLVED. IT4 is now 12 checks that include REFERENCES and TRIGGER (rls_phase9_integrations.sql:162-165).
- **T2 m1** (tombstone actor in the tenant audit viewer): DEFER-OK. Recorded in SECURITY.md § 7 :299-310 and in FOLLOW-UPS § Phase 9 Task 5.
- **T2 m2** (the server RPCs ignore lifecycle and tier): DEFER-OK. Recorded in SECURITY.md § 2 :125, the § 15 launch gate :899, and FOLLOW-UPS :4580. This deviates from the spec ("refuses connects **and token writes**"), and the deviation is disclosed.
- **T2 m3** (an active-only token read blocks retry): RESOLVED. The founder ruled on Q233 (a) on 2026-10-10: a failed connection must be re-authorised, as built.
- **T2 m5** (an Admin names another member as owner): DEFER-OK. Recorded in Q236, SECURITY.md :127-131 and FOLLOW-UPS :4581. Q236's default has a flawed premise; see Important I1.
- **T3** (the retention_clock_columns note omitted the guard's revoked_at writer): RESOLVED. 20261030003000:1598 now names both writers.
- **T3** (IX5/IN4 `>= 1` terms): DEFER-OK for IN4, whose `>=1` is correct because the probe runs the DB-wide sweep and the first four fields carry the exact per-fixture counts. IX5's `>= 3` (rls_phase9_integrations.sql:1336) is org-scoped and could be exact. It is recorded only in the ledger; see Minor m5.
- **T4** (Xero/QBO scopes, Xero pricing via Apideck, MS publisher-verification cost, the Skiddle sub-processor call, the Mail.ReadBasic gloss): DEFER-OK. Each is labelled "unconfirmed", "third-party" or "for counsel" inside docs/integrations-discovery.md (:83, :114-115, :161-165, :201-214, :249, :338-339) and routed to the founder pre-work list (:327-339). Research only; nothing is built on these facts.
- **T5** (the run.sh and mutants.py headers say "12 mutants"): DEFER-OK as cosmetic. It is a process artefact: 11 mutants plus a control, and results.txt states it correctly. A one-word fix is optional; see Minor m6.

## Checks 1–8

1. **Tenant isolation: PASS with one test gap (C1).**
   - RLS is enabled and forced on both tables (20261030000000:177-180).
   - Every write grant is revoked; SELECT-only policies (:187-199).
   - Row-to-organisation path: `organisation_id` on both, plus the composite FK on sync runs (:117-118).
   - The policies use `permitted_organisations()`, which checks membership in the database and is MFA-gated.
   - Every SECURITY DEFINER function pins `search_path = ''`. Each RPC re-derives role from `auth.uid()` (has_permission / integration_role_held); `p_org` is never trusted. revoke filters on `c.organisation_id = p_org` and gives non-holders one indistinguishable 42501 (20261030003000:226-247).
   - The cross-tenant reads IR1-IR9 and the HTTP twin are green.
   - Gap: integration_role_held's MFA and role terms are never exercised on a wound-down workspace (C1).
2. **Secrets: PASS.**
   - The token lives only in Vault (`vault.create_secret`/`update_secret`, 20261030002000:105-114).
   - `token_secret_id` is column-revoked from authenticated (20261030001000:529-533; IT15/IT15b, IV7c/d, HTTP `select=*` 403).
   - authenticated cannot read vault.secrets or decrypted_secrets (IV7/IV7b).
   - store, read and sync are service_role only, with a person-session plus role rail (IV5-IV5f, IV6*).
   - Audit payloads hold only {provider, owner_scoped[, reason]} or {provider[, error_code]} (IA2, IV12, IE8).
   - Exports project the column out (20261030003000:1120-1128; IX2/IX3/IX7, self-check :1645).
   - The error_code is pre-validated, so no echo (IS5b).
   - Two unrecorded caveats from task-2-report § Concerns: service_role can read Vault directly (a Supabase default), and `p_secret` would appear in Postgres statement logs if `log_statement` were enabled (Minor m2).
3. **Guard coverage: FAIL, one unmeasured guard (C1).**
   - Mutation coverage across the tasks is otherwise exhaustive: Task 1 M1-M8 and F1/F2a-e, Task 2 M1-M31 and C1a-c/m4/m6, Task 3 T1-T21, and Task 5 M01-M11 with a control (the Task 5 table, all red).
   - Every CHECK, the guard (catalogue, freeze, tombstone exemption, out-of-band revoke), each RPC refusal, the column grant, the membership trigger (including the org-move conjunct), erasure 5c, purge 5c, the sweep and its Vault delete, and the export projection each have a named killing assertion.
   - **Not covered:** the lifecycle-blind branch of `private.integration_role_held()`.
     - Its `rp.permission_key = 'manage_integrations'`, `m.status = 'active'` and MFA terms (20261030001000:58-63) have no negative assertion.
     - Workspace S has exactly one member, owner_s at aal2 (suite :95, :133).
     - Task 2 M2 removed the whole branch, but no mutant weakens its terms.
4. **Lifecycle: PASS.**
   - Erasure 5c (20261030003000:452-487): revoke through the primitive (Vault by id and by name), then delete the runs and rows, then tombstone created_by/revoked_by. IE1-IE10 pass, including the 23505 shape and a raw out-of-band delete.
   - Membership trigger (:279-321): IM0-IM10b.
   - Purge 5c (:867-883): the secrets are deleted before the cascade. IP1-IP4b.
   - Retention: two classes, a sweep wired into the body, and the clock roll. IN1-IN5 against the real sweep body.
   - DSR export: both workspace tables and the account's own (IX1-IX8).
   - Nothing is orphaned except two documented, accepted residues: a raw out-of-band delete leaves an ownerless revoked row (task-3 Concerns, accepted), and a stuck `running` sync run sits on no clock (FOLLOW-UPS :4575).
   - Q235 (a departed person's revoked rows are not in their account export) is queued with a default.
5. **Migration hygiene: PASS.**
   - Five new files, 20261030000000-004000, all after main's last (20261029002000).
   - `git diff --name-status` shows only `A`; no shipped migration is edited. The comment-only in-place edit of 003000 happened before merge.
   - Every rebuilt function is a CREATE OR REPLACE from the live definition.
   - FKs are indexed: organisation_id is the leading column of unique(organisation_id,id) and of (organisation_id, connection_id); owner/created_by/revoked_by/connection_id have their own indexes (:99-127).
   - UUID PKs, timestamptz, now().
   - Self-check DO block (:1636-1659), which also refuses any live provider.
6. **Docs truthfulness: PASS with small inaccuracies.**
   - CLAUDE.md "Integrations, as they actually shipped" and SECURITY.md § 2/§ 7/§ 15 describe no connector, no OAuth flow and no UI as built.
   - Claims checked against the migrations: the Starter+ gate, MFA, revoke by id and by name, column-level SELECT, the 195 assertions and 11 mutants plus a control, and the mutation path, which exists.
   - Inaccuracies:
     - SECURITY.md:307 says the sessionless rows carry a `reason`, but `token_stored` and `sync_failed` have none (m3).
     - FOLLOW-UPS.md:4545-4546 still schedules Q169 (CI heavy jobs) for "Phase 9, together with merging infra-parallel-stacks". The Phase 9 spec explicitly excludes that work, so the line is now false (m4).
7. **Scope discipline: PASS.**
   - No app/route/UI code changed.
   - The only `lib/` edits are four audit-action names and one export-contract sentence.
   - No live provider, no ticket-URL field, no infra-parallel-stacks merge.
8. **Test hygiene: PASS.**
   - run-rls-tests.sh pins ig at 195 (:1242) and leak at 218 (+1, IN9). The 4473 total is consistent (4423 + 49 + 1).
   - The pins in existing suites move with stated reasons (KS1 37, PA6c 171, LF1/LF2/LO1, RL1 13).
   - The completeness census moves to 56; DECLARED_PRIVILEGES and SERVER_ONLY_RPCS are extended.
   - The only timeout change is one per-test 30 s ceiling on a CPU-bound walk (storage-census.test.ts). No retries and no global config are touched.
   - Mutation driver: rc now captured, subset runs write separate files.

## Issues

### Critical

**C1. The lifecycle-blind role test, `private.integration_role_held()`, is an unmeasured guard.**
- Where: supabase/migrations/20261030001000_integration_rpcs.sql:58-63 (made INVOKER in 20261030002000:30).
- What: on a suspended or closed workspace, `has_permission()` is false for this key. integration_role_held alone then decides:
  - whether `revoke_integration` runs (20261030003000:223-224, :244);
  - whether `connect_integration` says `forbidden` or `workspace_not_writable` (20261030001000:104-105).
- Its three narrowing terms are never exercised negatively: the role must grant manage_integrations, the membership must be active, and the MFA term. The only wound-down-workspace callers in the suite are owner_s (aal2, the positive case) and B's Owner, who is not a member and is stopped by the membership join itself.
- A mutant that reduces the body to "is an active member", or drops the MFA conjunct, reddens nothing. Under such a regression, a Read Only member or an aal1 (password-only) Owner session could revoke a suspended workspace's connections. That deletes the Vault token, which is destructive and forces re-authorisation.
- Why Critical: the code is correct today, but the guard has no killing mutant, which is the bar for this phase.
- Fix (test-only, no SQL change): add to suite § IC11 two fixtures in S, a Read Only member (aal1) and owner_s at aal1. Add the assertions:
  - (IC11d) S's Read Only cannot revoke conn_s while S is suspended → `denied(42501:forbidden)`;
  - (IC11e) S's Owner at aal1 cannot either → `denied(42501:forbidden)`;
  - optionally (IC4c) the aal1 Owner's connect on suspended S → `forbidden`, not `workspace_not_writable`.
- Then run two mutants: (i) drop `and rp.permission_key = 'manage_integrations'` plus the join, which should red IC11d; (ii) drop the MFA conjunct, which should red IC11e/IC4c. Bump the ig pin and the runner total.

### Important

**I1. Q236's default rests on a premise the schema contradicts.**
- Where: .superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md (Q236); mirrored in SECURITY.md:127-131 and FOLLOW-UPS.md:4581.
- What: the default (b), "restrict `p_owner_user_id` to the caller (a person connects only their own mailbox)", combines with connect requiring `manage_integrations`, which is Owner/Admin only (20261030001000:104; 20261030000000:67-70). Together they mean only Owners and Admins could ever hold a person-scoped connection. A Booker or Manager could never connect their own calendar, and that is the likely first use (Google Calendar, Q232).
- Why: the founder would be ruling on an option whose consequence the entry does not state.
- Fix (docs only): amend Q236 to state this consequence. Add an option (c): a separate person-scoped connect path that needs only an active membership (or view_crm) and forces `owner_user_id = auth.uid()`, while workspace-scoped connects stay with manage_integrations. Not blocking for the PR itself, since no code depends on it.

### Minor

- **m1.** docs/superpowers/specs/2026-10-09-integrations-schema-design.md ("Access") says `read_integration_token` "is the one decrypting path" and that a suspended workspace "refuses … token writes". As built, neither is true:
  - service_role has direct Vault access (a Supabase default; task-2-report § Concerns);
  - m2 above (T2 m2), which SECURITY.md does disclose.
  - The spec is a process document, so either annotate it or leave it, given SECURITY.md is the record of truth.
- **m2.** Two Task 2 concerns are recorded nowhere durable:
  - service_role reads `vault.secrets`/`decrypted_secrets` directly (RPCs are the sanctioned path, not the only path);
  - `p_secret` travels as an RPC argument and would be logged under `log_statement = all` or under parameter logging.
  - Fix: add both to SECURITY.md § 15's connector launch-gate bullet (:899), or to FOLLOW-UPS § Phase 9 Task 5.
- **m3.** SECURITY.md:307 says "the payload's `reason` says why" for every sessionless row. Only the revoke rows carry `reason` (`membership_ended`/`account_erased`/`account_deleted`); `integration.token_stored` and `integration.sync_failed` do not (20261030002000:127; 20261030001000:471). Fix: say "the revoke rows' payload `reason` says why; token_stored/sync_failed are always the server".
- **m4.** FOLLOW-UPS.md:4545-4546 schedules Q169 (CI heavy jobs) for "Phase 9, together with merging `infra-parallel-stacks`". Phase 9 excluded both by spec. Fix: re-home it (Phase 10 or a named branch) so the record is not false once this merges.
- **m5.** rls_phase9_integrations.sql:1336 (IX5) uses `>= 3` on an org-scoped export page, where an exact count is available. Fix: tighten it, or add one FOLLOW-UPS line so it is not ledger-only.
- **m6.** mutation-results/phase9/run.sh:3 and mutants.py:1 say "12 mutants". It is 11 plus a control (M12). Cosmetic.
- **m7.** Two refusals are measured by assertion but not by a dedicated mutant. Low risk, since each assertion pins the hint:
  - connect's own catalogue check (IC5, 20261030001000:129-132);
  - the one-live partial unique index (IT9f).
  - Optional mutants.

## Verdict

**Branch: Needs fixes.** There is one blocker, and it is test-only.
1. **C1:** add the IC11d/IC11e (and optional IC4c) assertions and their two mutants; re-pin ig and the runner total.
2. Recommended in the same commit (docs only, no re-review of the schema needed): I1 (amend Q236), m2 (record the Vault-access and statement-log caveats), m3, m4.

Schema, security, lifecycle and migration hygiene are otherwise sound. After C1 lands green twice on one database, the branch is ready to PR into `origin/main`.
