# Phase 8 Task 9b fix round 2 (N1, N2, N3): SCOPED RE-REVIEW 2

Range `59f4a9c..c3e3029`, worktree `legal-phase`, 224 migrations. This was a read-only review: no reset, no psql runner, no integration vitest, no Playwright and no dev server. The only thing I ran was `tests/unit/email/connection-reminder-templates.test.ts` (117 passed). Anything marked **[static]** I derived by reading and did not execute.

**VERDICT: READY.** N1, N2 and N3 are all closed. There is one new Minor (N4, a missing test) and one Note. Neither blocks the merge.

---

## N1: CLOSED [static]

### Every column of `public.network_connection_requests`

The table is created in `20260904000000:369-404`. No later migration adds a column: I grepped every `alter table public.network_connection_requests` across the 24 files that name the table.

| Column | How an UPDATE is controlled now |
|---|---|
| `id` | Pinned by (a). Not in the column grant. |
| `from_organisation_id`, `from_network_profile_id` | Pinned by (a). Not in the grant. |
| `to_organisation_id`, `to_network_profile_id` | Pinned by (a). Not in the grant. |
| `status` | Granted. A change is bound to its side by (c), which reads the **OLD** row. The terminal-state freeze is the existing transition guard. |
| `requested_by`, `requested_at` | Pinned by (a). Not in the grant. Stamped at INSERT by `born_pending`. |
| `responded_by`, `responded_at` | Granted. On a status change they are stamped by (b), and a foreign `responded_by` is refused. With no status change any edit is refused. |
| `created_at` | Pinned by (a). Not in the grant. |
| `updated_at` | Not in the grant, not pinned. `set_updated_at` overwrites it (it sorts after `bound_update`). Harmless. |

**Two layers, each sufficient on its own for the party columns:**
- **The grant layer:** `revoke update` at table level also removes any column privileges, then `grant update (status, responded_at, responded_by)`. A PATCH or UPSERT `DO UPDATE` that names a party column is refused with 42501 before any row is read.
- **The trigger layer:** (a) refuses the same changes with 23514.

The mutation table in the report shows that (a) alone is what stops a same-status swap when the grant is lent.

### Status transition matrix

| From | To | Who may do it | What enforces it |
|---|---|---|---|
| `pending` | `accepted` / `declined` | OLD `to_org` holds `manage_network_connections` and publishes | (c), plus the recipient policy |
| `pending` | `withdrawn` | OLD `from_org` holds `manage_network_connections` (no tier term) | (c), plus the sender policy |
| any terminal state | anything else | nobody | the transition guard |
| any | the same status | allowed, but a no-op | (a) and (b) leave nothing movable except `updated_at` |

- **The sender accepting or declining** is refused by (c), because OLD `to_org` is not the sender's.
- **The recipient withdrawing** is refused by (c), and by the policy's org term.
- **Trigger order:** `bound_update` < `guard_status_transition` < `set_updated_at`. BEFORE triggers run before WITH CHECK, which is why H4 moves from 403 to 400. The request is still refused, just by an earlier layer.
- **Declined requires publish.** `declined` needs `network_publish_organisations()`, which is the same as the recipient policy's existing WITH CHECK. This is not a behaviour change.

### Can DELETE plus re-INSERT forge an acceptance?

No.
- **No DELETE path exists.** `20260904000000:630-635` revokes everything and grants `authenticated` only select, insert and update. There is no DELETE policy, and `service_role` holds nothing on the table.
- **A re-INSERT is born pending** (`born_pending`, C1).

### Other writers: does the narrowed grant or the trigger break any of them?

- **`service_role`** has no privilege on the table at all (`:630`). No runner writes it, and that includes the notice stamps: the stamps are a separate ledger table, deliberately so (`20261016000000:104`).
- **Application code:** `lib/network/connections.ts` is the only writer. It does one insert and three `.update({status})`, and each update pins its own side's organisation column.
- **No SECURITY DEFINER function** updates the table. I grepped all 24 migrations that name it.

### Erasure: is there a Critical regression? No. One Minor (N4)

- **`requested_by` and `responded_by` are `ON DELETE SET NULL`**, so `erase_account`'s pg_constraint re-point walk skips them. That walk handles only references with no ON DELETE action.
- **They are nulled by the `delete from auth.users` inside `private.erase_account`.** That function is SECURITY DEFINER in its latest definition (`20261007000000:65-69`), owned by `postgres`.
- **Who the trigger sees on that path:** PostgreSQL runs a referential SET NULL as the owner of the referencing table (`ri_triggers.c` switches to `relowner`). So `current_user` inside the invoker trigger is `postgres` and the exemption applies. This is also true of a GoTrue `deleteUser` run by `supabase_auth_admin`.
- **What the trigger would otherwise do:** without the exemption, (a) would refuse the `requested_by` change and (b) would refuse the `responded_by` change on a terminal row, and erasure would abort.
- **Workspace deletion and the retention sweeps** do not update this table. They reach it through `ON DELETE CASCADE` deletes.

### NU1/NU2/NU5 "disable the trigger for exactly those statements": sound

- **Every disable has a matching enable.** Each `disable trigger bound_update` is followed by an `enable` in the same block.
- **Each re-enable is asserted** (NU2b, NU5c).
- **The failing statements cannot leave the trigger off.** They run inside `nw.try`, which traps the error, so the script does not abort with the trigger disabled.
- **The suite cannot be re-run without a reset.**
- **Nothing is hidden.** With the trigger on, the same three refusals are asserted directly by NQ4, NQ5 and NQ5b (23514), and NQ8/NQ8b plus the HTTP twin assert the grant as shipped. Each layer is asked about on its own, and the shipped combination is asked about too.
- **Lent grants are returned.** The table-level UPDATE grant lent for NQ1–NQ6 and NQ9–NQ11 is revoked and narrowed again afterwards, and NQ0c checks that.

## N2: CLOSED [verified, unit]

- **The template:** the task-reminder sentence now quotes the title, so the template's full stop never directly follows the person's text.
- **Truncation:** `oneLine` neutralises again after truncating, because the ellipsis NFKC-folds to `...`.
- **No other template has the same shape.** The other `${...}.` sites in `lib/email/*template*.ts` are enums, references or dates, never person-authored text.
- **Tests:** the 5 new cases pass.
- **A cosmetic residual:** a title cut just after `www` loses `www.` together with part of the ellipsis. The text reads oddly but is deliverable.

## N3: CLOSED as accepted [verified]

FOLLOW-UPS has a new section, "Opened by Phase 8 Task 9b fix round 2". It records that any `build()` throw, a bad deploy included, now drops the notice permanently, and it gives the proposed split:
- `NoticeContentError` stays terminal;
- builder-invariant failures are left unstamped and retried;
- a Telegram alert fires on a burst of builder throws.

Accepting this is sound: the loss is bounded by the 7-day window.

---

## New findings, ranked

### N4 (MINOR): erasure through the new trigger is argued but not tested

The owner-role exemption is now **load-bearing for account erasure**. Without it, nulling `requested_by` or `responded_by` would raise 23514 and abort `erase_account` for anyone who ever sent or answered a request.

The argument holds: a referential SET NULL runs as the table owner, which is `postgres`. But **no psql or integration test erases an account that is named on a `network_connection_requests` row**. Grepping the erasure suites for the table finds nothing.

This needs one assertion in the erasure suite, owed with the next change there:
1. Seed a sent request and an answered one, naming the subject user.
2. Run `erase_account`.
3. Expect `ok`, with both columns now NULL.

It also guards against a future change of table owner, or a future migration that rebuilds the trigger without the exemption.

### Note: SECURITY DEFINER writers are exempt by construction

A future definer RPC that updates this table would bypass (a), (b) and (c), just as with `born_pending`. Both migration headers already say so, and no such function exists today. No action needed.
