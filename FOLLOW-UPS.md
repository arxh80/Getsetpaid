# Follow-ups

Deferred work carried out of a completed phase, routed to the phase that should
absorb it. Each item was reviewed and deliberately deferred — this is not a
backlog of unexamined ideas, and nothing here is a known security hole.

Items are deleted from this file when done, not ticked. If an item is still
here two phases after its named phase shipped, that is the signal to either do
it or decide out loud that it is never happening.

## Gate: before the first `supabase db push`

- **`.env.local` POINTS `pnpm dev` AT THE HOSTED PROJECT, NOT THE LOCAL STACK.**
  Found in Phase 2 Task 3, by accident, in the worst possible way: the task's
  browser walkthrough began with a sign-up, and it created a real account on
  `xgearhhusrepzhcwhrzs.supabase.co`. `NEXT_PUBLIC_SUPABASE_URL` and both keys
  in `.env.local` are the hosted project's; `supabase start` does not change
  them, and nothing in the repo warns about it. Every "open it in a browser"
  instruction this phase has issued would have done the same thing.
  **Consequences to deal with, in order:**
  1. One `auth.users` row and its `profiles` row exist on the hosted project:
     `ada@getsetpaid.test`, "Ada Lister", created 2026-08-28. No organisation
     was created. It is left in place rather than deleted, because deleting an
     account on a live project is the founder's call, not an implementer's.
  2. **The hosted project is NOT empty**, which contradicts the entry below.
     The sign-up completed, the app rendered the profile's name (not the
     fallback email) and then rendered the onboarding form — which requires
     `public.profiles`, the new-user trigger from `20260827015924` and
     `public.organisations` to exist there. Stated as what was observed; the
     hosted database was not probed further, deliberately.
  3. Point local development at the local stack. `@next/env` does not override
     variables already in `process.env`, so exporting
     `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
     `SUPABASE_SERVICE_ROLE_KEY` from `supabase status` before `pnpm dev` works
     today and is what Task 3's walkthrough used. A committed
     `.env.development.local` fed from `supabase status`, or an npm script that
     does the export, would make it the default instead of a thing each person
     has to know.
- **Migration `20260826154304` was amended in place** during Foundation's fix
  rounds. ~~Harmless while nothing is deployed — the hosted project has had
  nothing applied.~~ **That premise is now in doubt — see the entry above.**
  Task 6 switched to additive migrations for exactly this reason, so the
  discipline is already established. Establish what the remote actually has
  applied before the first push, rather than assuming it is empty.
- **`SECURITY.md` §15** lists the configuration that does not ship itself
  (`jwt_expiry`, session timebox/inactivity, TOTP enrolment, the
  `platform_admins` grant). Work through it as part of provisioning, not after.

## Phase 2 — Core CRM

These become live the moment a real tenant table exists.

- ~~**Wrap constant-argument policy calls in `(select …)`**~~ **DONE, Phase 2
  Task 2** (`20260828122000_policy_initplan_retrofit.sql`). Four Foundation
  policies qualified — all four call `private.has_platform_permission` with a
  literal; every other policy in `public` takes a column argument and cannot be
  hoisted. Measured on 200k committed `audit_events` rows: **6785.848 ms →
  6.360 ms**, 200,263 buffer hits → 161. It was worth checking rather than
  assuming — Postgres does *not* hoist a variable-free `STABLE` function call in
  a qual on its own. Two corrections for anyone reading the original entry:
  `create or replace policy` **does not exist** in Postgres (42601); the
  additive statement is `alter policy`. And "performance only" was wrong at the
  scale Phase 2's own policies operate at — see the next entry.
- **Any new RLS policy must use the set form, not the per-row form.** Phase 2
  Task 2 measured this on the policies it was shipping, and it is a design rule
  now rather than a tuning note. `has_permission(organisation_id, 'view_crm')`
  takes a **column**, so it runs once per row and nothing hoists it: a fifty-row
  page of a 50,000-contact organisation took **5210 ms**, and the equivalent
  child-table page **12830 ms**. `organisation_id in (select
  private.permitted_organisations('view_crm'))` takes a **constant**, so the
  planner builds one hashed SubPlan per statement: the same two queries take
  **23 ms** and **19.6 ms**. Pagination does not rescue the per-row form —
  `order by … limit 50` sorts the whole tenant before it can take fifty, so the
  policy is evaluated on every row either way; only a primary-key fetch escapes
  (0.78 ms in both). Both forms return identical rows, so **no behavioural test
  can tell them apart** — `rls_phase2_crm.sql` H12/H13 are shape guards that
  exist for exactly that reason. Phase 3 and beyond: write
  `<org column> in (select private.permitted_organisations('<key>'))`, and for
  a child table an inline `exists` against its one parent (which the planner can
  hoist; a `SECURITY DEFINER` helper cannot be inlined and is structurally
  per-row). `20260828120500`'s header carries the plans.
- **Task 4 must clear the old `is_primary` before setting a new one.** Not a
  question any more — `contact_companies_one_primary_per_contact` and
  `artist_representations_one_current_primary_per_artist` ship in
  `20260828001134` (DECISIONS-QUEUE Q4 delegated the call to Task 1, and Task 1
  recommended adding them). A partial unique index cannot be deferred, so
  "make company B the primary" is two statements in one transaction, not one
  `UPDATE`. This is the cost that was paid for it, recorded where the write
  path will be built.
- **`artist_representations_one_current_primary_per_artist` enforces one
  *open-ended* primary, not one *current* one.** A representation with a
  future-dated `ended_at` is excluded from the index and so slips past it. The
  index cannot say otherwise — `current_date` is not `IMMUTABLE`, so it cannot
  appear in a partial index predicate. Either the write path rejects
  future-dated `ended_at`, or the name is wrong. Task 4 owns the call.
- **Task 6's merge must resolve `is_primary` collisions before repointing.**
  The same two indexes break the merge, not just the edit form, and that was
  recorded against Task 4 only. If the winner and the loser each have a
  primary — both legal rows — then
  `update contact_companies set contact_id = <winner> where contact_id = <loser>`
  raises `23505`, and the same applies to `artist_representations`. Neither
  index is deferrable, so the merge must demote one side's primary in a
  separate statement first and record which side won in
  `merges.field_resolution`. The pre-existing
  `contact_companies_contact_company_unique` collides the same way when both
  records link to the same company: that row is a duplicate and must be
  dropped, not repointed.
- **`updated_at` is maintained by almost nothing, on the 17 tables in `public`
  that carry it.** `audit_events`, `merges`, `platform_admins` and
  `role_permissions` do not have the column — the first two deliberately, being
  append-only — so the decision below covers 17 tables, not 21, and applying it
  literally to all of them would add the column where it was deliberately
  omitted. `pg_trigger` has no non-internal trigger anywhere in `public`, and
  the only write to the column in the entire codebase is `accept_invite()`'s
  `update public.organisation_memberships … set updated_at = pg_catalog.now()`
  (`20260827015924:272`) — one table, one of that table's write paths. That is
  worse than uniformly unmaintained: a consumer could reasonably conclude the
  column works. Everywhere else it equals `created_at` forever, Foundation's
  included, so this is not a Phase 2 regression.
  Task 1's fix round deliberately did **not** add triggers to only the twelve
  new tables: that would leave the schema half-maintained, which is worse for a
  reader than either extreme. **Task 2 should take one decision for all 17.**
  The argument for a trigger is the same one `SECURITY.md` §4 makes about the
  database being the only chokepoint — a PostgREST `PATCH` goes nowhere near
  app code, so an app-maintained `updated_at` is not maintained. The argument
  against is that Foundation chose app-maintained deliberately and no consumer
  needs the column yet.
  **DECIDED, Phase 2 Task 2: a shared `BEFORE UPDATE` trigger on all 17**
  (`20260828121500_updated_at_triggers.sql`, `private.set_updated_at()`). The
  PostgREST argument won, and a second one turned up while implementing it that
  is a security argument rather than a tidiness one: `updated_at` was
  **client-writable**. Every one of those tables grants UPDATE to
  `authenticated`, no policy constrains which columns an UPDATE may touch, and
  PostgREST will send whatever is in the body — so a client could back-date or
  future-date a record's modification time, which matters the moment anything
  reads the column for "what changed since my last sync", to order an activity
  feed, or to answer a retention question. The trigger overwrites whatever
  arrived. Asserted by `rls_phase2_crm.sql` L3/L4 (a timestamp forged ten years
  out is discarded) and L5/L6 (every table carrying the column has the trigger,
  and that is 17). The `when (old.* is distinct from new.*)` clause means a
  no-op UPDATE does not move the timestamp. The four tables without the column
  (`audit_events`, `merges`, `platform_admins`, `role_permissions`) were left
  alone. **Phase 3+: a new table with `updated_at` needs the trigger added by
  hand** — the event-trigger option stays rejected for Task 1's I6 reason, and
  L5 is the assertion that catches the omission.
- **`invited_at` / `created_at` are still rewritable** through the
  `manage_members` UPDATE policy. Same shape as the `joined_at` hole that was
  closed, no authorisation impact. Close it when a members-management task next
  touches that policy.
- **`audit_events.actor_user_id` has no `ON DELETE` clause.** Correct as it
  stands: GDPR erasure must anonymise rather than hard-delete, and that
  workflow is Phase 7+. Revisit with the erasure workflow, not before.
  **`merges.merged_by` (Phase 2 Task 1) now has the same shape, for the same
  reason** — a merge is destructive and its attribution must outlive the
  actor's account. Both are one decision, not two: whatever the erasure
  workflow does about `audit_events` it must do about `merges` in the same
  change. Verified against the live database: deleting an `auth.users` row
  referenced by a merge raises `merges_merged_by_fkey`.
- **The members page's `unavailable` state also hides the "Invited (n)"
  section**, and the inner `profiles` lookup still discards its error.
- **URL protocol validation has no owner — route it to Task 4.** CLAUDE.md
  § Non-negotiable rules and `SECURITY.md` §3 both require `javascript:` and
  `data:` to be rejected. `companies`, `contacts`, `artists` and `venues` all
  carry a free-text `website`, and `contacts`/`artists`/`venues` carry
  `socials jsonb` whose only constraint is that it is an object — the values
  inside it are entirely unconstrained, and no CHECK can reach into them.
  **Task 4 owns this on the write path, and on render.** A schema-level
  `check (website is null or website ~* '^https?://')` is available as cheap
  defence in depth on the four `website` columns; it was not added, because it
  would give the impression the problem is handled while `socials` — the larger
  surface — stays wide open.
- **Orphaned `custom_field_values` — Tasks 4 and 6, plus the DSR checklist.**
  Proven: delete a contact and its custom field values survive with the payload
  intact, because `entity_id` is polymorphic and cannot cascade. Nothing will
  ever find them again — `entity_id` no longer resolves and the table has no
  `deleted_at`. The `value` column holds user-entered CRM content, so this is a
  retention and erasure problem, not just tidiness. Every entity delete (Task 4)
  and every merge (Task 6) must
  `delete from public.custom_field_values where entity_type = $1 and entity_id = $2`
  — `custom_field_values_entity_idx` already makes that an index lookup — and
  the same sweep belongs on the GDPR erasure checklist (CLAUDE.md § Legal,
  30-day DSR).
- **A subscription downgrade must never delete a custom field definition.**
  `custom_field_values_definition_fkey` is `ON DELETE CASCADE`, which is right
  for referential integrity and dangerous for the tier path: CLAUDE.md
  § Permissions says "Downgrading a subscription makes features read-only or
  limited; it must never silently delete data." Deleting one definition to get
  back under a lower tier's limit destroys every value filed under it. Task 5
  must make definitions over the limit read-only/inactive instead, and should
  consider `deleted_at` on `custom_field_definitions` so "deactivate" is
  expressible at all.
- **Task 6's dedup helpers must schema-qualify the trigram operators.**
  `pg_trgm` is installed in `extensions`, so `%` resolves as `extensions.%`.
  PostgREST supplies that search_path, so ordinary API queries work — but
  `SECURITY.md` §2 requires `SECURITY DEFINER` functions to have `search_path`
  locked, and the standard hardening (`set search_path = ''`, which every
  Foundation helper uses) makes `name % $1` fail with "operator does not exist".
  Write `name operator(extensions.%) $1` and `extensions.similarity(...)`.

### Opened by Task 3 (the shared list surface) — carried into Task 4

- **EVERY list Task 4 ships needs its own pair of indexes, and the rule is
  checkable rather than rememberable.** Task 3 measured the contacts list on
  25,000 rows and found the shipped schema had no index any list query could
  use for ordering: page one was a Seq Scan plus a top-N sort of every live row
  in the tenant, 13.575 ms and 866 buffers, against 1.015 ms and 314 with an
  index. Thirteen milliseconds is not a bug; the SHAPE is — it grows linearly
  with how successful the customer is, and it is invisible to every test that
  checks which rows come back, because both plans return the same rows.
  `20260828180000_contact_list_indexes.sql` fixes it for `contacts` only.
  Companies, artists, agencies and venues each need:

  ```sql
  create index <table>_org_<column>_id_live_idx
    on public.<table> (organisation_id, <sort column>, id)
    include (owner_user_id)
    where deleted_at is null;
  ```

  one per allowlisted sort column. The rule, stated so it can be enforced:
  **a column may be in a list's sort allowlist only if it is `NOT NULL` and has
  a matching index of that shape.** `NOT NULL` because keyset pagination
  compares against the column and every comparison with NULL is NULL, so a
  nullable sort column silently drops a contiguous band of rows out of the
  middle of the list — `contacts.email` is the tempting mistake and is
  deliberately not sortable. `include (owner_user_id)` because the RLS
  record-scope term reads that column, and without it a Standard User's page
  costs a heap fetch per candidate row (3.170 ms vs 1.545 ms, `Heap Fetches: 0`
  with it). ASCENDING ONLY — a btree scans backwards and `organisation_id` is
  pinned by equality, so one index serves both directions (verified:
  `Index Scan Backward`, 0.451 ms).
  `lib/list/spec.ts` makes both halves of the rule a REQUIRED field on every
  sort option (`notNull` and `backedBy`, the index's name), so adding a sort
  without an index is something an author has to write down rather than omit.

- ~~**`contacts_name_trgm_idx` is never used by the list.**~~ **TRUE, BUT THE
  REASON AND THE CONSEQUENCE WERE BOTH WRONG. Corrected in fix round 1, and the
  correction is the important item in this section.** The original entry said
  search was served by the new composite btree "at 1.079 ms instead" and kept
  the trigram index "for Task 6's dedup lookup, which has no `ORDER BY`".
  Neither survived re-measurement.

  **SEARCH IS O(TENANT) AND NO INDEX CAN CHANGE THAT FROM THE POSTGREST PATH.**
  1.079 ms was measured on a term matching ~4% of the tenant, dense enough that
  walking the ordered index and stopping at 26 wins. A user types a surname.
  On 19,882 live rows, as the real `authenticated` role, a term matching ONE
  row:

  | | plan | time |
  |---|---|---|
  | the page | Index Scan on `contacts_organisation_id_idx`, 20,000 rows filtered | **39.0 ms** |
  | its count | the same shape | **35.9 ms** |

  So a realistic search costs two scans of the tenant — ~75 ms of database time
  at 20k rows, growing linearly with the customer's success. The list's
  headline property, O(page) paging, does not extend to the search path.

  **THE MECHANISM, now established rather than declined.** The original entry
  refused to name one (rightly, at the time) and the review's correction named
  a different one ("the blocker is the query shape, not RLS"). Both were
  partial. It is the operator:

  ```
  select p.proname, p.proleakproof from pg_operator o
    join pg_proc p on p.oid = o.oprcode where o.oprname in ('~~*','%','>=');
      texticlike     f      -- ILIKE
      similarity_op  f      -- pg_trgm's `%`
      text_ge        t      -- `>=`
  ```

  Postgres will not evaluate a **non-leakproof** qual before an RLS security
  qual, so a non-leakproof operator can never become an Index Cond on a table
  with RLS on. The controlled pair — same index, same fixture, same session,
  differing only in leakproofness:

  ```
  name >= 'Wilhelmina'      Index Cond: (organisation_id = ... AND name >= ...)
                            1.425 ms, Heap Fetches: 0
  name like 'Wilhelmina%'   Index Cond: (organisation_id = ...) only,
                            20,000 Rows Removed by Filter, 6.853 ms
  ```

  That predicts every observation, including the one the review asked for: a
  composite `gin (organisation_id, name gin_trgm_ops) where deleted_at is null`
  **was created, ANALYZEd and measured, and is also never chosen** — the same
  selective search stayed at 24.313 ms. It was dropped again. Adding an index
  cannot help, because the absence of an index is not the blocker.

  **THE CEILING, as a number, the way the count's already is:** a search costs
  two sequential scans of the tenant. ~75 ms at 20k rows; ~750 ms at 200k, per
  search, per user. Revisit at the first tenant approaching six figures.

  **WHAT A REAL FIX LOOKS LIKE — scoped here, deliberately not built in Task 3.**
  A `SECURITY DEFINER` search function that applies the tenant scope and the
  soft-delete filter itself. SECURITY DEFINER does not apply RLS to the table
  it reads, which is the one context where a non-leakproof operator CAN reach
  an index. It needs: `search_path` locked to `''`, the trigram operator
  schema-qualified (`name operator(extensions.%) $1`), the organisation
  membership checked INSIDE the function rather than trusted from the
  argument — it is bypassing the policy, so it must re-establish what the
  policy would have enforced — and its own tests in `rls_phase2_crm.sql`
  proving it cannot be called for an organisation the caller is not in. That
  is a task, not a patch.

- **DECIDED, fix round 1: KEEP all four trigram indexes, for a different reason
  than the one originally given.** The original justification ("Task 6's dedup
  has no `ORDER BY`") was measured by the review and is false — that shape is a
  Seq Scan too. The justification that holds is the one above: FOLLOW-UPS
  already specifies Task 6's dedup helper as a `SECURITY DEFINER` function, and
  in that context the index is not merely usable but decisive. Measured with
  exactly that function shape:

  ```
  private.dedup_probe(org, name), trigram index present   0.36-0.53 ms
  the same function, index dropped                       48.1-50.9 ms
                                                         Seq Scan, 25,000 filtered
  ```

  **Write cost, measured, because "keep it" needs both sides.** 2,000 inserts
  plus a bulk update of 2,000 rows, alternated with and without all four
  indexes so a warm cache favours neither: inserts 144.7/147.1/102.7/147.1 ms
  with against 77.0/82.9 ms without (~**+0.033 ms per row**), updates 78-99 ms
  against 57-61 ms, and 5.7 MB per 25,000 contacts. A 10,000-row bulk import
  pays about a third of a second.

  **Drop them if Task 6 ships dedup WITHOUT a SECURITY DEFINER path** — at that
  point they have no reachable consumer at all. `20260828190000` carries this
  on the indexes themselves via `comment on index`, so it travels with the
  database.

- **The exact count above the table is O(tenant), and that is the one part of
  the list that is.** `count=exact` needs every row and the RLS predicate's
  `owner_user_id` term keeps it off an index-only path, so it plans as a Seq
  Scan: 7.703 ms in psql on 24,509 rows, 34.1 ms end to end over PostgREST —
  more than the page query itself (18.7 ms). It runs in parallel with the page
  and fails independently, so the page still renders without a total. Revisit
  if a tenant reaches a few hundred thousand records: the answer then is an
  estimate or a maintained counter, not a cleverer query.

- **Task 4: rows do not link anywhere yet, deliberately.** `CONTACT_COLUMNS`
  renders the name as plain text because contact detail pages do not exist; a
  name styled as a link that navigates nowhere is the dead-affordance class the
  Foundation review caught three times. Task 4 wraps it in a `<Link>` and
  nothing else on the page changes. **Add the row hover state at the same
  time** — DESIGN.md § Interaction states specifies `--surface` → `#FBF6F6` for
  a hovered row, and it is deliberately absent while rows are not interactive,
  because a hover highlight on an inert row promises a click that does nothing.
  That colour is not yet a token; add it to `@theme`, to DESIGN.md's palette
  table and to `scripts/contrast.py` in the same change, per DESIGN.md's own
  rule about adding a colour.

- **Task 4: the empty state has no primary action, and should get one.**
  `hallmark`'s empty-state rule is three beats — what is empty, why it matters,
  one button — and the contacts empty state ships the first two plus an honest
  "Adding contacts arrives with the next release" instead of a button to a
  route that does not exist. When the create form lands, that line becomes the
  button.

- **DESIGN.md's "Disabled: --ink-muted text at 55%" needs a caveat, and the
  pager is the reason.** Review M-4 measured the disabled pager control at
  **2.54:1** — `--ink-muted` at 55% over `--surface` computes to `#A2A2A7`.
  WCAG 1.4.3 exempts "inactive user interface components", and that exemption
  covers every other disabled control in the product. It does NOT cover this
  one: `list-pager.tsx` deliberately keeps an unavailable direction a focusable
  `<a href>` in the tab order, so that focus is not lost when Next becomes
  unavailable under a keyboard user's hands. A control that is focusable,
  reachable and activatable is an active control that happens to look disabled.
  The opacity is dropped for that case (now **7.37:1**, verified in the running
  page, with `aria-disabled` and `cursor-not-allowed` still carrying the state).
  **DESIGN.md should say that the 55% rule applies only to genuinely inert
  controls**, and name this as the exception — Task 4 ships five more pagers.

- **`pnpm build` and `pnpm start` still resolve to the hosted project.** The
  `pnpm dev` guard (`scripts/dev-env.mjs`) works and was verified with the
  stack down. It covers one of the three commands that run this application:
  `@next/env`'s own loader returns the local URL for `dev=true` and the hosted
  URL for `dev=false`, so `next build` collects page data and `next start`
  serves the whole app against production. Checking a change against a
  production build is the obvious next thing anyone does after `pnpm dev`, and
  the task brief lists `pnpm build` as a gate. Not fixed in Task 3's fix round
  because the script is not Task 3's — the shape the review proposes is a
  `--check-local-only` flag on the same script, wired to `prebuild` and
  `start`, refusing anything but loopback unless an explicit
  `GETSETPAID_ALLOW_HOSTED=1` is set (so Vercel, where `.env.local` is absent,
  is unaffected). `tests/integration/rls/support/env.ts` already contains the
  loopback assertion to reuse.

- **A soft-deleted organisation still appears in the workspace switcher.** Not
  Task 3's code; found by the reviewer while building fixtures.
  `getActiveMemberships()` filters on membership `status` but not on
  `organisations.deleted_at`, while `getCurrentOrg()` filters it correctly — so
  a suspended workspace is listed in the header switcher and 404s when
  selected. A dead entry rather than an access problem (the database denies
  either way). This is the same disagreement `20260828140000`'s
  suspension note already depends on being resolved; it belongs to whichever
  task next owns the switcher.

- **Task 4: the list surface has no write affordances at all**, so "a Read Only
  user sees no write affordances" and "a Free-tier org gets no write path" are
  currently true by construction rather than by a gate. The moment Task 4 adds
  a "New contact" button, both need real checks — `hasPermission(org.id,
  'manage_contacts')` for the role half and `lib/entitlements/policy.ts` for the
  tier half — and CLAUDE.md's "hiding UI is not enforcement" means the write
  itself must still be refused by the policy when the button is hidden.

### Opened by Task 2 (RLS policies) — carried into Tasks 3-7

- **RLS does NOT filter soft-deleted rows. Every query in Tasks 3-7 must write
  `deleted_at is null` itself.** Decided in `20260828121000` design note (g) and
  stated here because it is the kind of thing a screen forgets silently: nothing
  will error, a deleted contact will simply appear in the list. Hiding them in
  the policy was rejected because a `USING` clause that excludes deleted rows
  excludes exactly the row an undelete is trying to restore, so restore would
  need its own `SECURITY DEFINER` bypass; because Task 6's merge has to read the
  loser it just soft-deleted; and because DSR export must reach soft-deleted
  rows, which are still personal data. The partial trigram and
  `contacts_org_email_lower_idx` indexes are only usable when the predicate is
  present anyway (Task 1 §4.4 measured the Seq Scan you get without it), so the
  same clause serves both purposes. `rls_phase2_crm.sql` § K asserts the
  visibility; nothing can assert the application's half.
- **`custom_field_definitions` has no DELETE policy and no DELETE grant —
  Task 5 owns fixing that properly.** A definition cannot be removed through the
  API today, only renamed. Deliberate:
  `custom_field_values_definition_fkey` is `ON DELETE CASCADE`, so deleting one
  definition destroys every value filed under it across the whole organisation,
  and CLAUDE.md § Permissions forbids silently deleting data. Task 5 should add
  `deleted_at` to the table (which it already needs for the tier-downgrade item
  above) and give "remove this field" the soft-delete shape; only then does a
  DELETE policy make sense, if at all. **The cost is real and is accepted for
  now: a mistyped field key is permanent until Task 5 lands.**
- **Task 4 and Task 6's orphan sweep must delete `custom_field_values` BEFORE
  the entity row is hard-deleted.** The DELETE policy resolves `entity_id`
  against the live entity row, so once the entity is gone the values are
  unreachable to every client role. Soft delete leaves the row in place, so the
  ordinary path is unaffected — this only bites on a genuine hard delete
  (Phase 7's organisation deletion, a DSR erasure). Stated beside the existing
  orphan-sweep item because that item names the statement and this names its
  ordering constraint.
- ~~**`contact_companies` has a company-existence oracle, accepted.**~~
  **THAT ASSESSMENT WAS WRONG, in the reassuring direction. Corrected in fix
  round 1.** It said the residue "requires guessing a v4 uuid inside one's own
  organisation and reveals nothing but existence". Nothing has to be guessed:
  the SELECT policy hands the identifiers over. A record-scoped user reads the
  `company_id` of every link on a contact they own — including companies outside
  their scope — and `artist_representations` is the same shape and wider,
  exposing `agency_id` **and** `contact_id` of rows the user cannot read, plus
  the free-text `role` and `territory` on the representation itself. Q3a's
  "a display wart, not a disclosure" is wrong too: it is an identifier
  disclosure.
  **Bounded, and the bound is the reason it is still accepted:** no attributes
  leak. A PostgREST embed of `companies(*)` renders `null` and
  `companies!inner(*)` renders `[]`, so this is IDOR-adjacent enumeration, not a
  content leak. **The write half is real and is Task 4's:** a Standard User can
  create and delete links to companies they cannot see, and those links surface
  on the company's page for full-scope users. Close it in the create-link form
  (offer only companies the caller can read), NOT in a policy — a policy that
  refused it would reintroduce the `AND` that Q5 rejected and break the case Q5
  exists to protect. Corrected on the policies themselves via `comment on
  policy` (`20260828140500`) and in `SECURITY.md` § 10.
- **A soft-deleted record is still fully editable — Tasks 3-7 must remember
  `deleted_at is null` on WRITES as well as reads.** Design note (h) is about
  visibility only; nothing stops an UPDATE of a soft-deleted row. So a record
  can be soft-deleted, edited, and restored with only `updated_at` moving, which
  is a wart for the retention and DSR story. Not fixed in a policy because the
  UPDATE `USING` clause is exactly what a restore needs to match — the same
  argument that decided design note (h). Task 4 owns it on the write path.
- **A denied write can return `204 No Content`.** Where the `USING` clause
  filters the target out first, PostgREST returns 204 rather than 403 — measured
  on a `read_only` PATCH, a `read_only` DELETE and a cross-tenant PATCH. Nothing
  changes, so it is secure, but Foundation's design note (c) calls a
  silently-zero-row write "worse than one that just fails" and every screen from
  Task 3 on will hit it. **Every mutation must send `Prefer:
  return=representation` (or `count=exact`) and treat a zero-row result as a
  denial, not a success.** The two CRM `DELETE` policies are the worst case: a
  DELETE policy has no `WITH CHECK`, so the entitlement term has to live in
  `USING` and an unentitled delete is necessarily a silent zero-row result.
- **`custom_field_definitions.field_type` is mutable while values exist —
  Task 5.** An Owner/Admin can flip a definition from `text` to `number` with
  `text` values already filed under it. The `entity_type` equivalent is refused
  by the composite FK (`23503`); `field_type` is the axis left open. Not a
  security issue. Either forbid narrowing conversions server-side or add a
  `WITH CHECK` pinning `field_type` once values exist. Task 5 already carries
  the `deleted_at` item for this table; this belongs beside it.
- ~~**Task 3: no CRM query may appear above `MfaEnrollGate`.**~~ **DONE, Phase 2
  Task 3** (`tests/unit/list/app-shell-has-no-crm-query.test.ts`). It walks the
  real import graph from `app/(app)/layout.tsx`, both MFA gate components,
  `lib/auth/mfa-gate.ts` and `lib/auth/index.ts`, and fails if any reachable
  module queries one of the twelve CRM tables.
  **One correction for anyone extending it:** the obvious detector — grep for
  `.from("contacts")` — DOES NOT WORK any more and its positive control proved
  it on the first run. `lib/list/query.ts` takes the table name as a parameter,
  so the literal lives at the call site as `table: "contacts"` and the query
  itself is `supabase.from(table)`. The guard therefore also fails on
  `table: "<crm table>"` and on importing `lib/list/query` at all, which is the
  form that will survive Task 4 routing four more entities through the same
  helper.
- **Task 6: a record-scoped `merges` list is ~2.3 s per page at 20k rows, and no
  policy can fix it.** `merges_select_via_winner` is the one CRM SELECT policy
  whose predicate calls a function with COLUMN arguments, so the polymorphic
  dispatch cannot be hoisted. Fix round 3 (`20260828160000`, New-2) put the
  hoistable `full_scope_organisations()` term in front, which takes the
  **full-scope** case from 12308 ms to 6.083 ms on a 50-row page over 20k rows —
  but a record-scoped reader still pays two `entity_is_visible()` calls per row,
  measured at 2266 ms. That is a data-model problem, not a predicate problem:
  the merge list for a Standard User needs something indexable, most plausibly a
  denormalised `winner_owner_user_id` written by Task 6's own merge and a policy
  term of `winner_owner_user_id = (select auth.uid())`. Design it with the merge,
  not after it. `rls_phase2_crm.sql` H15 guards the ordering that bought the
  full-scope half.
- **Task 3/4: nothing renders the suspended workspace the suspension fix
  assumes.** `20260828140000` justifies leaving `private.is_active_member()`
  untouched so "the app has to be able to render 'this workspace is suspended'
  rather than a blank screen". That affordance does not exist, and the two
  helpers currently disagree: `getCurrentOrg()` (`lib/auth/index.ts:184`) already
  filters `.is("deleted_at", null)`, so a suspended slug resolves to `null` and
  renders as not-found — indistinguishable from another tenant's slug — while
  `getActiveMemberships()` filters on `status` only, so the workspace switcher
  still **lists** the suspended workspace, which then 404s when clicked. Either
  drop suspended organisations from the switcher, or let `getCurrentOrg()` return
  them with an `isSuspended` flag and render the notice. Not a security issue —
  the database denies either way — but the migration's stated justification is
  aspirational until this exists, and Q6's default is what makes it visible.
- **Task 6: `merges` SELECT now requires BOTH sides visible, not just the
  winner.** Changed in fix round 1 (`20260828140500`) because
  `field_resolution` copies both records' values verbatim and a record-scoped
  user was reading the DISCARDED email and phone of a record that was never in
  their scope. A merge screen can therefore only show merges where the viewer
  can see both records. The corollary: if a loser is ever HARD-deleted its merge
  record becomes invisible to everyone, so a merge whose record is gone must be
  read through the audit trail rather than through this policy.

## Phase 3 — events

Both carried out of Phase 2 Task 1, and both are one-line additions to the
migration that creates `public.events`. Neither is optional: until they happen,
Phase 2 ships a column and three allowlists that Phase 3 silently invalidates.

- **`artist_fee_history.event_id` needs a TENANT-SCOPED foreign key, and is
  held NULL until it gets one.** It could not have one in Phase 2 —
  `public.events` does not exist yet — so `20260828001134` added
  `check (event_id is null)` rather than leaving an unvalidated uuid lying
  around. The reason that matters: `ADD CONSTRAINT ... FOREIGN KEY` validates
  existing rows, so a single bad `event_id` written by Task 4 or 6 in the
  meantime turns the Phase 3 migration into a failed deploy against the live
  hosted project.

  Phase 3 must, in one migration:
  1. give `public.events` a `unique (id, organisation_id)` constraint;
  2. `drop constraint artist_fee_history_event_id_unwritable_until_phase_3`;
  3. add
     ```sql
     foreign key (event_id, organisation_id)
       references public.events (id, organisation_id) on delete set null (event_id)
     ```

  **The composite form is not optional and the `(event_id)` column list is not
  optional.** An earlier revision of this file and of
  `20260827232510_core_crm_entities.sql` both prescribed the single-column
  `foreign key (event_id) references public.events (id)`, which re-creates the
  cross-tenant write that `20260828001132` exists to close. And a bare
  `on delete set null` on a composite key nulls **every** referencing column
  including `organisation_id`, which is `NOT NULL` — measured, it makes
  deleting any referenced event fail outright. Both traps are written onto the
  CHECK constraint's own comment in the database, which Phase 3 has to read in
  order to drop it.
- **`'event'` is missing from three `entity_type` allowlists AND from two
  policy helpers — that is five places, not three.** The three CHECK
  constraints on `custom_field_definitions`, `custom_field_values` and `merges`
  each constrain it to the five Phase 2 entities. Custom fields on events (PRD
  §6.5 lists them explicitly) and event dedup do not work until all three are
  widened in the same migration.

  **The two that Task 2 added, and that the original entry could not know
  about:** `private.entity_is_visible()` and `private.entity_is_manageable()`
  (`20260828120500`) are `CASE` dispatches over the same five values with
  `else false`. Widening the CHECKs without adding an `'event'` branch to both
  makes every event custom-field value and every event merge record silently
  unreadable and unwritable — it will present as an RLS bug, and the tempting
  fix (loosening the policy) would reopen the cross-tenant hole the dispatch
  exists to close. Add the branch in the same migration, using `view_crm` for
  the visible half and whichever key Phase 3 defines for event writes.
  `SECURITY.md` § 10 carries the same warning where a pentester will see it.

## Phase 3 — members management with a real UI

- **Inviting an address that already has an account sends no email**, while the
  UI still confirms "we've sent them an invitation". A genuine correctness bug
  and the most user-visible item carried out of Foundation. It needs an
  app-level notification email — real work, not a one-liner. Ticket it
  properly rather than folding it into something else.
- **`switchWorkspaceAction` silently falls back to the first active
  organisation** when the submitted one is no longer accessible (stale tab,
  mid-session revocation). Correct security behaviour — it degrades uniformly
  rather than confirming which organisations exist — but it deserves a toast.
- **`RecordCurrentOrg` costs a database round trip per in-app navigation**, not
  only on cross-organisation switches. Intentional, per the sliding-expiry
  design. Revisit only if navigation volume becomes a cost.

## Phase 7 — superuser dashboard

This is where the privileged surface actually lands, so these must be fixed
before the first real consumer exists rather than alongside it.

- **Switch the subscription entitlement gate on: remove the escape and backfill,
  in ONE migration.** `private.crm_write_organisations()` (`20260828140000`) is
  on all 25 CRM write policies and is **deliberately inert**: its
  `s.organisation_id is null` branch means an organisation with no subscription
  row is not gated, and `create_organisation()` writes no such row, so today it
  gates nothing. Without that branch it would deny every CRM write in the
  product on the day it shipped. Phase 7 must (1) backfill an
  `organisation_subscriptions` row for every existing organisation, (2) make
  `create_organisation()` write one, and (3) delete the branch — in the same
  migration, in that order. Do it in the wrong order and every tenant loses
  write access to their own CRM. `rls_phase2_crm.sql` § N and the HTTP
  "Subscription entitlement" block are what prove the machinery works while it
  is switched off; N1 and N16 are the two assertions that must change when the
  escape goes.
- **Replace the `past_due` grace proxy with a real column, in BOTH halves.**
  The founder's 3-day grace window (`lib/entitlements/policy.ts`, 2026-08-28) is
  now enforced in the database too — `private.past_due_grace_days()` and
  `private.crm_write_organisations()`, `20260828150000`. Both halves measure the
  window from `current_period_end`, which `policy.ts` states plainly is a
  **proxy**: the honest clock starts when the subscription actually entered
  `past_due`, and no column records that. In the ordinary case they coincide (a
  renewal is attempted at period end and fails), and where they diverge the
  proxy is conservative in the customer's favour. When the payment processor is
  wired, add `past_due_since` (or `grace_expires_at`) and measure from it — in
  the SQL function **and** in `policy.ts`, in the same change.
  `tests/integration/entitlements/past-due-grace-matches-db.test.ts` is what
  fails if only one of them moves.
- **Ship the superuser REINSTATE path in the same change as the suspend
  button.** Since `20260828140000`, a soft-deleted organisation grants no
  permission at all — which means its own Owner can no longer clear
  `deleted_at`, and there is no superuser write policy on `public.organisations`
  either. Today, reinstatement is a DBA action. That is the fail-closed
  direction and it matches CLAUDE.md (suspend/reinstate is a superuser
  function), but shipping suspend without reinstate is a one-way door.
  `rls_phase2_crm.sql` P7 asserts the Owner cannot un-suspend, so it will need
  updating when the superuser path exists.
- ~~**The organisation-delete cascade will emit one audit row per child row.**~~
  **THAT DESCRIPTION WAS WRONG, and wrong in the reassuring direction — the
  statement did not emit thousands of rows, it ABORTED.** Corrected and fixed in
  fix round 3 (`20260828160000`, New-1). With a session set, `DELETE FROM
  organisations` failed with `23503 audit_events_organisation_id_fkey`: the
  cascade removes the organisation first, and each child's `AFTER DELETE` trigger
  then inserted an `audit_events` row naming a parent that was already gone.
  (`ON DELETE SET NULL` on `audit_events.organisation_id` is resolved against the
  rows that existed when the DELETE began; rows inserted *during* the cascade get
  no such treatment.) The suite missed it because R10/R11 delete sessionlessly,
  which is the branch the null-actor guard had already made safe.
  `private.audit_crm_row()` now resolves the organisation through a live lookup,
  so a vanished parent degrades to `NULL` rather than aborting. R12/R13 assert it
  **with `request.jwt.claims` set**, and go red as `denied(23503)` when reverted.
  **What genuinely remains for Phase 7** is the volume half: one audit row per
  cascaded child row, each with its own `correlation_id` because
  `private.log_audit_event()` mints a fresh one per call. Either thread one
  correlation id through the deletion path or suppress row-level audit inside the
  bulk operation and write a single summary row. This matters beyond tidiness —
  it is the path superuser organisation deletion and GDPR erasure both take, and
  erasure carries a 30-day statutory clock.
- **DSR erasure must scrub `merges.field_resolution`, not just the entity row.**
  Since fix round 3 (`20260828160000`, New-2) a full-scope role can read a merge
  whose subject has been hard-deleted, and `field_resolution` holds the
  discarded record's values verbatim — email, phone, whatever the merge touched.
  Erasing a contact therefore has to delete or redact every `merges` row naming
  it as winner or loser, or the erased person's data stays readable by the
  organisation's whole full-scope roster. Before the reordering those rows were
  unreadable by everyone, so "unreadable" was doing accidental duty as a
  control; it no longer is. The data was always *in* the table and erasure
  always had to purge it — what changed is that nothing now hides it in the
  meantime. Same 30-day statutory clock as the entry above.
- **Full CRM write auditing** — INSERT and UPDATE on all twelve tables, which
  fix round 1 deliberately did not build (only the two hard DELETEs and merges
  are audited). Belongs with the audit log viewer, and needs a before/after diff
  design plus a retention answer for the diffs. See `SECURITY.md` § 7, "CRM
  writes: what is audited today, and what is not".
- **Restore-from-audit is not possible, by design.** The audit payload is an
  allowlist of identifiers — `private.audit_crm_payload()` drops
  `custom_field_values.value` and `merges.field_resolution` — because
  `audit_events` is superuser-readable and CLAUDE.md § Superuser dashboard keeps
  tenant record content off that surface, naming the feedback screenshot as *the
  one* exception. If restore-from-audit is wanted it needs a founder decision
  about superuser access to tenant content, or a tenant-scoped undo table that
  is not `audit_events`.
- **`stepUpProofMode()` fail direction** — resolved in Foundation, but re-verify
  under a real step-up consumer.
- **Step-up trusts a client-supplied `factorId`** while the MFA path resolves it
  server-side. Two paths, two levels of trust; converge them.
- **`is_platform_admin()` passes its own name as the ignored permission
  argument.** Fix when real platform-permission granularity arrives — the same
  task.
- **Nothing at the database level stops a hard `DELETE` of an organisation, and
  it now takes every CRM record with it.** Measured: deleting one
  `organisations` row took `companies` 3→0, `agencies` 2→0,
  `custom_field_values` 1→0. `organisations.deleted_at` exists because
  soft-delete is the intended path (CLAUDE.md § Superuser dashboard: "Suspend/
  reinstate and delete are soft-delete only"), but the cascade is what actually
  happens if anyone issues the `DELETE`. Foundation set this precedent and the
  twelve Phase 2 tables inherit it; Phase 2 added blast radius, not the hole.
  **Review the superuser org-deletion path against this when it is built** —
  it is the one place in the product that will be tempted to issue that
  statement.
- **Comp auto-revert is not expressible on the current schema.**
  `organisation_subscriptions.comp_expires_at` has no companion column naming
  the tier to revert *to*, so CLAUDE.md's "comps auto-revert to the
  organisation's actual paid tier" cannot be implemented as written. Add the
  column with the billing-override write path.

- **Every new child table needs a tenant-scoped composite FK, not a plain one.**
  `20260828001132` fixed six of them after a proven cross-tenant write. Phase 3
  adds `event_lineup` (event_id + artist_id), Phase 4 adds the `*_links`
  tables, Phase 5 adds `financial_entries` — every one of them is a child row
  carrying its own `organisation_id`, and every one is the same defect if the
  FK names only the parent id. The pattern to copy is in `20260828001132`; the
  regression tests to extend are `supabase/tests/schema_invariants.sql`
  section A.

## Phase 10 — launch hardening

- **A real assistive-technology pass has never been run.** No NVDA, JAWS or
  VoiceOver was available at any point during Foundation; accessibility-tree
  and DOM/spec-level evidence was used instead and disclosed each time. The
  workspace switcher, both MFA gates and the idle-timeout banner are the
  surfaces that most need it.
- **The idle-timeout banner's live-region behaviour** (`role` and politeness on
  a non-modal banner wrapping a countdown that updates every 5s). Real WCAG 2.2
  AA concerns, and both need a screen reader to validate the fix. Do not "fix"
  them blind first — a change nobody can hear is not an improvement.
- **Google SSO has never completed a real sign-in.** The code path and its CSP
  allowances are written and the redirect chain runs un-blocked, but no OAuth
  credentials exist. Exercise it end to end once they do.
- **HSTS and `upgrade-insecure-requests` are gated on an https site URL** and so
  are unexercised locally. Verify from response headers on the first real
  deployment.
- **Audit `public` for table grants no migration issued.** The
  `ALTER DEFAULT PRIVILEGES` baseline (`20260827232507`) is scoped to the
  `postgres` role and **cannot** cover `supabase_admin`, whose own default ACL
  for `public` grants `anon`, `authenticated` and `service_role` the full
  `arwdDxtm` — SELECT/INSERT/UPDATE/DELETE, not merely the residual TRUNCATE.
  A `public` table created by `supabase_admin` therefore arrives **writable by
  anonymous API callers**. `postgres` can neither `SET ROLE supabase_admin` nor
  alter its defaults (both measured), so this cannot be closed from a
  migration. Recorded in `SECURITY.md` §10.

  The mitigation is procedural — create tables through migrations, never by
  hand — and `schema_invariants.sql` D6/D7 assert the Phase 2 half of it.
  Add a periodic check that no table in `public` holds a client grant that no
  migration issued.

  **An event trigger is technically available and is NOT recommended.**
  `postgres` can create event triggers on this stack (verified locally, in a
  rolled-back transaction), so a `ddl_command_end` trigger revoking client
  grants on newly created `public` tables would cover every grantor role
  including `supabase_admin`. It is recorded as a rejected option, not a plan:
  an event trigger firing on every DDL statement is a real operational risk on
  a hosted project — it runs inside migrations, inside Supabase's own platform
  upgrades, and a bug in it fails every future deploy — and its permissions on
  the hosted side are unverified from here.

## Standing lesson from Foundation

Three defects shipped past a source-only review and were caught only by running
the application in a browser: a sign-out lockout on every returning user, a
context tracker that never fired on client-side navigation, and an enrolment QR
code that never rendered. None was visible to `tsc`, ESLint, the build, or the
test suite.

Any task that ships a screen needs someone to open it. Treat a browser
walkthrough as part of the definition of done, not as optional diligence.
