# Phase 8 Task 9b fix round 1 (parts A + B): SCOPED RE-REVIEW

Range `e3109ea..f3772ef`, worktree `legal-phase`, 223 migrations. This was a read-only review: no reset, no psql runner, no integration vitest, no Playwright and no dev server. I ran two unit files (`connection-reminder-templates`, `send`: 123 passed) and a node emulation of the sanitiser in the scratchpad. Anything marked **[static]** I derived by reading and did not execute.

**VERDICT: MAJOR.** Every finding from the original review is closed or soundly accepted. The re-check of C1, though, found its **UPDATE-side sibling (N1, Critical)**. It is pre-existing since Phase 6 and is not introduced by this round. A requester can still turn a request into an `accepted` connection the counterparty never agreed to, with no INSERT involved. "Can any path still create a non-pending row" was the question C1 left open, and the answer is still yes.

---

## Original findings

### C1: born pending. CLOSED for INSERT; see N1 for UPDATE.

- **[verified]** `20261017000000`:
  - The `born_pending` BEFORE INSERT trigger is SECURITY INVOKER.
  - It refuses a non-`pending` status, a pre-filled `responded_*`, and a foreign `requested_by`, each with 23514.
  - It then stamps `requested_by` and `requested_at`.
  - Its name sorts before `fill_recipient_organisation` and `meter_connection_request` (b < f < m).
  - The INSERT WITH CHECK repeats the status terms. The policy body otherwise matches the shipped one term for term.
- **UPSERT / ON CONFLICT DO UPDATE:** the BEFORE INSERT trigger fires before conflict arbitration, so a forged status is refused on that path too. The DO UPDATE arm goes through the UPDATE policies, which is N1.
- **SECURITY DEFINER inserters:** I grepped `supabase/migrations`, `lib` and `app`. The only writer is `lib/network/connections.ts:306`, a user-JWT PostgREST insert. No definer function inserts into the table. The migration header correctly warns that a future one would run as owner and be exempt.
- **`postgres` / `supabase_admin` exemption:** PostgREST connects as `authenticator` and can only SET ROLE to anon, authenticated or service_role, so no API request runs as either exempt role. COPY is not reachable through PostgREST. The exemption reaches operators, seeds and fixtures only. `service_role` is bound (NP4).
- **Q79 re-request after decline:** unaffected. A fresh row is born `pending`, and the live-pair index is still `pending`/`accepted` only (`20260907000000`).
- **m3 remainder (`responded_at`/`by` client-supplied on UPDATE):** this is **not merely cosmetic.** On its own it lets a responder back-date past the 7-day window and suppress the sender's email. Combined with N1 it is the step that makes the forgery silent. Fold it into N1's fix.

### I1: FOLLOW-UPS.md. CLOSED [verified]

`git diff 656362b f3772ef -- FOLLOW-UPS.md` has exactly three hunks:
- `@@ -2546` and `@@ -3536`: 348523a's two intended hunks, with the C1 entry added inside the second.
- `@@ -4447`: a new "Opened by fix round 1 part B" section with m4, m6 and the I3 and I2 residuals.

Every removed line is one of the two rewritten Q45 sentences. No unrelated loss: 46 lines added, 4 removed.

### I2: queue poisoning. CLOSED, with one Minor (N3) [verified, static SQL]

- **Fairness SQL** (`20261018000000`, carried unchanged into `20261019000000:100`):
  - `row_number() over (partition by recipient_org order by since, id, notice)` is computed after the `unsent` filter and the has-a-recipient filter. The outer order is `org_rank, since, id, notice`, with limit 30. That is correct: rank 1 of every workspace comes before any rank 2.
  - Task reminders partition by `t.organisation_id`, which is correct for the same reason.
- **Can a hostile workspace get ANOTHER workspace's notice marked undeliverable?**
  - `mark_notices_undeliverable` is service_role only, refuses any session, and writes only for subjects in the email's own state.
  - The only foreign-controlled input to a notice is the counterparty's `display_name` in the `connection_*` copy. I fuzzed 300,000 random strings plus 25 targeted payloads through `oneLine` → the three connection templates → `render` → `assertOnlyLink`: **0 refusals**. Hostile text renders; it cannot force `content_refused`.
  - `no_recipient` depends only on the recipient workspace's own memberships, and the resolver already filters rows with no recipient.
- **30-workspace residual:** acceptable as stated. `reminder_at` is client-set, so 30 or more paid workspaces of one tenant with back-dated reminders could hold every slot of the batch for up to 7 days. But the rows are real, sendable mail and they drain at 30 per tick, so this is a throughput delay bought at 30 paid workspaces, not a permanent wedge. It is logged in FOLLOW-UPS.

### I3: one-link bypass. CLOSED [verified, node]

`neutraliseLinks` is: NFKC, then `\p{Cf}` dropped, then any `<scheme>://` (any case) and `www.` removed until the text stops changing. `assertOnlyLink` is case-insensitive, covers any scheme plus bare `www.`, and runs on the NFKC-folded **subject, text AND HTML** of every builder (connection ×3, task reminder, DSR, export, erasure). Payloads I tried, all neutralised or inert:

| Payload | Result |
|---|---|
| Nested mixed case: `HThttps://TPS://evil.example` | neutralised |
| Reassembly by removing `www.`: `https:www.//evil` | neutralised |
| Full-width `ｈｔｔｐｓ：／／`, `ｗｗｗ．` | neutralised |
| Zero-width, word-joiner and soft-hyphen splits | neutralised |
| `javascript://`, `data://`, `x://` | neutralised |
| `1https://` | neutralised |
| Newline-split `https:\n//e` | becomes `https: //e`, not a link |
| Percent-encoded `https%3A%2F%2F` | left as text, not autolinkable |
| Unicode lookalikes not folded by NFKC (`꞉` U+A789, `∕` U+2215) | left as text, not autolinkable |
| HTML entities (`https&#58;//`, `&#104;ttps://`) | escaped to `&amp;…` in the HTML part, so they render literally and are never decoded into a scheme |

User text is never placed in an `href`, so `javascript:` without `//` is inert text.

- **Bare-domain residual** (`evil.example/login`): acceptable. Some clients autolink it, but the in-app directory shows the same text, and stripping dots would mangle names. It is logged in FOLLOW-UPS.
- `mailto:`-style and bare email addresses have the same autolink residual. That is the same class, and not worth separate work.

### I4: retention census. CLOSED [verified]

`retention-matches-db.test.ts` now counts `public` + `private`, relkinds r/p/m, which is the roll's own scope. That is stricter, not weaker.

### Minors

- **m1 CLOSED [verified]:** `20261019000000` adds `private.organisation_network_presence_active(p.organisation_id)` to the counterparty join. That is the same predicate as the directory policy. The resolver is SECURITY DEFINER and owner-run, so the function's `authenticated`-only grant does not matter.
- **m2 CLOSED [verified]:**
  - **psql total:** summing the 24 `run_suite` pins in `run-rls-tests.sh` gives **4018**, which matches CLAUDE.md:104.
  - **Migrations:** 223 on disk.
  - **`SERVER_ONLY_RPCS`:** 21 entries (`phase7-permission-matrix.test.ts:1202`). That matches CLAUDE.md:460 and SECURITY.md:21.
- **m4 and m6 ACCEPTED soundly.** Both rationales hold: m4 is millisecond drift on a server-only column, and m6 because the service client is shared with the long-running runners. Both are in FOLLOW-UPS.
- **m5 CLOSED [verified]:** with several recipients the message goes `to: []` + `bcc`, and `sendEmail` then addresses `to = [from]`. A single recipient stays in To. One message, one stamp.

---

## New findings, ranked

### N1 (CRITICAL, pre-existing since Phase 6) [static]: a requester can rewrite its own pending request into an accepted connection from a non-consenting organisation

**Where:**
- `20260904003000:318-355`: two UPDATE policies.
  - `recipient_responds`: USING `to_org ∈ mine`; WITH CHECK `to_org ∈ mine ∧ to_org ∈ publish ∧ status ∈ (accepted, declined)`.
  - `sender_withdraws`: USING `from_org ∈ mine`; WITH CHECK `from_org ∈ mine ∧ status = withdrawn`.
- **No term pins `from_organisation_id`, `from_network_profile_id`, `to_organisation_id`, `to_network_profile_id`, `requested_by` or `requested_at` through an UPDATE.** The `20260904000000:509-521` header says this table "deliberately" has no `entity_org_unchanged` arm and relies on "the pair of narrow UPDATE policies plus the transition guard". But the guard reads only `status`, and permissive policies OR their USING and WITH CHECK clauses *independently*. That is exactly the effect the `sender_withdraws` comment itself describes.
- Grant: table-level `update` to `authenticated` (`:635`).
- I grepped `rls_phase6_network.sql` and `network_leakage_phase6.sql`. Neither has an assertion that UPDATEs an organisation or profile column.

**Failure scenario** (paid-tier T, Manager with `manage_network_connections`, target X):
1. T sends X an honest request. It is born `pending`, so C1's trigger is happy. The row T reads back carries `to_organisation_id = X` (filled by the trigger) and `to_network_profile_id`.
2. T PATCHes that same row with:
   - `from_organisation_id = X`, `from_network_profile_id = <X's profile>`;
   - `to_organisation_id = T`, `to_network_profile_id = <T's profile>`;
   - `status = 'accepted'`, `responded_at = now() - 8 days`.
3. The policy checks pass:
   - **USING** passes through `sender_withdraws`, because the OLD `from_org` is T.
   - **WITH CHECK** passes through `recipient_responds`, because the NEW `to_org` is T, T is paid, and the status is accepted.
4. The table constraints and guards pass:
   - `not_self`: X ≠ T, so it holds.
   - The iff-terminal CHECK holds because `responded_at` is set.
   - The transition guard allows `pending → accepted`.
   - The live-pair index on (X, T's profile) is free.
5. `network_connected_profiles` keys on `status = 'accepted'` and the org pair alone (`20260904004000:134-140`), so **T now reads X's `connections`-level fields**. X never accepted, and could even have declined an earlier request: Q79 allows a fresh row to replace the declined one.
6. **It is silent.**
   - X's "received" email is never owed: the row is no longer pending, and the 10-minute tick probably never saw it pending.
   - The "accepted" email would go to X's Owners and Admins, because `requested_by` is T's user and not a member of X. But the back-dated `responded_at` puts it outside the 7-day window. That is the m3 residual doing real work.

A variant needs no fresh row: an existing **accepted** T↔A row can be repointed at X, because the guard allows same-status updates and the recipient policy pins only `to_org`.

**Fix:**
- Add a BEFORE UPDATE trigger, for every role except `postgres`/`supabase_admin` as in `born_pending`, that:
  - refuses (23514) any change to the four organisation and profile columns and to `requested_by`, `requested_at` and `created_at`;
  - when status leaves `pending`, stamps `responded_at := now()` and `responded_by := auth.uid()`;
  - otherwise refuses a `responded_*` change. Keep PN5c's same-status `responded_at` edit in mind, as FOLLOW-UPS already notes.
- Bind the transition to its actor in the trigger: `accepted`/`declined` only if OLD `to_org` ∈ the caller's `manage_network_connections` orgs, and `withdrawn` only if OLD `from_org` is.
- Add psql assertions using a raw UPDATE (not an RPC):
  - the swap-to-accepted;
  - the repoint of an accepted row;
  - a back-dated `responded_at`;
  - each with the connected view at 0 rows, plus a positive control of an honest accept.
- Add an HTTP PATCH twin to C1's block.
- Optionally narrow the UPDATE grant to columns `(status)` (Q125's remedy), which makes the client unable to name the other columns at all.

### N2 (MINOR) [verified, node]: a task title ending in `www` is now silently dropped

- The template appends `.` after the title (`task-reminder-template.ts`: "…assigned to you: ${title}.").
- A title such as `Visit www` survives neutralisation, because there is no dot to strip. The render then contains `www.`, so `assertOnlyLink` throws.
- Since I2 that refusal is **terminal** (`undeliverable:content_refused`), so the reminder is never sent and never retried. The fuzz found 347 such strings in 300k.
- Impact is limited to the author's own workspace: the title is that workspace's own text. Connection copy never puts a `.` directly after the name, and showed 0 refusals.
- **Fix:** either strip a trailing `www` in `oneLine`, or neutralise the assembled paragraph rather than the bare field.

### N3 (MINOR, design note) [static]: any deterministic builder failure is now terminal, not stuck

- `deliverEach` records `content_refused` for any throw from `build()`, including `slugOrRefuse` on a malformed slug and any future code or config bug.
- Before this round such a row was retried until fixed. Now up to 30 rows a tick are permanently marked undeliverable and logged.
- That is the right trade for I2, but a bad deploy would lose notices rather than delay them. It is worth one line in FOLLOW-UPS, or restricting the terminal record to `NoticeContentError` thrown on person-authored fields.
