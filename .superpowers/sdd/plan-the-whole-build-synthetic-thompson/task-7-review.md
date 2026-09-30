# Phase 8 Task 7: CRM write auditing for the Phase 3–6 tables (Q122). INDEPENDENT REVIEW.

Range `c72f92e..06b0fbc` (8 commits, `51872b9` → `06b0fbc`), worktree
`legal-phase`, branch `worktree-legal-phase`, reviewed at `06b0fbc`.
One migration: `20261006000000_audit_phase3_to_6_crm_writes.sql` (207 → 208).

**VERDICT: MAJOR.** See § Verdict. The audit extension is well built. It
reuses one trigger function without changing it, the allowlist is rebuilt
from its latest definition, the coverage census really is derived from the
catalogue and reddens by name, the sentinel tests prove the sentinel is in
the row before they prove it is absent from the trail, and the two rebuilt
functions are faithful to their latest definitions. The problem is what the
extension does to erasure: **it writes other people's user ids into audit
payloads on rows where they are neither the actor nor the target, and the
account erasure clears neither of those.** That is the same class as Task 5
C1, which was graded Critical, and this task widens it from an edge case to
every invited member of every workspace.

---

## Method and constraints

A detached e2e run held the local stack and port 3000 during this review.
So no `db reset`, no psql runner, no `pnpm test`, no `pnpm test:e2e` and no
`pnpm dev` were run, and a read-only `psql` query against the live container
was refused by the harness. **Every mutation below is reasoned from the code,
not run.** Anything that needs a database to prove is listed under § Owed,
with exact steps.

Run here, at `06b0fbc`:

- `pnpm lint`: clean.
- `npx next typegen` + `pnpm typecheck`: clean (exit 0).
- The new psql suite has **186 `c7.val`/`c7.try` call sites at top level**
  (grep count), and each records exactly one row. That matches the pin of 186
  in `run-rls-tests.sh`. `\set ON_ERROR_STOP on` plus `run_suite`'s ERROR-line
  guard covers the raw fixture statements that sit outside a helper.
- `CLAUDE.md`'s twenty-two pinned totals sum to 3794 (3608 + 186). Checked by
  hand.

---

## CRITICAL

### C1: The new payloads carry a third party's user id, and account erasure leaves it behind

`private.audit_crm_value_columns()` (`20261006000000:196-258`) now copies
these person-identifying uuids by value into `audit_events.before/after`:

| target | allowlisted person id | who the actor usually is |
|---|---|---|
| `membership` | `user_id`, `invited_by` | the **Admin** who invited, promoted or removed someone else |
| `membership.deleted` (`audit_crm_payload`, `:420-423`) | `user_id` | the Admin removing someone else |
| `event`, `task`, `meeting`, `note`, `document` | `owner_user_id` | anyone who assigns or reassigns a record to a colleague |
| `merge_candidate` | `keep_owner_user_id`, `duplicate_owner_user_id` | whoever ran the screen or dismissed the pair (the owners are other people) |

The suite shows this directly. PM1b asserts that `membership.created` is
written by `padmin` and carries `user_id`, and PM3b asserts that
`before.user_id = pbowner` on the `membership.deleted` row that `padmin`
wrote. The PostgREST test does the same at `crm-audit-no-content-leak-p3-6.test.ts:313`.
In those rows the **target is the membership row's id** and the **actor is
the Admin**. The person named in the payload is neither.

`private.erase_account()` (latest definition `20261001003000`, and grep
confirms nothing later) clears an erased person's audit footprint in
exactly two ways:

- **step 6b**: `where a.target_id = p_user_id`. This never matches, because
  the target is a membership, task, note or similar id and never a user id.
- **step 6e**: `where a.actor_user_id = p_user_id`. This never matches,
  because the actor is the Admin or colleague.

Step 6c's whole-document text replace exists only for `incident_alerts.details`.
`private.fkless_identifier_columns()` sees uuid **columns**, and its header
already states that "a uuid inside `jsonb`" is out of scope. So after a
completed erasure, **every `membership.created` / `.updated` / `.deleted` row
an Admin ever wrote about that person still names their stable uuid.** So
does every task, event, meeting, note or document someone else assigned to
them. Every invited member of a workspace has at least one such row, by
construction.

Why this is Critical and not Important:

- It is Task 5 C1's class exactly: "a stable identifier surviving erasure,
  which is the one thing pseudonymisation must not produce". CLAUDE.md
  repeats that sentence, and Task 5 C1 was graded Critical for two
  `merge_candidates` columns.
- `/legal/data-subject-rights` v5 promises: "every entry of yours is
  re-pointed … and any description of the change is dropped."
- The code's own header is now false. `20261001003000:15-17` says "Nothing
  identifying survives TODAY (no audit writer puts a person's identifier in
  those payloads …)". The Phase 2 `owner_user_id` allowlist already strained
  that sentence, and this task breaks it outright. The migration's header
  thinks about erasure only for the cascade direction (`:175-185`), not for
  rows already written.
- No test can see it. The erasure suite's fixtures are planted sessionless,
  and this suite never erases anybody.

**Fix shape.** In a new `erase_account()`, rebuilt from `20261001003000`,
add a step that rewrites `before`/`after` of any audit row whose payload
text contains `p_user_id`. The whole-document replace step 6c already uses
is complete regardless of where the id sits. Then reissue the `comment on
function` that carries the false sentence. In the erasure suite, write a
real session-attributed `membership.created` (Admin invites X) and a
`task.updated {owner_user_id → X}` (Manager reassigns to X), erase X, and
assert zero `audit_events` rows whose `before::text || after::text`
contains X's uuid. Before erasing, prove that at least two such rows exist.
Then add a standing mutation that drops the new step and must redden.

**Owed: prove after the e2e run (O1 below).**

---

## IMPORTANT

### I1: Gate 5 is not green at the tip, and the report does not record it

The report's gate list ends with "5. fresh reset + `pnpm test:e2e` -- see
below." Nothing follows, and the status box "five gates" is unticked. Its
own § "A red that had been on the pushed branch" records that the last full
e2e run was **160 passed / 1 failed / 3 serial-skipped**. After the fix in
`06b0fbc`, only `operations.spec.ts` was re-run on its own (4/4). The three
serial-skipped tests were never run after the failure. Standing lesson 3
also asks for the migration count to be recorded around that run. Gates 3
and 4 were taken at `af96ddd` and `7db7497`. The report is right that the
later commits touch no psql file, so those two gates still stand.

Separately, mutation (b)'s **psql** half ("PA5's content-column count went
0 -> 1") was measured with a one-off query and not by running the suite
under the mutation. From reading the suite, PA4e, PA5, PI5b (`value_keys`)
and PU5b would all go red. But standing lesson 2 asks for the reds to be
recorded, not predicted. (O3.)

---

## MINOR

### M1: The census counts a disabled trigger as covered

In `private.audit_coverage()` (`:740-776`), neither the `generic` CTE nor
the `by_dedicated` probe reads `pg_trigger.tgenabled`. Nor do the pinned
counts in the integration census or `audit-actions-match-db` (PA2 counts
rows by name). The mutation `alter table public.tasks disable trigger
audit_update` leaves all 7 census tests and PA2/PC1-PC5 green. For today's
27 tables the behavioural suites catch it (PU3b, and the PostgREST tasks
PATCH), so this is not a live hole. But for a Phase 9 table the census is
the **only** guard, and "a trigger exists" is not "a trigger fires". Add
`and t.tgenabled <> 'D'` to both probes, plus a planted-table step that
disables the pair and expects `unaudited`. (O2 predicts the false green.)

### M2: The denominator has three blind shapes that the census comments do not generalise

The migration header states a limit ("sees that a trigger FIRES, not what it
DOES") and names two excluded tables. It does not state these three:

- **`rpc_only` never checks `relrowsecurity`.** A table whose policies all
  carry the marker term but whose RLS is off reads as `rpc_only`, even
  though every policy is ignored and a direct write is unaudited.
- **Only `relkind in ('r','p')` counts.** A client-granted, auto-updatable
  view in `public`, owned by a privileged role, writes a base table that has
  no client grant, so the census sees neither the view nor the base table.
  No such view exists today; `network_directory` and `activity_events` are
  SELECT-only.
- **Tables mutated only by a SECURITY DEFINER RPC under a session** are
  outside the denominator by construction. Examples are
  `event_status_changes`, `merges` and `impersonation_sessions`. The header
  says this for two named tables but not as a rule. A Phase 9 table written
  only by an unaudited definer RPC will not go red.

The denominator also relies on the house convention that every tenant table
has a **direct** single-column FK to `organisations`. A table whose only org
path is a composite FK to a parent (for example `(organisation_id, event_id)
→ events`) is invisible. The export census has the same dependence, so
cross-bind the two, or add an `organisation_id`-column disjunct.

### M3: Two verbs a client can reach are never exercised behaviourally

`merge_candidate` is `softDeletable: true`. § PM exercises only
`.soft_deleted`: the fixture row is inserted sessionless, and no restore is
attempted. `merge_candidate.created` is what `screen_for_duplicates()`
writes under a session on every flagged pair, and `.restored` is in the
catalogue. Neither has a behavioural assertion. The brief asks for "each
verb ... per table". (`membership` and `subscription` are correctly
two-verb.)

### M4: The off-path declaration in `no-private-table-in-network-path` is honest, but nothing enforces it

The entry for `lib/admin/audit-actions.ts` says "it issues no query, and
the integration census binds those strings to pg_trigger". Both halves are
true. The file has no `import`, no `.from(`, no `.rpc(` and no client. It
has one importer, `components/admin/audit-log-filter-form.tsx`, a server
component that uses only `knownAuditActions()`. The census binding is real
(tests 3 and 4). But the exemption covers the whole file for ever, and "no
query" is a sentence rather than an assertion. A one-line check that this
file contains no `.from(`, `.rpc(` or `import` would make the declaration
binding, so a future query on `network_profiles` here would be caught.

### M5: PS1c's label says ten planted rows, but there are nine

`rls_phase8_crm_audit_p3_6.sql:990-1002` counts `events` twice (once for
`name||location||…`, once more for `ticket_link`) and expects 10. The
denominator is still real, but it is nine rows and one double count.
Cosmetic.

---

## Notes (no finding)

- **The before/after diff exposes nothing to a Read Only user or a foreign
  tenant.** `audit_events` has exactly one SELECT policy,
  `audit_events_select_platform_superuser` (`20260826154304:933`). The
  activity timeline deliberately does not read it
  (`20260829040000:45-52`). The workspace export excludes it
  (`lib/export/contract.ts:199`). The account export reads only the
  requester's own actor rows, **with `before`/`after` withheld**
  (`lib/export/runner.ts:209-214`). A connection-request row filed under one
  tenant carries the other tenant's ids, but only the superuser can read it.
  So the only new reader of the new metadata is the operator. Q188 is the
  right place for the one piece of it that is arguably sensitive: which
  private record a tenant matched to which foreign profile.
- **No secrets are logged.** `organisation_memberships` has no token column
  (`20260826151656:69-81`). `documents.storage_key` is withheld. An UPDATE
  row carries column NAMES and never values outside the allowlist. Every
  allowlisted text column is a CHECK vocabulary; I checked `billing`,
  `event_type`, `priority`, `category`, `entity_kind`, `private_entity_type`
  and `resolution`.
- **Sessionless cascades really are sessionless.** `run_erasure_job` refuses
  any caller with `auth.uid()` who is not `postgres` or `service_role`
  (`20261001006000:336-339`), and the runner is `service_role`. PX1 stands
  in for the cascade with a direct sessionless UPDATE, which only restates
  the exemption; the session refusal is the real guarantee and deserves the
  citation.
- **The rebuilt functions are faithful.** A diff of `audit_network_row`
  against `20260907001000` shows the profiles branch unchanged apart from
  comments. The connection branch gains `.withdrawn`, the `.updated`
  fallback and the attribution `case`. The eleven Phase 2 allowlist
  branches are pinned literally by `rls_phase7_crm_audit.sql` CA4a-k. PA4q
  alone checks only three of them, but together the suites cover all eleven.
- **The e2e parity check** derives its expected keys from the live
  allowlist, so a widened allowlist moves both halves together. There, only
  the typed-string `not.toContain` checks catch a leak. That is acceptable
  because psql PA4 pins the lists literally.

---

## Claims verified by reading

| Claim | Verdict |
|---|---|
| One trigger function, not reissued; allowlist rebuilt from latest | **True.** PA3 guards the body. |
| 16 tables, 32 triggers + `membership.deleted` | **True**, by migration §3/§3b. PA2 = 54, PA2b by name. |
| Census derived from catalogue, reddens by name on a planted table | **True**, in both the integration test and psql PC8. The test fails with the table name in its message and in the diff. An unregistered generic table goes red in test 3, a dedicated or unaudited one in tests 2 and 4. Except the M1/M2 shapes. |
| Mutation (a) drop `tasks.audit_update` reds the census by name | **Consistent with the code** (tasks:UPDATE uncovered; generic set loses tasks; PA2 53). |
| Mutation (b) widen `note` with `body` reds the sentinel tests | **Consistent with the code** (PA4e, PA5, PI5b, PU5b, PS1, and the PostgREST INSERT/PATCH/sweep). The psql half was not run (I1). |
| Sentinel proved in row before absence is asserted | **True** per table (PI1e, PI2d … PM6c) and for the sweep (PS1b/PS1c). |
| Attribution non-forgeable | **True.** `auth.uid()` at the trigger; no caller argument exists. |
| Bi-tenant attribution of connection requests | **True** (PN2b/PN3b/PN4c/PN5d). |
| Three `network_connection.*` names missing from both catalogues, now fixed | **True**, and the literal-reading assertion (≥ 8, exact set) is a real guard. |
| Four existing assertions moved, none weakened | **True.** NX4 and NX5d now assert the property Q82 needs, and LE1b/d is the census growing. |
| `no-private-table-in-network-path` declaration honest | **True** (M4 on enforceability). |
| Set-null cascades skipped, and that is right | **True for the cascade.** It misses the forward direction (C1). |
| Gates 1–5 | 1–2 re-run clean here; 3–4 as reported; **5 owed (I1).** |

---

## Owed: run after the e2e run releases the stack

**O1 (C1).** `npx supabase db reset --local`, then in psql:

1. As `padmin_c` (aal2 Admin of ALPHA), insert an invited membership for a
   disposable auth user X. As `pmanager_c`, update one ALPHA task to
   `owner_user_id = X`.
2. As `postgres`: `select count(*) from public.audit_events where
   (coalesce(before::text,'')||coalesce(after::text,'')) like '%'||X||'%'`.
   Expect ≥ 2 (the denominator).
3. `select private.erase_account(X)` sessionless.
4. Repeat the count from step 2. **Predicted: ≥ 2 (red). Required: 0.**

**O2 (M1).** `alter table public.tasks disable trigger audit_update;` then
run `pnpm exec vitest run tests/integration/admin/crm-audit-coverage-census.test.ts
tests/integration/admin/audit-actions-match-db.test.ts`. **Predicted: all
green (the false green).** Then run the new psql suite alone. Predicted: PU3b,
PD20 and PD31 red. Re-enable the trigger afterwards.

**O3 (I1).** Reissue `private.audit_crm_value_columns()` with `'body'`
added to `note`, run `rls_phase8_crm_audit_p3_6.sql` alone, record the reds
by label, and restore from `pg_get_functiondef`.

**O4 (I1).** Fresh reset, then `pnpm test:e2e`, with the migration count
recorded before and after. Expect 164 passed at 208 → 208.

---

## Verdict

**MAJOR**, because of C1 alone. It is small to fix (one erasure step and
one comment reissue), but it is a live erasure promise broken for every
invited member. It is the exact class a previous round graded Critical, and
the new payload design causes it directly. I1 is a gate and a mutation
record owed. M1–M5 are census hardening and test gaps that do not change
today's behaviour. With C1 fixed and proved (O1), and O3/O4 recorded, I
would expect this to re-review MINOR or better.
