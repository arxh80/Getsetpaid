# Phase 8 Task 7, fix round 1: independent scoped re-review

Range `68ada7e..56492aa` (8 commits, migrations 208 → 210), worktree
`legal-phase`, branch `worktree-legal-phase`, reviewed at `56492aa`.
I did not write any of the code under review, and I edited no product code.

**VERDICT: MINOR.** C1 is closed in the code, and I could not break the fix
by reading it. M1–M5 are closed. I1 is half closed. O3 was run through the
real suite and recorded, and the locator fix is sound. But gate 5 is
**still running at the tip**: the report's own Gates section says so, while
its status table says "closed". Six new findings, all Minor or nit. None
changes today's behaviour in a way that breaks a promise.

---

## Method and constraints

A detached e2e run owns the local stack and port 3000. So I ran no
`db reset`, no psql runner, no `pnpm test`, no `pnpm test:e2e` and no
`pnpm dev`. **Every mutation below is reasoned from the code, not run.**
§ Owed lists what needs a database, with exact steps.

Run here, at `56492aa` (clean tree):

- `pnpm lint`: clean.
- `npx next typegen` + `pnpm typecheck`: clean, exit 0.
- **The pinned totals, checked by hand:**
  - The erasure suite has **208** top-level `er.*` call sites: 149 `val`,
    40 `try_hint`, 13 `try`, 5 `try_says` and 1 `try_lacks`. That matches
    the runner's pin of 208.
  - The CRM audit P3-6 suite has **204** `c7.val`/`c7.try` call sites,
    which matches its pin of 204.
  - CLAUDE.md's twenty-two numbers sum to **3825**, which is 3794 + 18 + 13.
- **Rebuild diffs, done mechanically.** I extracted each function body with
  `awk` and ran `diff`:
  - `erase_account()`, from `20261001003000` to `20261007000000`: the
    **only** changes are step 6f and step 10b. No step is lost or reordered,
    and no guard is weakened. Grep confirms that no migration between those
    two redefines `erase_account`, alters it or re-comments it.
  - `audit_coverage()`, from `20261006000000` to `20261007001000`: the only
    changes are the four stated in the header (M1 ×2, M2a, M2b, M2c).

---

## C1: third-party ids in audit payloads survive erasure. **CLOSED**

### Every place an id can sit

`public.audit_events` has exactly ten columns (`20260826151656:167-178`). No
later migration adds one: the only `alter table public.audit_events` is the
RLS enable. Here is how each column that could carry the person is handled:

| column | can it carry the person's id? | handled by |
|---|---|---|
| `actor_user_id` | yes (FK, NO ACTION) | step 7 re-point, step 8/10 assert |
| `target_id` | yes (polymorphic uuid) | step 6b (re-point + payload drop) |
| `before`, `after` | yes (any key, any depth, any writer) | **6f** (value replace) + **10b** (refuse) |
| `correlation_id` | only if a writer used a user id as a thread id | grep over `supabase/migrations` and `lib/`: no writer derives one from a user id |
| `action`, `target_type` | closed code vocabularies | n/a |
| `organisation_id`, `id`, `created_at` | no | n/a |

There is no `metadata` column. Within the payloads, 6f works on
`before::text` and `after::text`, so it covers:

- **JSON keys as well as values.** This is a text replace, not a key walk.
- **Arrays and nesting to any depth.**
- **Ids embedded in longer text**, such as a sentence or a storage key
  containing the uuid.
- **Upper case**, through `'gi'` and the `lower()` in the WHERE clause.

`jsonb::text` never escapes hex digits or `-`, so no `\u` escape can hide an
id from the scan.

### Could the replace corrupt unrelated JSON?

- **It cannot produce invalid JSON.** Both the pattern and the replacement
  are 36-character strings over `[0-9a-f-]`. Nothing in the pattern is a
  regex metacharacter: `-` is literal outside a bracket. No quote or
  backslash is ever introduced, and a `jsonb → text → jsonb` round trip is
  lossless.
- **Substring collisions only hit what should be scrubbed.** A uuid's text
  form has a fixed length and fixed hyphen positions. So it cannot be a
  prefix of, or sit inside, a *different* uuid. The only other match is the
  id embedded in a longer string, and scrubbing that is the intent.
- **One edge case exists: a key collision (N3).** It needs a payload *keyed*
  by user id. No writer does that today.

### 10b: the refusal is sound and atomic

- It runs **after** the step-9 delete, in a fresh statement snapshot. So it
  sees anything a cascade wrote inside this transaction.
- It raises `55000` with its own hint, and nothing inside `erase_account()`
  catches it.
- `run_erasure_job` (`20261001006000:335-390`) calls `erase_account()` with
  **no exception block**. So the raise aborts the whole transaction: the
  erasure, the DSR seam and the job's `succeeded` flip together.
  `fail_erasure_job` then records the failure in a separate transaction, as
  before.
- `lib/erasure/runner.ts` maps the hint to the "needs a person" sentence, and
  the derived hint-roll test pins it.

The one thing 10b cannot see is a *concurrent* writer that commits after 10b
has scanned (N2). That gap is the same one step 6a already has.

### The guard is derived, not hand-listed

`private.audit_payload_person_columns()` reads these at call time:

- `pg_trigger`, for which tables carry `audit_crm_change` or `audit_crm_row`
  and with which arguments;
- the allowlist function's own answer;
- `audit_crm_payload(args[2], '{}')`'s keys. `jsonb_build_object` keeps
  null-valued keys, so the empty-row probe really does return the projection's
  keys (`20261006000000:398-426`);
- `pg_constraint`, for FKs to `auth.users` or `public.profiles`;
- the FK-less roll.

Nothing in it is a literal, and a new trigger joins it automatically. It
reads triggers regardless of `tgenabled`, which is the right choice here
because over-inclusion is the safe direction. Its stated limit (dedicated
writers build their payloads in code it cannot read) is honest, and it does
not matter for correctness, because 6f and 10b work by value. EP1 pins the
19 rows by name. The report's added-column mutation grows the set to 20, and
by reading the function I agree it would.

### Is the O1 reproduction genuine?

The scratch script is not committed, so I cannot re-run it. But the
committed fixture has the same shape, and it is sufficient on its own:

- **EP2 and EP3 are real session writes, not planted rows.** An aal2 Owner
  invites the subject and reassigns a task to them, under
  `set role authenticated` with JWT claims. The Owner is the actor, and the
  target is a membership or a task. That is exactly the O1 shape.
- **The "drop both" mutant is the red-first evidence.** It is the pre-fix
  function, and the report records EP6–EP12 red under it.
- **EP4 plants one row per roll entry**, with the id in `before`, upper-cased
  in `after`, and nested. Together with EP9's `count(distinct e.id)`, that
  measures the scrub on every derived column in three positions.
- **EP11 is a genuine mutation of 10b.** It uses an `AFTER DELETE` trigger on
  `profiles` that fires during step 9, after 6f, and it asserts the specific
  hint. EP12 then proves the rollback, and EP13 proves the throwaway trigger
  is gone.
- **EP10 cross-checks the count.** The summary's `payload_values = 21` is
  the same 21 rows as EP5's denominator.

I would still like one independent run of O1 (§ Owed, O1′).

---

## I1: gate 5 and O3. **HALF CLOSED**

- **O3 is closed.** Mutation (b) was run through the real
  `rls_phase8_crm_audit_p3_6.sql`: 7 red by label, restored, then 204/0.
  That is recorded, not predicted.
- **The locator fix is sound.** I checked it against the component:
  - `<ActionOutcome>` renders `data-testid` on a wrapper holding exactly one
    `role="status"` div and one `role="alert"` div, and `{children}` is
    rendered **outside** that wrapper (`components/ui/action-outcome.tsx:131-150`).
    So `getByTestId("dsr-outcome").getByRole("status")` resolves to one
    element, and it is not the overdue banner, whose `role="status"` sits
    among the children.
  - Both assertions match the one success string at
    `lib/dsr/admin-actions.ts:290`.
  - The diff adds no retry, no timeout and no config change.
  - It asserts the property the test is about: the operator is told it was
    recorded, and told that nothing was sent.
- **Gate 5 is still open.** The report's Gates section ends with
  "5. … RUNNING (launched detached 15:25:49 at 0c0be4b …)", but its status
  table marks I1 **closed** (N6). The new locator has not yet been through a
  full e2e run. This is the detached run that owns the stack now.

## M1: tgenabled. **CLOSED**

Both probes now require `tgenabled in ('O','A')`:

- `'O'` fires under `session_replication_role` = `origin` or `local`, which
  is what every client write runs under.
- `'A'` always fires.
- `'R'` fires only under `replica`, and `'D'` never fires.

So excluding R and D is correct. The dedicated probe gets the same clause.
The plants cover every case: PC8e (D), PC8f (R), PC8g/PC8h (dedicated, with
a positive control and then disabled), and the integration test's
D → R → A walk, whose `enable always` step proves 'A' still counts.

## M2: blind spots. **CLOSED where cheap, the rest stated honestly**

- **M2a (RLS on), M2b (`organisation_id` column) and M2c (writable view)**
  are each planted with a positive control in both layers.
- **The stated remainder is accurate:** what a trigger does, `WHEN` clauses,
  definer-only tables (with a live instance, `merge_candidates` INSERT,
  found and disclosed), and other schemas and roles.
- **Two small inaccuracies in the M2c framing** are recorded as N5.

## M3: merge_candidate `.created` / `.restored`. **CLOSED**

- **`.created`** comes from the real `screen_for_duplicates()` under a
  Manager session (PQ2), after PQ2b proves the pair was flagged.
- **`.restored` is measured as unreachable from a client** (PQ4, 42501), and
  is then written through a session-attributed definer shape (PQ5).
- **Q191 is the right place** for the question of whether to keep the
  catalogue entry.

## M4: catalogue-only off-path file. **CLOSED** (nit N4)

The detector has a denominator (the file really is the catalogue, and it
really names a network relation). It has a positive control for each shape,
and `Array.from` is correctly exempt: `myArray.from(` is still flagged,
because `\bArray` needs a word boundary. `stripComments` runs first. It is
robust against every realistic way to add a query to this file.

## M5: PS1c label. **CLOSED**

The assertion now reports `9/1`: nine planted rows, plus the ticket-link
column reported separately. It has the same assertion count.

---

## NEW FINDINGS

### N1 (Minor): erasures completed before `20261007000000` are not revisited

The migration header calls 6f "retroactive over every row already written".
That is true for every subject erased **from now on**. But an account erased
under the earlier function has already hit step 1's idempotence
(`already_erased`), so re-running `erase_account()` cannot scrub the id it
left behind. Nothing in the migration does a one-off sweep for them.

The window is Task 5 → now for the Phase 2 `owner_user_id` rows, and Task 7
→ now for the rest. The product is pre-launch, so the practical exposure is
probably zero. But neither the header nor SECURITY.md says so.

**Fix options:**
- say "for every erasure run after this migration";
- or add a one-off sweep. The roll now makes it derivable: for each
  `audit_payload_person_columns()` row, find payload values that are a uuid
  not in `auth.users` and not the tombstone, and replace them with the
  tombstone.

### N2 (Minor, a stated limit rather than a regression): a concurrent snapshot-copy writer can commit after 10b

10b's guarantee covers writes in the same transaction and writes committed
before its statement starts.

- **An FK-checked writer is safe.** Example: an Admin reassigning a task to
  the subject. The FK check takes KEY SHARE on the subject's `auth.users`
  row, so it serialises against the step-9 delete: it either blocks the
  delete (and 10b then sees its row) or fails.
- **A writer that copies the id from a snapshot, with no FK lock, is not.**
  The example is `screen_for_duplicates()` writing `keep_owner_user_id` from
  a contact it only *reads*. It can commit a `merge_candidate.created`
  payload (and the `merge_candidates` row itself, which is step 6a's class)
  naming the subject **after** the erasure commits. The window is
  milliseconds, and the gap already exists for 6a.

**Fix options:** state it as a limit in the 10b comment, or queue it (for
example, a `FOR SHARE` on the owner's `auth.users` row inside the screen).
It does not block this round.

### N3 (nit): a payload keyed by user id could lose an entry

If a future writer keys an object by user id, a payload holding both the
subject's key and a previously erased person's key (already the tombstone)
becomes text with a duplicate key. `::jsonb` silently keeps the last one. No
writer keys by user id today, and EP4 plants values only. One sentence in
the 6f comment would cover it.

### N4 (nit): M4's "no module import of any kind" misses a re-export

`export { x } from "./db"` passes all six shapes. I measured it:
`/^\s*import\b/m` is false for that line. The file has no `from '…'`
clause today. To close it, add `/\bfrom\s+['"]/` to `queryShapes`, or soften
the comment.

### N5 (nit): M2c's framing is slightly off in two directions

- **Over-report.** A write through an *auto-updatable* view is rewritten
  onto the base table, and the base table's triggers fire. So a view over an
  *audited* base table is reported `unaudited` although it is audited. The
  red is false, but it is fail-safe and would only need an excusal. The
  header's "can only ever read `unaudited`" is true of the label, not of the
  audit.
- **Under-report.** `pg_relation_is_updatable(oid, false)` excludes a view
  made writable by an `INSTEAD OF` trigger. That case falls under the stated
  rules anyway: an invoker trigger needs base grants, which puts the base
  table in the denominator, and a definer trigger is the definer-only rule.
  But it is not named.

### N6 (nit): the report's status table overclaims I1

The table says "**closed** (see Gates)", and the Gates section says gate 5
is RUNNING. Correct it when the run is recorded.

### Notes (no finding)

- **6f is wider than C1 asked, in a good way.** It also scrubs the subject's
  id where it appears in, for example, a superuser's self-audited audit-log
  search filter, or an operator's `erasure_job.*` or
  `data_subject_request.*` rows. Those were the same class, and nobody had
  named them.
- **What stays linkable.** After erasure, a `membership.*` row's `target_id`
  (the deleted membership row's id) still links that membership's history
  together under the tombstone. So does a task id. That is the Q130 design:
  what happened stays, and who it happened to stops being nameable. It is
  not new here.
- **An inconsistency next to 6f.** Step 6c (`incident_alerts.details`) is
  still a case-sensitive `replace`, and has no post-delete check. It was
  out of scope and was already like that, but it now sits beside a
  case-insensitive sibling. Worth one line in the next erasure round.
- **Cost.** 6f and 10b are unindexed scans, measured at 0.45 s per 500k
  rows. That is correctly queued as Q192.

---

## Owed: run after the e2e run releases the stack

**O1′ (C1, an independent confirmation).** `npx supabase db reset --local`
at 210 migrations. Then, in psql:

1. Plant the pre-fix function by reissuing `erase_account` from
   `20261001003000`'s text.
2. As an aal2 Admin session (`set role authenticated;
   set request.jwt.claims …`), insert an `invited` membership for a
   throwaway user X, then create a task and set `owner_user_id = X`.
3. `reset role`. Count `audit_events` where `lower(before::text)` or
   `lower(after::text)` contains X. **Expect 2.**
4. Run `select private.erase_account(X)`, then re-count. **Expect 2
   (red).**
5. Roll back, reinstate the 210 definition (`20261007000000`), and repeat.
   **Expect the count to go 2 → 0, and `payload_values = 2` in the
   returned summary.**

**O4 (I1): gate 5.** Read the detached run's log. Record passed / failed /
did-not-run, the duration, and the migration count before and after.
**Expect 164 passed at 210 → 210.** Then correct the status table (N6).

**Optional (N2): measure the race.** In session A, `begin`, then run
`screen_for_duplicates()` under a Manager for a contact owned by X, and do
not commit. In session B, run the erasure of X to completion. Then commit A.
Count payloads containing X. **Predicted: ≥ 1.**

---

## Verdict

**MINOR.** C1, the finding that made the review MAJOR, is closed:

- the erasure is a faithful rebuild with two added steps;
- the scrub is complete over every column and position in `audit_events`;
- the refusal is atomic and fail-closed;
- the guard is derived;
- the standing proof uses real session writes, a per-column plant and a
  genuine 10b mutation.

M1–M5 are closed. What remains is gate 5, which is running now, and six
Minor or nit findings (N1–N6). None needs another review round. I would
fold N1 (one sentence, or a one-off sweep), N2 (a stated limit or a queued
question) and N6 into the round that records gate 5.
