# Task 7 report -- CRM write auditing for the Phase 3-6 tables (Q122)

Written incrementally. Base: `c72f92e` (207 migrations). Branch
`worktree-legal-phase`. Migration `20261006000000` (207 -> 208) was committed
by the first implementer at `51872b9`; that agent died (weekly limit) before
any of the tests had been RUN, leaving an unregistered psql suite as a
local-only WIP commit. A second implementer resumed on 2026-09-30.

## Status

- [x] migration written (`20261006000000`, first implementer)
- [x] catalogue registered (TS + DB, both bound) -- first implementer; RUN
      and green for the first time by the resume (see below)
- [x] coverage census (derived, planted-table denominator) --
      `tests/integration/admin/crm-audit-coverage-census.test.ts` +
      psql § PC
- [x] psql suite (per-table verbs, sentinel no-leak, exemption, sweep) --
      `rls_phase8_crm_audit_p3_6.sql`, registered and PINNED
- [x] integration test over PostgREST --
      `tests/integration/security/crm-audit-no-content-leak-p3-6.test.ts`
- [x] e2e form-path assertion -- `tests/e2e/operations.spec.ts`
- [x] mutations
- [x] volume measured
- [x] docs
- [ ] five gates (see § Gates)

## Findings (pre-implementation, measured on the live catalogue at 207)

1. **Three action names the database writes were absent from the
   catalogue on BOTH sides**: `network_connection.requested`, `.accepted`,
   `.declined` (written by `private.audit_network_row()` since
   `20260904005000`). `lib/admin/audit-actions.ts` did not list them,
   `private.platform_audit_actions()` did not list them, and
   `audit-actions-match-db.test.ts` was green because `audit_network_row`
   sat in `DYNAMIC_ACTION_SITES` with a reason that claimed "its outcomes
   are in the catalogue under network_profile.* / network_connection_request.*"
   -- a name that never existed. Consequences: the founder's Action filter
   could not suggest them, and the retention suite's "purge exempts no
   action" planted a catalogue that omitted them. The reason is corrected
   and a new assertion reads every `v_action := '<literal>'` out of the
   function body (with a denominator of eight) and requires each to be in
   the catalogue.
2. **The derived denominator is wider than the brief's list.** Tenant-owned
   tables (FK -> organisations) with a client INSERT or UPDATE grant and no
   generic/dedicated audit trigger at 207: the thirteen Phase 3-6 tables the
   brief names, PLUS `organisation_memberships` (invite / role change /
   revoke -- a role escalation was unaudited), `organisation_subscriptions`
   (platform tier writes), `merge_candidates` (dismissing a duplicate --
   missed by Task 6b's "the twelve"), and `organisations` itself (an Owner's
   rename). `event_status_changes` and `document_versions` have NO client
   write grant and are outside the denominator by construction.
3. **The coverage derivation sees that a trigger FIRES, not what it DOES**
   (stated in the migration header and the census test): it classed
   `network_profiles` as covered by `audit_network_row()`, which returns
   early for a draft insert and every ordinary edit, and it hid the
   connection request's `withdrawn` transition. Both were found by reading
   the writer and are closed; the behavioural half is the psql suite.

## What shipped (the design decisions the brief asked to be stated)

- **One trigger function, not fifteen.** `private.audit_crm_change()` is
  unchanged (its latest definition is still `20260912000000`); sixteen tables
  gain its `audit_insert`/`audit_update` pair; the allowlist
  `private.audit_crm_value_columns()` is rebuilt from its latest definition
  with the eleven Phase 2 branches verbatim (psql PA4q) and sixteen new ones.
- **Structural columns only.** WITHHELD, by name: `events.name/location/
  ticket_link/notes`, `event_lineup.notes`, `tasks.title/detail`,
  `meetings.title/location/meeting_url/attendees/notes`, `notes.body`,
  `documents.filename/storage_key`, `financial_entries.amount_minor/
  description`, every published `network_profiles` value, `merge_candidates.
  label/similarity`.
- **Document filename: withheld.** A filename is typed by the uploader and
  routinely carries a person's name ("Contract - J Smith.pdf"); the
  quarantine alert and the document audit RPC already record the id only.
- **`event_status_changes`: not audited, and it does not need to be.** It has
  no client write path; it is written by `private.record_event_status_change()`
  from an `events` write, which is now audited as `event.updated` carrying
  `status` old -> new. It is the tenant-facing record; the audit row is the
  platform-facing one.
- **`document_versions`: no trigger now.** Dormant, SELECT-only; a trigger on
  a table with no write path is a check that cannot see its own subject. The
  day a grant lands, `private.audit_coverage()` classifies it `unaudited` and
  the census is red by name.
- **`network_connection_requests` spans two tenants** and keeps its ONE
  dedicated writer: a request and a withdrawal are filed against the SENDER,
  an accept/decline against the RECIPIENT, decided by the status the write
  leaves behind (which is what the two UPDATE policies key on); the other
  side is always in the payload. `.withdrawn` and a name-only `.updated`
  fallback are new.
- **`network_profiles` has two writers, deliberately**: a publish is two rows
  (`.published` from the dedicated writer, `.updated` naming every column the
  statement changed). Measured in psql § PN1b.
- **`organisations` is the one excusal** (Q189), declared in
  `AUDIT_COVERAGE_EXCUSALS` with its reason; the census is red if it is
  unaudited without that entry or excused while covered.
- **Removing a member is a hard DELETE** the generic pair cannot see:
  `membership.deleted` through `private.audit_crm_row()`, joining
  `CRM_IRREVERSIBLE_AUDIT_ACTIONS`.
- **Set-null cascades still run sessionless and the trigger still skips
  them -- and that is RIGHT** (requirement 4). The cascade an account erasure
  runs (`ON DELETE SET NULL` on `owner_user_id`/`created_by`/...) would, if
  audited, write `note.updated {owner_user_id: <erased id> -> null}` -- the
  erased person's stable identifier into the one payload the erasure exists
  to remove (Task 5 C1's class). The one `account.erased` summary row is the
  record. psql § PX1 proves the shape (a sessionless owner-nulling UPDATE
  emits no row; PX1 confirms `notes.owner_user_id` really is SET NULL).

## Resume (2026-09-30): what the first real run found

The whole of the first implementer's test work had never been executed. The
first `db reset` + runner with the suite registered unpinned measured:

- **psql suite: 186 recorded, 10 FAILED** -- every one a defect in the
  TEST, none in the migration: `min(bytea)` does not exist (PA2b raised
  42883); PA5c's arithmetic said 100 allowlisted columns where there are 96;
  PC8b expected no target argument for half a pair, and the census (usefully)
  reports it; PI0 claimed to be a member-session control and ran as
  `postgres` (337 rows) -- removed, PI0b is the real control; PD13a
  soft-deleted a finance line AFTER its event, which
  `financial_entries_update_manage_finance` refuses (a live parent event is
  required) -- reordered, and PD20/PD31/PS4 followed; PD21 expected the
  document's frozen class `operational` although it is linked to an event
  carrying a live finance line (`financial` is right); PM1b read the latest
  row's keys instead of the created row's; PS4 expected five note rows where
  the walk writes four (the no-op, refused and sessionless writes write none
  -- which is what PX asserts). After the fixes: **185 recorded, 0 failed**
  (one fewer: the bogus PI0 is gone).
- **Four EXISTING assertions moved -- findings, not edits** (all four are
  the new triggers being seen, not weakened):
  - `rls_phase6_network.sql` **NX4** asserted "network_links emits NO audit
    row, on purpose (Q82)"; it now emits `network_link.created`. Q82's actual
    rule is that the PUBLISHER is never told; the row is filed under the
    LINKING organisation and only the platform superuser can read
    `audit_events`. NX4 now asserts that property (every `network_link` row
    is filed under the link's own organisation: `1/0`). Queued as **Q188**
    with the shipped default.
  - `rls_phase6_network.sql` **NX5d** asserted a draft INSERT emitted no row;
    it now emits `network_profile.created`. The part NX5d existed for -- a
    draft is not a `.published` -- still holds and is what it now asserts.
    (It also had to filter by entity: the same profile id is used earlier in
    the file, so an id-only count read two rows.)
  - `network_leakage_phase6.sql` **LE1b / LE1d**: the structural network-
    surface census inspected 12 functions and now inspects 13 --
    `private.audit_crm_change` entered by net (a), a trigger on a network
    table. The census working as designed (the same shape as the Phase 7
    Task 3 and Task 5 moves); it is inspected for "rating" by LE1 the day it
    joins. `11/2/12/25` -> `11/2/13/26`.
  - Pins: no other psql suite total moved (twenty-one suites at their
    Task 6 pins).

- **Added in the resume:** psql PS5 (every generic-target row the walk wrote
  is filed under ALPHA, `56/0`) -- the per-row attribution sweep the shape()
  checks only made for `.created`. Pin **186**.
- **`audit-actions-match-db.test.ts` and the census test** (both written by
  the first implementer, 51872b9) ran for the first time and passed: 12/12 and
  7/7. The moved counts they carry are 22 -> 54 audit_crm_change triggers,
  3 -> 4 audit_crm_row action args (membership.deleted), 96 -> 162 catalogue
  names (100 CRM + 5 irreversible + 57 platform), 40 -> 100 derived CRM names
  -- each a consequence of the migration, not an edit to fit.
- **The integration test's first run** was refused by
  `network_profiles_hidden_fields_are_null` (fixture wrote fields the
  visibility map hid) -- a fixture bug; 23/23 after.

## Mutations (run against the live DB, then reverted and later reset)

- **(a) Drop one table's trigger** -- `drop trigger audit_update on
  public.tasks`: **9 red across 3 files.** The census named it:
  `Uncovered: organisations:UPDATE, tasks:UPDATE` ("no table is unaudited
  except the declared excusals"), plus "the generic set IS
  CRM_AUDIT_TARGET_TABLE" (tasks missing), "every other table is excused"
  (tasks unexpected), `audit-actions-match-db` 53 != 54, and five PostgREST
  assertions (tasks PATCH, structural PATCH, soft-delete, sweep window, golden
  path). Reverted by recreating the trigger.
- **(b) Widen the payload with a free-text column** -- `note` allowlist +
  `body`: **3 red** in the PostgREST sentinel test: note INSERT ("expected
  '{}{"values":{"body":"QZP36-LEAK-PROBE…' not to contain"), note PATCH
  (values not `{}`), and the whole-window sweep (2 hits). psql side measured
  by its own query: PA5's content-column count went 0 -> 1 (red), and PA4e
  compares the allowlist literally. Reverted from the saved definition.

## Volume

- **Golden path (PostgREST, integration test):** the Phase 3-6 stretch --
  create event, add the artist to the bill, add a task, link it, complete it,
  add a note -- writes **6 rows** (`event.created, event_lineup.created,
  task.created, task_link.created, task.updated, note.created`), **2,064
  bytes of heap** (~344 B/row; ~2.8 kB at the inventory's 472 B/row with
  indexes). Before Task 7 those six writes wrote **0**.
- **Server-action path (e2e operations walk):** task create + link + complete
  = 3 rows, private note = 1, asserted exactly.
- **The psql walk** (every verb on every table): 65 rows across 17 target
  types (PS4).
- **Consequence for Task 6's purge:** 500 rows per hourly run = ~12,000
  rows/day ceiling, already below SECURITY.md's own 20,000/day projection;
  queued as **Q190** (default: measure, raise when the 30-day average passes
  6,000/day). Recorded in SECURITY.md § 7.

## Questions queued

- **Q188** -- `network_link.*` audit vs Q82 (default: keep, shipped).
- **Q189** -- audit an Owner's `organisations` rename (default: yes, a
  dedicated `organisation.updated` on UPDATE only, outside lifecycle
  transitions). Referenced by the migration since 51872b9; written now.
- **Q190** -- the purge ceiling vs the audited write rate.

## A red that had been on the pushed branch since 51872b9

- **`tests/unit/network/no-private-table-in-network-path.test.ts` (a CI
  test) was red at 51872b9**: `CRM_AUDIT_TARGET_TABLE` now names
  `network_profiles`/`network_links`, and the leakage census requires every
  off-path file naming a network relation to be declared. Declared in
  `OFF_PATH_NETWORK_READERS` with the reason (a catalogue, no query) --
  `7db7497`. Found by gate 4's first run (1 failed / 3300).
- **The e2e server-action assertion's first full run was red on my own
  test**: an `.updated` row carries values for the allowlisted columns that
  CHANGED, not all of them (the diff design); fixed at `06b0fbc` (160 passed,
  1 failed, 3 serial-skipped on that run; the spec alone 4/4 after).

## Gates (migration count 208 on disk and in the DB before and after every run)

1. `pnpm lint` -- clean (at 06b0fbc).
2. `npx next typegen` + `pnpm typecheck` -- clean.
3. fresh reset + `run-rls-tests.sh` (at af96ddd; the later commits touch no
   psql file) -- **22 suites at pinned totals = 3794 / 0 failed** (88, 183,
   694, 187, 91, 11, 151, 127, 214, 121, 89, 56, 182, 151, 128, **186**, 168,
   143, 225, 137, 195, 267); concurrency probe PASS; API **409 PASS / 0 FAIL**.
   No pre-existing pin moved. Re-runnability: the runner refuses a second run
   without a reset by design; the new suite's § PZ asserts it leaves no row
   of its own behind (PZ1/PZ2) and it revokes no privilege.
4. fresh reset + `pnpm test` (at 7db7497) -- **151 files / 3300 tests passed**
   (149 / 3267 before: +2 files, +33 tests -- census 7, PostgREST p3-6 23,
   the remaining 3 in the two catalogue test files); permission matrix **447** (unmoved).
5. fresh reset + `pnpm test:e2e` -- see below. (Corrected in fix round 1:
   "below" never followed. The last full run before this round, at
   `06b0fbc`, was **161 passed / 1 failed / 2 did not run, 46.8 min** -- the
   failure `data-requests.spec.ts:319`, a strict-mode violation; see § Fix
   round 1, I1.)

## Fix round 1 (2026-09-30)

Base `68ada7e` (208 migrations; review MAJOR). Commits `5595f9a..0c0be4b`
plus this report, all pushed. Migrations **208 -> 210**:
`20261007000000_erasure_scrubs_ids_inside_audit_payloads.sql` (C1) and
`20261007001000_audit_coverage_reads_tgenabled.sql` (M1/M2). No shipped
migration edited.

| Finding | Status | Commit |
|---|---|---|
| C1 third-party ids survive erasure in audit payloads | **closed** | `5595f9a` |
| I1 gate 5 + honest e2e record; O3 through the real suite | **closed** (163/1 full run + 20/20 spec rerun; see Gates; N6 corrected) | `838ecc3` |
| M1 census counts a disabled trigger | **closed** | `50d47c2` |
| M2 census blind shapes | **closed where cheap (3); the rest stated** | `50d47c2` |
| M3 merge_candidate .created/.restored never exercised | **closed** | `81d7d8b` |
| M4 audit-actions.ts "no query" unenforced | **closed** | `199e13f` |
| M5 PS1c label says ten | **closed** | `19060c4` |
| docs | CLAUDE.md, SECURITY.md § 7/§ 8, FOLLOW-UPS Q122, Q191/Q192 | `0c0be4b` |

### C1: the choice, and why

Two options: (a) stop copying person ids into payloads, or (b) scrub payload
VALUES at erasure. **I chose (b)**, because:
- (a) would leave the audit row of an invitation or a role escalation unable
  to say WHO, and that is the reason `organisation_memberships` joined the
  audit at all;
- (a) would have to be enforced against every future writer, including the
  dedicated writers and every direct `private.log_audit_event()` caller,
  which the allowlist does not govern. It also does nothing for rows already
  written;
- (b) is complete regardless of key, depth, case or writer, and it is
  retroactive. It also matches how every foreign key to the person is already
  treated (the Q130 tombstone): "an Admin invited somebody" stays true, and
  WHO stops being nameable.

What shipped. `erase_account()` is rebuilt from its latest definition,
`20261001003000`; nothing later redefined it.
- **Step 6f** runs a whole-document `regexp_replace(..., 'gi')` of the id with
  the tombstone in `before` and `after` of every audit row whose text contains
  it. This is the step-6c `incident_alerts.details` shape.
- **Step 10b** runs after the delete. It counts the payloads that still
  contain the id and RAISES `identifier_survived_in_audit_payload`, so it
  fails closed. It catches a cascade-time writer, and a future rebuild that
  loses 6f. `lib/erasure/runner.ts` maps the hint to the "needs a person"
  sentence, and the derived hint-roll test goes red without it (measured).
- **`private.audit_payload_person_columns()`** is the derived guard. It lists
  every (target, column, writer) that is copied BY VALUE and identifies a
  person:
  - the writers are `audit_crm_change` (via the allowlist) and
    `audit_crm_row` (via `audit_crm_payload()`'s keys, asked with `'{}'`);
  - "identifies a person" means a single-column FK to
    `auth.users`/`public.profiles`, or a `user` row on the FK-less roll.

  It is derived from `pg_trigger`, so a new table joins it automatically. It
  has 19 rows today. Stated limit: dedicated writers build their payloads in
  code it cannot read. 6f and 10b cover them by value anyway.
- The reissued `comment on function` says so. The new migration's header is
  the correction of record for `20261001003000:15-17`, which is a plain `--`
  comment in an immutable file and is left as written.

**Red first (O1), measured at 208 before the migration.** I used a scratch
script in a rolled-back transaction:
1. An aal2 Admin invites X, creates a task and reassigns it to X.
2. 2 payloads contain X (`membership.created` and `task.updated`, both with
   actor = Admin and target != X).
3. `erase_account(X)` succeeds.
4. **2 payloads still contain X.**

The same script after the migration: 2 -> **0**.

**Standing proof: `rls_phase8_erasure.sql` § EP** (195 -> 208, +13).
- **Fixture:** a fourth account (the aal2 Owner of a fourth workspace)
  invites the subject and reassigns a task to them, through a REAL session.
  The fixture also plants one payload per row of the derived roll: the value
  in `before`, UPPER-CASED in `after`, and nested.
- **EP1** pins the roll by name.
- **EP2, EP3, EP4 and EP5** are the denominator: 1 + 1 + 19 = **21** payloads
  contain the subject.
- **After the erasure:**
  - EP6: 0 payloads contain the subject, anywhere.
  - EP7 and EP8: the two real rows survive, with the tombstone in place of the
    subject and the Admin kept.
  - EP9: all 19 planted rows are scrubbed in all three positions.
  - EP10: the summary counts 21.
- **EP11 is the standing mutation of 10b.** A throwaway `AFTER DELETE`
  trigger on `public.profiles` writes a payload containing the id during
  step 9, which is after 6f. The erasure must refuse with
  `identifier_survived_in_audit_payload`.
- **EP12** proves the rollback: the account and profile are still there, and
  no late row exists.

The first run of § EP was red on my own test (7 failures):
- EP2, EP3, EP7 and EP8 read `after->>'user_id'`, but the generic writer nests
  values under `after->'values'`.
- EP9 double-counted `membership.user_id`, which is on the roll twice (once
  per writer). It now uses `count(distinct e.id)`.
- EP5 and EP10 were measured placeholders. They are pinned at 21, with the
  arithmetic in the comment.

**Mutations (psql layer).** The erasure suite was run whole on a populated DB
and restored after each:

| mutant | result |
|---|---|
| drop step 6f (10b kept) | the erasure REFUSES (21 payloads), so the suite aborts at the run with a `psql: ERROR` line and 115/208 recorded. Red on the runner's ERROR guard AND its pinned total |
| 6f case-sensitive (`'g'` for `'gi'`) | refuses with **19** (exactly the upper-cased planted values), and the suite aborts the same way |
| drop step 10b | **3 red**: EP11, EP12 and ER5. ER5 is collateral: the late-writer erasure succeeded and wrote a second summary row |
| drop both (= the pre-fix function) | **8 red**: EP6-EP12 and ER5 |
| unit: drop the runner's hint case | `failure-sentence.test.ts` is red: "identifier_survived_in_audit_payload falls through to the default" |
| guard: add `tasks.reviewed_by uuid references auth.users` and allowlist it (rolled back) | the roll grows 19 -> 20 with `task.reviewed_by:audit_crm_change`. EP1's pinned string would go red naming it, and EP4 would plant it |

**Cost (Q192):** 6f and 10b are two sequential scans. I measured **0.45 s per
scan over 500k audit rows** locally.

### I1: gate 5, the failing locator, and O3

**The failure was pre-existing and timing-dependent, not caused by Task 7.**
- `git diff c72f92e..06b0fbc` touches none of
  `tests/e2e/data-requests.spec.ts`,
  `components/admin/dsr-transition-forms.tsx` or `lib/dsr/`.
- The mechanism:
  1. `getByText` is a case-insensitive substring match.
  2. After "Pass it on to X", the row becomes `routed`. The routing form stays
     revealed, because its `revealed` state survives the revalidation.
  3. The form then renders "Currently recorded as passed to X. Naming a
     different workspace corrects that record." That contains "recorded as
     passed to X".
  4. Whether that copy was in the tree when the locator resolved was a race.
     Task 6's run (164 passed) lost it, and this task's first full run won it.

**Fix (`838ecc3`):** both confirmation sentences are asserted inside
`getByTestId("dsr-outcome").getByRole("status")`. That is the
`<ActionOutcome>` region that carries the confirmation. No retry and no
timeout change.

**O3: mutation (b) through the REAL suite.** I added `body` to the note
allowlist, ran `rls_phase8_crm_audit_p3_6.sql` whole, then restored the
function from the migration's text and re-ran it (204/0). Result: **7 red**,
namely PA4e, PA5, PA5c, PI5b, PI5d, PU5b and PS1. The review predicted PA4e,
PA5, PI5b and PU5b; PA5c, PI5d and PS1 are extra.

### M1: tgenabled

**O2 before the fix** (208 plus the C1 migration, old census). With `alter
table public.tasks disable trigger audit_update`, I ran
`crm-audit-coverage-census.test.ts` and `audit-actions-match-db.test.ts`:
**19/19 green, which confirms the false green.**

**After `20261007001000`,** with the same disabled trigger, the census went
**3 red, by name**:
- "Uncovered: organisations:UPDATE, tasks:UPDATE";
- the generic set is missing `tasks`;
- the excusal set gains `tasks`.

`audit-actions-match-db` stays green. It counts triggers by name, and the
census is now the guard that reads `tgenabled`. I re-enabled the trigger:
8/8.

Both probes now require `tgenabled in ('O','A')`, which excludes both 'D'
(disabled) and 'R' (replica-only). Planted:
- psql: PC8e (disabled pair), PC8f (replica-only), and PC8g/PC8h (a dedicated
  writer, as a positive control and then disabled);
- integration: disable -> unaudited, `enable replica` -> unaudited,
  `enable always` -> generic.

### M2: blind spots

Closed, because they were cheap. Each is planted with a positive control in
both layers:
- **M2a:** `rpc_only` requires `relrowsecurity` (PC8i on, PC8j off).
- **M2b:** a table with an `organisation_id` column and no direct FK is in the
  denominator (PC8k). It adds no real table today (measured: 0).
- **M2c:** a client-writable auto-updatable view is in the denominator and can
  only read `unaudited`:
  - PC8l: with no grant, the view is absent.
  - PC8m: once granted, it is unaudited, and its base table is still absent.

  There are none today: `network_directory` and `network_connected_profiles`
  are auto-updatable but have no client write grant.

Stated but not closed (in the migration header, the census test header and
SECURITY.md § 7):
- What a trigger DOES. The behavioural suites cover that.
- A trigger `WHEN` clause. `feedback_audit_status_change` and
  `incident_alerts_audit_resolution` are both legitimate, so closing this
  needs a per-trigger excusal list.
- Tables written only by a SECURITY DEFINER function. **I found a live
  instance while closing M3:**
  - `merge_candidates` has no client INSERT grant, so `merge_candidate.created`
    is outside the census entirely.
  - Disabling its `audit_insert` reds PQ2c and PQ6, and nothing in the census.
- Any schema but `public`, and any client role but `authenticated`/`anon`.

**Per-clause mutations.** Each clause was removed alone from the new
function. I ran the psql suite whole plus the census integration test, and
restored after each:

| clause removed | psql red | integration red |
|---|---|---|
| generic `tgenabled` | PC8e, PC8f | planted test ("expected 'generic' to be 'unaudited'") |
| dedicated `tgenabled` | PC8e, PC8f, PC8h (a disabled `audit_crm_change` trigger then counts as "dedicated") | planted test |
| `relrowsecurity` | PC8j | M2 test ("RLS off ignores the policy") |
| `organisation_id` disjunct | PC8k | M2 test |
| view disjunct | PC8m | M2 test |
| (restored) | 204/0 | 8/8 |

### M3

psql § PQ sits after § PS, so the volume measured in PS4/PS5 is unchanged.
- **Setup:** a Manager creates two contacts with a sentinel name and runs the
  real `screen_for_duplicates()`.
- **PQ2b** proves the pair was flagged, with the sentinel in its label.
- **PQ2c:** `merge_candidate.created` has actor pmanager, org ALPHA, exactly
  the allowlisted keys, and the owners carried. The label and the name are
  absent.
- **`.restored` is not reachable from a client:**
  - PQ4 measures the refusal (42501). The resolve policy's `WITH CHECK` needs
    `resolved_by = auth.uid()`, and the CHECK needs all three columns to be
    null together.
  - PQ5 writes `.restored` through a session-attributed restore shaped like a
    definer.
  - PQ6 checks the whole story.

  Queued as **Q191** (default: keep the catalogue entry).
- **Mutation:** disabling `merge_candidates.audit_insert` reds PQ2c and PQ6.

### M4

In `no-private-table-in-network-path.test.ts`, `CATALOGUE_ONLY_OFF_PATH`
(`lib/admin/audit-actions.ts`) must contain none of these: `import`, dynamic
import, `require`, `.rpc(`, `fetch(`, or `.from(` other than `Array.from(`.
- **Denominator:** the file names `CRM_AUDIT_TARGET_TABLE` and a network
  relation.
- **Positive control:** one per shape.
- **Mutation:** appending `db.from("network_profiles")` to the file reds it
  with "declared a catalogue and now issues a query: [ 'a .from( call' ]". I
  restored the file afterwards.

### M5

PS1c now reports `9/1`: nine rows carrying the sentinel, and the event's
`ticket_link` as a second sentinel column. The label says nine. The
assertion count is unchanged.

### Re-runnability (lesson 11)

On one populated database during the mutations, the erasure suite ran 7
times and the CRM audit suite 9 times. Each ended green, and neither revokes
a privilege. The erasure suite needs a cleanup between runs only after a run
that ABORTED mid-way (the mutants that make the erasure raise). That is the
same as before this round.

### Gates (at `0c0be4b`; the only later commit is this report)

The migration count was **210 on disk and in the DB before and after every
run**.
1. `pnpm lint`: clean.
2. `npx next typegen` + `pnpm typecheck`: clean.
3. Fresh reset + `run-rls-tests.sh`: **22 suites at pinned totals = 3825 / 0
   failed**:
   - per suite: 88, 183, 694, 187, 91, 11, 151, 127, 214, 121, 89, 56, 182,
     151, 128, **204**, 168, 143, 225, 137, **208**, 267;
   - the retention concurrency probe passed;
   - API **409 PASS / 0 FAIL**;
   - "All suites passed", exit 0. 210 -> 210.
4. Fresh reset + `pnpm test`: **151 files / 3305 tests passed**, exit 0.
   - It was 3300 before: +1 census M2 test, +2 M4, and +2 `migration-encoding`
     per-file cases for the two new migrations.
   - Permission matrix **447** (unmoved).
   - 210 -> 210.
5. Fresh reset + `pnpm test:e2e` (at 0c0be4b, 210 -> 210): **163 passed / 1 failed / 0 did not run (46.8m)**. The one red: `tenant-breakout.spec.ts:172` REFUSAL PARITY hit the 60 s test timeout with the ghost page still on the "Loading..." skeleton (Protocol error: session closed) -- the machine was memory-starved. Re-run of that spec alone after a fresh reset (recorded by the controller): **20 / 20 passed (5.3m)**, the parity test at 54.8 s. Not a Task 7 regression (no page, loader or tenant-breakout change in range); it IS a latent near-timeout: a 50+ s test under a 60 s ceiling. Logged as follow-up F-T7-1 (split the per-family loop or raise that one test's timeout -- never retries).

### Questions queued

- **Q191:** `merge_candidate.restored` has no client path. Default: keep the
  catalogue entry.
- **Q192:** the erasure's payload scan cost as the log grows. Default: no
  change at MVP; add a write-time `person_ids uuid[]` + GIN when the table
  passes ~2M rows.
