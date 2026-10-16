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
- ~~**`artist_representations_one_current_primary_per_artist` enforces one
  *open-ended* primary, not one *current* one.**~~ **DECIDED, Phase 2 Task 4b**
  (fix round 1, I-4): option 2, accept the gap. A future-dated `ended_at` is a
  real industry fact people record ahead of it taking effect, so the write
  path does not forbid it — `20260829000000`'s closing note argues why, and
  `set_artist_primary_representation()`'s promote is scoped so the write path
  cannot itself create a second "current" primary. `PrimaryState` in
  `lib/crm/queries.ts` is the tie-break a reader uses when it finds more than
  one `is_primary` row (`current` / `scheduled-end` / `past`, and only
  `current` is ever labelled "Primary"). `task-4b-report.md` § 2 has the full
  argument and the measurement; `rls_phase2_crm.sql` T15-T15d assert it.
- ~~**Task 6's merge must resolve `is_primary` collisions before repointing.**~~
  **DONE, Phase 2 Task 6** (`20260829020000`, `public.merge_records()`). All
  three 23505s were reproduced before the fix rather than assumed --
  `contact_companies_one_primary_per_contact`,
  `contact_companies_contact_company_unique` and
  `artist_representations_one_current_primary_per_artist`, each from the plain
  repoint, and the demote-first version applying. The merge drops the colliding
  rows, demotes, promotes the winner's own row when the winner had no primary
  and the loser's was the one dropped (not in the original note, and the case
  that would otherwise leave a contact with no primary company), then repoints.
  `rls_phase2_crm.sql` W30-W36 and W44-W49. The original text follows.
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

  **CORRECTED BY PHASE 3 TASK 6 — the "every entity delete" half is wrong, and
  the DSR half is the whole item.** 20260829011000 put `private.entity_is_live()`
  into `custom_field_values_delete_via_entity`, so a soft-deleted entity's
  values are *undeletable by the application* from the instant it is deleted: a
  sweep after the soft delete deletes nothing and reports success, and a sweep
  before it strands the values of a record whose delete then fails. It would
  also be wrong if it worked — a soft delete is reversible, and a restored
  record whose custom fields had been swept comes back with everything except
  the workspace's own fields, silently. **So no entity soft-delete sweeps, and
  `lib/crm/events.ts` `deleteEventAction` carries that reasoning at the call
  site.** The one legitimate sweep is a MERGE, which carries values over first
  and then soft-deletes the loser (that half of this item stands and shipped).
  What is left is a hard-delete/erasure obligation on **all six entity types —
  `company`, `contact`, `agency`, `artist`, `venue` and now `event`** — for the
  Phase 7+ DSR/erasure workflow, which is the only thing in this product that
  ever hard-deletes.
- **A subscription downgrade must never delete a custom field definition.**
  `custom_field_values_definition_fkey` is `ON DELETE CASCADE`, which is right
  for referential integrity and dangerous for the tier path: CLAUDE.md
  § Permissions says "Downgrading a subscription makes features read-only or
  limited; it must never silently delete data." Deleting one definition to get
  back under a lower tier's limit destroys every value filed under it. Task 5
  must make definitions over the limit read-only/inactive instead, and should
  consider `deleted_at` on `custom_field_definitions` so "deactivate" is
  expressible at all.
- ~~**Task 6's dedup helpers must schema-qualify the trigram operators.**~~
  **DONE, Phase 2 Task 6**: `private.duplicate_probe()` writes the operator
  schema-qualified and `extensions.similarity(...)` under `set search_path = ''`.
  The original text follows.
  `pg_trgm` is installed in `extensions`, so `%` resolves as `extensions.%`.
  PostgREST supplies that search_path, so ordinary API queries work — but
  `SECURITY.md` §2 requires `SECURITY DEFINER` functions to have `search_path`
  locked, and the standard hardening (`set search_path = ''`, which every
  Foundation helper uses) makes `name % $1` fail with "operator does not exist".
  Write `name operator(extensions.%) $1` and `extensions.similarity(...)`.

### Opened by Task 8 (the phase exit gate)

- **The automated accessibility scan now exists, and the WCAG tag set alone
  could not see the defect this project already knew about.** Task 8 fix round 1
  added `@axe-core/playwright` and `tests/e2e/accessibility.spec.ts`, which scans
  the login page, seven signed-in golden-path surfaces and the in-app 404. Run
  at HEAD: with the five mandated tags (`wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa`) it reported **zero violations on every page,
  including the 404 whose nested `<main>` is filed two entries below**. axe
  classifies every `landmark-*` rule as `best-practice` rather than as a WCAG
  success criterion, so the mandated tag set is blind to it. `best-practice` was
  added to the tag set and the 404 then reported three rules; every other page
  stayed clean. **Two things follow for Phase 3:** a WCAG-tagged axe run is not
  a complete automated pass, and "0 violations" from any scanner is worth
  exactly as much as its rule set (the spec carries a `passes.length > 0`
  non-vacuity control for the same reason).
- **[SUPERSEDED 2026-09-09 by Phase 7 Task 5 -- § 5 IS NOW ENFORCED. The
  measurement below is kept as the record of what the gap was and why it
  mattered; do not read it as a current statement of the product.]**
  **NOTHING IN THE PRODUCT ENFORCES `SECURITY.md` § 5, AND SEARCH IS THE
  SURFACE THAT MATTERS.** A codebase-wide grep for
  `rate.?limit|ratelimit|throttl` returns one hit, `ACTIVITY_WRITE_THROTTLE_MS`
  in `lib/auth/idle-timeout.ts`, which throttles a `sessionStorage` write. The
  only real rate limiting anywhere is GoTrue's own
  (`supabase/config.toml:264,266`: `sign_in_sign_ups = 30`,
  `token_verifications = 30`, both per 5 minutes **per IP**), which does not
  meet § 5's Login row either -- that asks for 5 / 15 min per IP **and per
  account**, and no per-account limit exists. Search asks for 60/min/user and
  has none: fifteen list specs carry a `searchColumn`, and Task 3 measured that
  path at roughly **75 ms of database time per search at 20,000 rows**, growing
  linearly, because a non-leakproof operator cannot become an index qual for a
  caller RLS applies to. An authenticated member can issue those as fast as they
  like.

  **RE-COUNTED AT THE END OF PHASE 3 (Task 8), because the fifteen is now
  twenty.** Measured out of the source rather than estimated: **20 list specs
  carry a `searchColumn`** (`EVENT_LIST`, `EVENT_DELETED_LIST`,
  `VENUE_EVENTS_LIST`, `ARTIST_EVENTS_LIST` and `LINEUP_LIST` are the five
  Phase 3 added, all in `lib/crm/events-list.ts` and `lib/crm/lineup-list.ts`),
  and **15 pages render a `ListToolbar`** with a reachable search control, up
  from 13 — `/{org}/events` and `/{org}/events/deleted` are the two new ones.
  The other three Phase 3 specs DROP their `q` key deliberately
  (`VENUE_EVENTS_SEARCH_PARAM`, `ARTIST_EVENTS_SEARCH_PARAM`,
  `LINEUP_SEARCH_PARAM`), so they declare a `searchColumn` a PostgREST call
  needs and expose no control — which limits the blast radius to a
  hand-edited URL and does not remove it, because `spec.searchColumn` still
  reaches PostgREST the moment `params.q !== ""`. **Both numbers are the ones
  Phase 7 should build against: 20 unmetered `ilike` paths, 15 of them one
  keystroke away.** **SCHEDULED 2026-08-30 (final review I-9).** Owner: **the founder**.
  Implementation: **Phase 7 -- admin/security**, below. Pre-deployment gate:
  **Phase 10 -- launch hardening**, below, which refuses to ship without it.
  It is cross-cutting infrastructure, not Core CRM, which is why Task 8 did not
  build it -- but "recorded" is not "scheduled", and the Task 8 exit document's
  own merge condition 1 asked for the second.
- **The merge history says "No fields taken" when a field WAS taken.**
  `fieldsFromLoser()` (`lib/crm/dedup.ts:351`) reads only
  `field_resolution.fields`; custom fields taken in a merge live under
  `field_resolution.custom_fields.values` and are not counted, so
  `app/(app)/[orgSlug]/merges/page.tsx:238` renders "No fields taken" on a merge
  that carried one across. Reproduced through the UI: merge two contacts where
  only the loser has a custom-field value; the value transfers (verified in
  `custom_field_values`), the merge row records
  `{"from":"loser","chosen":"legitimate"}`, and the history denies it. The
  omission IS documented, in a code comment
  (`components/crm/activity-timeline.tsx:486`) -- but a page whose stated purpose
  is "which fields were taken from it" makes a false positive statement about an
  audited action, and a comment is not where a reader of that page will look.
- **Both merge-rendering paths are tested only against hand-written fixture
  rows.** Nine of eleven rows on `/merges` render as "This contact / the deleted
  record" because the names come from a snapshot in
  `field_resolution.<side>.before.name` that only `merge_records()` writes, and
  the psql and HTTP suites insert `merges` rows directly. A real merge through
  the UI renders both names correctly, so this is a fixture artefact and not a
  product defect -- but it means a change to what `merge_records()` writes would
  break the merge history AND the timeline's merge entries with every suite
  green. This is the Task 7 deferred minor ("no assertion binds the view's
  `field_resolution` paths to what `merge_records()` writes") on a second
  surface. **Fix the fixtures, not the screens.**
- **Every in-app 404 renders TWO `main` landmarks, one nested inside the
  other.** Measured on a signed-in tenant-breakout refusal:
  `document.querySelectorAll("main").length === 2`, `"main main" === 1`.
  `app/(app)/layout.tsx:150` opens `<main id="main">` and `app/not-found.tsx:21`
  opens its own `<main>` inside it. Nested `<main>` is invalid HTML and two
  `main` landmarks is a real screen-reader defect -- and this is the page every
  refused cross-tenant read lands on, so it is not a corner case. Not fixed by
  Task 8 because the same file serves the unauthenticated 404, where its
  `<main>` is correct; the fix is an `app/(app)/not-found.tsx` variant.
  **Now confirmed by a scanner, not only by hand** (fix round 1): axe reports
  `landmark-main-is-top-level` on `.max-w-md` ("The main landmark is contained
  in another landmark"), `landmark-no-duplicate-main` on `#main` ("Document has
  more than one main landmark") and `landmark-unique` on `#main` ("The landmark
  must have a unique aria-label, aria-labelledby, or title"), all `moderate`.
  All three were disabled BY NAME and only on this page in
  `tests/e2e/accessibility.spec.ts` (`NESTED_MAIN`), with a control that fails
  if the page ever stops being red -- so the exclusion could not outlive the fix.
  **CLOSED 2026-08-30 (final review I-8).** `app/(app)/not-found.tsx` renders
  the same markup in a `<div>`; `app/not-found.tsx` keeps its `<main>` because
  it serves the unauthenticated 404 where the page IS the document's main
  content. The control went red exactly as designed, `NESTED_MAIN` and the
  control are deleted, and that test now asserts ZERO violations under
  `best-practice` plus `main` count 1. Playwright 12/12 green at the fix.
- **`.github/workflows/ci.yml` DID execute, and its first three runs all failed
  in the workflow file rather than in the project.** ~~Never executed~~ —
  corrected in fix round 1. GitHub ran it on every Task 8 push (runs
  `33304352488`, `33305110034`, `33305705916`) and both jobs died in
  `actions/setup-node` before a single gate ran: `packageManager` pins pnpm
  11.24.0, which loads `node:sqlite` and needs Node >= 22.13, and the workflow
  asked for `node-version: 20`, so `pnpm store path` crashed with
  `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`. Fixed by
  pinning Node 24 in both jobs. **The lesson stands and is now evidenced rather
  than predicted:** an unexecuted workflow is an untested claim, and the very
  first thing this one proved was that it did not work. The YAML is now also
  parsed by a real parser (PyYAML) as part of editing it. It still covers only
  lint, typecheck, unit tests and the two scans -- the 852 psql assertions, 174
  HTTP checks, integration tests and 12 Playwright tests all need a running
  Supabase stack and run only on a developer's machine.
- **NO SCREEN READER HAS EVER BEEN USED ON THIS PRODUCT.** Tasks 3, 7 and 8 have
  each deferred it for want of a tool. The keyboard half is done and passes
  (visible focus rings, logical order, a working "Skip to content" link); the
  assistive-technology half is untouched, and `CLAUDE.md` § Legal names the
  Equality Act 2010 behind the WCAG 2.2 AA requirement. Task 7's deferred
  `<ol>`-without-`role="list"` minor could NOT be reproduced on the surfaces
  Task 8 walked -- the contacts list exposes no `ol`/`ul` at all and the contact
  detail page's socials list IS exposed as a `list` -- so it stays open on
  principle rather than on evidence, and needs a real screen reader (and a
  Safari) to settle.
- **`service_role` cannot write the tenant tables, and that is deliberate.**
  `POST /rest/v1/organisations` with the service-role key returns
  `42501 permission denied`: the default-privileges baseline
  (`20260827232507`, invariant D7) revoked the stock grants and nothing granted
  them back. RLS bypass is irrelevant when the GRANT is missing. Written down
  because the opposite is universally assumed, and any future server-side job
  that "just uses the service key" will hit it and be tempted to grant it back.
- **The trigram indexes are size-dependent and their `comment on index` does not
  say so.** `contacts_name_trgm_idx` is chosen at 40,001 rows (Bitmap Index Scan,
  0.709 ms) and NOT chosen at 5,001 (Seq Scan, 7.9 ms). Correct planning, not a
  broken index -- but "CONSUMER SHIPPED ... reaches it" is true at realistic
  tenant sizes and false at toy ones, and the next person to run `EXPLAIN` on a
  small fixture will conclude the keep decision was wrong.
- ~~**`CLAUDE.md` § Architecture is WRONG about auto-merge.**~~ **FIXED in fix
  round 1.** It said "exact matches (email/name) auto-merge"; the shipped
  behaviour is an exact case-insensitive **email** match only
  (`supabase/migrations/20260829020000_dedup_detection_and_merge_workflow.sql:385`
  labels every other pair `fuzzy_name`; `lib/crm/dedup.ts:704` merges only on the
  ids the database proposes), and in practice contacts only, because `contact`
  is the sole entry in `MERGEABLE_COLUMNS` with an `email` column
  (`lib/crm/dedup.ts:65`). Both § Architecture and § Decisions log now say so.
- **"Read Only" reads nothing unless records are assigned to it.**
  `private.full_scope_organisations()` excludes `read_only`, so a Read Only
  member of a five-contact workspace sees zero contacts and the empty state
  "No contacts assigned to you -- ask an Owner or Admin to assign some to you."
  Asserted deliberately (C23) and defensible; also surprising for a role whose
  name promises read-everything-write-nothing. **A founder decision, not a bug**,
  and it should be made before Phase 3 builds more record-scoped surfaces.

### Opened by Task 7 (the shared activity timeline)

- **A record-scoped read of `merges` still pays the polymorphic dispatch, and
  it is now on a page path.** Measured on 20,800 merges with a contact that
  survived 401 of them: the record-scoped first page is **343.4 ms**, of which
  **318.9 ms and 10,079 buffers** are the `merges_entity_winner_idx` scan
  evaluating `private.entity_is_visible()` twice per row.
  Task 6's two denormalised owner equalities short-circuit the dispatch only
  when the owners **differ**; when the rows really are the reader's, it runs for
  every one. The realistic case (a five-event contact) is 8–10 ms, so this is
  not urgent — but the shape is O(rows on the record) with a per-row function
  call, and **it recurs in every later phase that adds a polymorphic source**
  to `public.activity_events`. The fix belongs in the policy (a denormalised
  visibility column, or a per-entity-type partial index), not in the view.

- **A refused write on `public.activity_events` answers HTTP 500, not 4xx.**
  Postgres rejects it at rewrite time (SQLSTATE 55000, "Views containing UNION,
  INTERSECT, or EXCEPT are not automatically updatable") **before** any
  privilege check, so the absent INSERT grant never produces its 403. The write
  is refused twice over and nothing leaks, but anything watching error rates
  will read it as a server fault. Asserted as measured in `run-rls-tests.sh`;
  if the platform ever gets error-rate alerting, this is a known benign 500.

- **`contact_companies` removals can never appear on a timeline.** That table
  has no `deleted_at` — unlinking is a hard DELETE — so the removal leaves no
  trace anywhere in the database. `artist_representations` and `venue_rooms`
  are soft-deleted and their removals do appear, so the product shows an
  asymmetry a customer can see. Closing it means adding `deleted_at` to
  `contact_companies` and turning the unlink into a soft delete, which is a
  schema and a UX decision (a "former employer" is a real CRM concept), not a
  timeline one.

- **`SortOption.backedBy` is table-shaped and `ACTIVITY_LIST` is the first spec
  that is not a table.** The field's contract says "required to be a real index
  name"; a view has no index of its own, so the activity spec names the
  per-branch set instead. Either widen the field's contract to say what a view
  should put there, or accept that one spec's value is a sentence.

- **Nothing records WHO did anything except `merges`.** Of the eight event
  kinds, only `merge_absorbed` / `merge_into` can name a person, because
  `merges.merged_by` is the only actor column in the Phase 2 schema.
  `owner_user_id` is the record-scope column and is explicitly **not** an
  author (nullable, `ON DELETE SET NULL`, rewritten by any future reassignment
  feature). A "who changed this" timeline needs `audit_events`, whose only
  SELECT policy is platform superuser; the narrowest exposure that would work
  is designed in `task-7-report.md` § 3 and deliberately **not built** — Q13's
  standing default keeps the boundary shut in Phase 2.

- **Two paginated lists on one page drop each other's state unless the page
  says otherwise.** `ListSpec.paramPrefix` and `HrefOverrides.preserve` (both
  added by Task 7, both off by default) fix it for the artist detail page, and
  the artist page is the only caller. Phase 3's event page will have several
  such surfaces: the prefix must be set on every spec that shares a route, and
  `preserve` passed to every list on it. There is no compile-time check that
  either was done — the failure is a wrong page, not an error.

### Opened by Task 6 (dedup detection and the merge workflow)

- **`CLAUDE.md` § Architecture still says "exact matches (email/name)
  auto-merge" and the product does not.** Founder decision Q11 (closed) makes
  auto-merge **email-only, case-insensitive**; every name match, exact or fuzzy,
  goes to the manual review queue. `20260829020000`'s DECISION 1 carries the
  measurement that makes it more than a preference: **four of the five entity
  types have no email column at all** (`companies`, `agencies`, `artists`,
  `venues` are name-only), so "exact match on normalised name" is not a
  secondary rule for them, it is the ONLY rule -- and two venues called "The
  Social" in two cities are two venues. **CLAUDE.md is updated when Phase 2
  merges, not by Task 6.** The practical shape to write there: auto-merge exists
  for contacts and for nothing else.

- **`private.record_merge()` is granted to `authenticated`, which
  `private.log_audit_event()` is not.** The merges INSERT grant and policy are
  gone (Task 2 shipped the no-UPDATE/DELETE half and not this one), so the
  function is the sole writer and restates the dropped policy term for term. It
  has to be granted, because its caller `public.merge_records()` is
  `SECURITY INVOKER` and must stay that way -- a definer merge would run every
  CRM statement as `postgres`. **The residual is a DIRECT DATABASE SESSION as
  `authenticated`**, which could write a merges row without merging anything;
  PostgREST exposes `public` only, so it is not reachable from the product's
  client surface (asserted: `rpc/record_merge` is a 404). Strictly narrower than
  the table grant it replaces, which WAS reachable over HTTP. Close it properly
  if the merge is ever moved behind a server-side-only path.

- **`merges.field_resolution` has TWO SHAPES, and the version number is how to
  tell them apart.** `20260829030000` (fix round 1, review finding I-1) gave the
  custom-field section the same `{from, chosen, discarded}` keys the ordinary
  columns always had, because the previous shape recorded the LOSER's value
  only -- so a reviewer who explicitly chose the loser's value for a field the
  winner also held overwrote the winner's value and nothing recorded it.
  `version` is `2` from that migration on. **The v1 rows cannot be repaired**:
  `merges` is append-only by design, there is no UPDATE grant, and a v1 row
  simply does not contain the winner's value. A reader -- the support path in
  `20260829020000`'s DECISION 5, and anything Phase 7 builds over the merge
  history -- must branch on `field_resolution ->> 'version'` and treat a v1
  chosen-loser overwrite as unrecoverable.

- **`field_resolution.links` records COUNTS, not which rows moved.** Enough to
  reconstruct both records by hand (task-6-report § 2 walks the support request
  through), and NOT enough to know exactly which `contact_companies` rows were
  repointed when `dropped > 0`. An undo feature -- explicitly out of Phase 2 --
  needs the row ids, which means either an array in `field_resolution` or a real
  undo table. Decide with the undo, not before it.

- **The two denormalised owner columns on `merges` go stale.**
  `winner_owner_user_id` / `loser_owner_user_id` are a snapshot taken at merge
  time and are a PRE-FILTER in front of `entity_is_visible()`, never a
  replacement for it -- so a stale value can only narrow, never grant.
  Deliberate consequence, asserted by Q5b/Q6b: a merge whose record is later
  reassigned TO a record-scoped user is no longer visible to them, and a merges
  row written before Task 6 (NULL in both) is invisible to them entirely. If a
  record-reassignment feature ever ships, decide then whether it back-fills
  these; the fail-safe direction is to leave them alone.

- **Rows whose PARENT is soft-deleted are STRANDED by a merge, by design.**
  `contact_companies` (via its contact), `artist_representations` and
  `venue_rooms` (via their artist and venue) all gate UPDATE on the parent being
  live. When a merge repoints the OTHER end -- a company merge moving
  `company_id`, an agency merge moving `agency_id`, a contact merge moving
  `artist_representations.contact_id` -- rows under a soft-deleted parent are
  visible and not updatable. Raising would make an agency unmergeable forever
  because one artist who once used it has since been deleted, so they keep
  pointing at the (soft-deleted) loser and the count is recorded in
  `field_resolution.links.<table>.stranded`. Revisit with the restore story:
  restoring that parent brings back a child pointing at a merged-away record.

- **`lib/list/query.ts` now has ONE table that reads without a soft-delete
  predicate, and it is `merges`.** `TABLES_WITHOUT_SOFT_DELETE`, keyed on the
  table rather than on an option a spec can pass, because `merges` has no
  `deleted_at` and must not grow one (append-only by design) -- measured, the
  filter `lib/list` would otherwise send is a 400: `42703, column
  merges.deleted_at does not exist`. Bound to the catalogue by
  `tests/integration/list/soft-delete-tables-match-db.test.ts`, which fails if a
  listed table grows the column or if `merges` gains a grant beyond SELECT. **A
  Phase 3+ table belongs on that list only with the same argument written down
  next to it.**

- **`merge_candidates.resolved_by` has no `ON DELETE` clause**, matching
  `merges.merged_by` and `audit_events.actor_user_id` for the same reason: GDPR
  erasure must anonymise rather than delete. **All three are one decision, not
  three** -- whatever the Phase 7+ erasure workflow does about one it must do
  about all of them in the same change.

- **The dedup similarity threshold is 0.6 and lives in ONE function.**
  `private.dedup_similarity_threshold()`. A per-organisation setting is a change
  to that signature (add `p_organisation_id`, read a column) and to nothing
  else, because every call site already has an organisation id in hand and no
  query text changes. Deliberately not a UI setting at MVP: nobody has tenant
  data to tune it against.

- **`private.dedup_mergeable_columns()` is written twice**, in SQL and as
  `MERGEABLE_COLUMNS` in `lib/crm/dedup.ts`, because the merge screen has to
  draw the rows before the function runs. Bound by
  `tests/integration/crm/mergeable-columns-match-db.test.ts`, which also asserts
  every listed column exists on its table and that none of `id`,
  `organisation_id`, `owner_user_id` or the timestamps is ever offered. **A new
  column on a CRM entity is not mergeable until someone adds it to both.**

- **A `read_only` user's view of a NON-EMPTY review queue was never rendered in
  a browser.** Task 6's walkthrough fixture gave `read_only` no records of its
  own, so record scope made the queue empty and the empty state is what was
  seen. The banner copy and the `Compare`-rather-than-`Review` link on that path
  are the same code `standard_user` exercises (which WAS seen, with the banner)
  and W67 asserts the silent `ok(0)` dismissal in psql. One render inferred
  rather than looked at.

### Opened by Task 4 (CRUD on contacts and companies)

- **WITHDRAWN (Task 4 fix round 1): "every `<Link>` navigation is a full
  document load".** Left here as a record of how the entry got written, not as
  work for anybody.

  Task 4's browser pass reported that no `?_rsc=` request was attempted, that
  the document was reloaded on every `<Link>`, and that `document.activeElement`
  was `BODY` afterwards; it named the per-request CSP nonce in
  `lib/supabase/middleware.ts` as the leading (explicitly unverified) cause, and
  it rewrote two source comments to remove Task 3's true claim about focus.

  **It does not reproduce.** Re-measured independently twice on a clean
  `pnpm dev` against the local stack, signed in as `pmanager` — once by the Task
  4 review, once by the fix round:

  | probe | result |
  |---|---|
  | `window` property set before a sort click | survived |
  | `performance.getEntriesByType("navigation").length` after | 1 — still the original load |
  | `?_rsc=` request for the destination | issued |
  | `document.activeElement` after a focused sort activation | the same `<a>` |
  | `document.activeElement === ` the "Next" node it started on | true |

  The nonce is **refuted**, not merely unverified: it is present on the wire
  (`script-src 'self' 'nonce-…' 'strict-dynamic'`, read with curl) and
  navigation is soft anyway.

  **The likely cause of the original reading**, stated as inference rather than
  as measurement: an orphaned `pnpm dev` from an earlier session was still
  listening on port 3000 in a crashed state (`Failed to generate static paths`,
  `Jest worker … exceeding retry limit`, `write EPIPE`), and Next falls back to
  a hard navigation when the RSC fetch fails. That server was not reconstructed
  to re-measure. `document.activeElement` really is `BODY` after a *pointer or
  programmatic* click, which never focuses the anchor in the first place — the
  browser's normal behaviour, and the most likely thing the original probe was
  reading.

  **Both rewritten comments are restored** (`components/list/list-pager.tsx`,
  `app/(app)/[orgSlug]/contacts/page.tsx`), each carrying the numbers above.
  Task 3's Suspense-key fix is intact and should not be re-litigated. Measured
  in `pnpm dev` only, twice: `pnpm build` / `pnpm start` still resolve to the
  hosted project (ledger I-5), so no production build was run.

- **A detail page's link picker is bounded at 100 and has no search.**
  `LINK_PANEL_LIMIT` in `lib/crm/queries.ts`. A workspace with more than 100
  companies shows the first 100 by name in the "Link a company" `<select>` and
  a contact linked to more than 100 companies shows the first 100. That is well
  past any real record and it is still an unbounded-list rule (CLAUDE.md
  § Non-negotiable rules) satisfied by a cap rather than by a design. The real
  answer is a search-backed picker with its own keyset page; it needs a
  measured design and Task 4 did not have one, so the cap is deliberate and
  named rather than guessed at. **Task 4b copied it, not built the search-backed
  picker (fix round 1, I-4 recorded this update): it now also caps the three
  new panels `loadRepresentationsForArtist`, `loadRepresentationsForAgency` and
  `loadRoomsForVenue` (`lib/crm/queries.ts`), plus the agency/artist/contact
  `<select>`s on the representation form itself.** The search-backed picker is
  still not built and this is still the same deliberate stopgap, one workspace
  wider.

- ~~**`artist_representations_one_current_primary_per_artist` still enforces one
  *open-ended* primary rather than one *current* one** — pre-existing, restated
  because Task 4's `is_primary` decision does not close it.~~ **DECIDED, Phase 2
  Task 4b** (fix round 1, I-4) — see the earlier entry against this same index
  in the "Phase 2 — Core CRM" section above, which carries the pointer to the
  migration header, `PrimaryState` and `task-4b-report.md` § 2. Restated here
  only to close the duplicate rather than leave two open items for one decided
  question.

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

  Postgres will not promote a **non-leakproof** qual to an index qual on a
  relation that carries RLS **security quals for the current caller**, so on
  this table `ILIKE` and `%` can never become an Index Cond for an
  `authenticated` session. A role RLS does not apply to (`BYPASSRLS`, or the
  table owner without `FORCE ROW LEVEL SECURITY`) has no such quals, which is
  why the same statement as `postgres` uses the trigram index — and why a
  `SECURITY DEFINER` function owned by such a role can too. "RLS enabled on the
  table" is NOT the condition, and stating it that way is a counter-example to
  itself: measured, `contacts` has `relrowsecurity = t` and `postgres` still
  uses the trigram index, and still does after `force row level security`
  (0.045 ms with FORCE on, 0.044 ms off, identical plans). The distinction is
  load-bearing — the whole SECURITY DEFINER consequence below turns on it.

  The controlled pair below varies leakproofness AND which index can serve the
  operator, so it is suggestive rather than decisive. The decisive version, run
  in re-review, holds role, RLS, index, statement and session fixed and flips
  only `pg_proc.proleakproof`: `texticlike` goes 27.379 ms Seq Scan → 0.855 ms
  `Bitmap Index Scan … Index Cond: (name ~~* '%Wilhelmina%')`, and
  `similarity_op` 31.345 ms → 0.566 ms.

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
  schema-qualified (`name operator(extensions.%) $1`), and — the part that
  matters most — **the WHOLE policy re-established inside the function, not
  just membership.**

  A re-review built this function to the earlier spec, minus the membership
  check, and read `BRAVO SECRET CONTACT` out of a tenant the caller is not in.
  The body is the only control there is, so the spec has to be exact:

  ```sql
  create function private.contact_search(p_org uuid, p_term text)
  returns table (id uuid, name text)
  language sql stable security definer set search_path = ''
  as $$
    select c.id, c.name
      from public.contacts c
     where c.organisation_id = p_org
       and c.deleted_at is null
       and p_org in (select private.permitted_organisations('view_crm'))
       and ( p_org in (select private.full_scope_organisations())
             or c.owner_user_id = (select auth.uid()) )
       and c.name operator(extensions.%) p_term
     order by extensions.similarity(c.name, p_term) desc
     limit 50;
  $$;
  revoke execute on function private.contact_search(uuid, text) from public;
  grant  execute on function private.contact_search(uuid, text) to authenticated;
  ```

  Calling the existing helpers inside the body is the cheapest correct way, and
  it works: `auth.uid()` reads `request.jwt.claims`, which is session state and
  is **not** rewritten by `SECURITY DEFINER` — verified inside a definer body
  running as `postgres`, `uid` was still the caller's. Omitting them loses, in
  order: the role→permission mapping, the soft-deleted-organisation check, the
  MFA gate (`role_requires_mfa(role) → session_is_aal2()`), and the record-scope
  disjunction — the last of which returns to a Standard User rows their own list
  will not show them. Add `deleted_at is null`; RLS deliberately does not
  (Task 2 § 4.1).

  **It must be owned by the table owner, and that cannot be reduced.** Measured:
  the same function owned by a role that is neither table owner nor `BYPASSRLS`
  returns **0 rows** — RLS applies to it and it has no policy. So "own it with a
  least-privilege role" is the obvious mitigation and it does not work; the
  function will be able to read every tenant's contacts and its body is the
  entire control. `revoke execute … from public`, grant only to `authenticated`.

  **Its tests in `rls_phase2_crm.sql` must include, each expecting 0 rows:**
  called for an organisation the caller is not in; called by an `aal1` Owner;
  called by a `standard_user` for a row they do not own.

  **CORRECTED IN TASK 3a FIX ROUND 1. A fourth case used to be listed here —
  "called for a soft-deleted organisation", expecting 0 rows — and since
  `20260828210000` (Q6) that expectation is WRONG in the direction that matters.**
  Suspension is read-only, not a lockout: a member of a suspended organisation
  holds `view_crm`, so `p_org in (select private.permitted_organisations('view_crm'))`
  is TRUE and the search returns rows. Writing the test to expect 0 would either
  fail against a correct implementation or, worse, be "fixed" by adding a
  `deleted_at is null` on the ORGANISATION inside the function body — which would
  reintroduce the lockout Q6 reversed, in a `SECURITY DEFINER` function where the
  body is the entire control. The correct assertion is the opposite one: **a
  member of a SUSPENDED organisation searching their own tenant gets their rows,
  and a non-member of that suspended organisation still gets 0** (the shape
  `rls_phase2_crm.sql` P1/P9 already use). The `c.deleted_at is null` in the
  function body above is the CONTACT's soft-delete filter and is unrelated —
  keep it. That is a task, not a patch.

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

  Re-review reproduced this independently on its own fixture — 0.159 ms against
  31.233 ms over 20 calls each, **196×**, `Bitmap Index Scan on
  contacts_name_trgm_idx`, `Index Cond: (name % 'Wilhelmina'::text)`.

  **Write cost, measured, because "keep it" needs both sides.** 2,000 inserts
  plus a bulk update of 2,000 rows, alternated with and without all four
  indexes so a warm cache favours neither, and re-measured over three further
  alternated rounds in re-review: **+0.01–0.03 ms per inserted row** (+24.0 ms
  per 2,000 inserts). A bulk update **of the indexed column** roughly
  **doubles** (125.5 ms against 61.5 ms) — not the "+35%" first recorded, which
  is what you get updating some other column; updating a non-indexed column is
  a HOT update and costs nothing measurable, and deletes are noise. Size is
  **≈0.8–6 MB per 25,000 contacts, depending on name diversity** — the index
  is dominated by distinct trigram count, so the earlier bare "5.7 MB per
  25,000" read as a property of the schema and is not one (824 kB measured on
  the re-review fixture, against 8,624 kB for `contacts_org_name_id_live_idx`).
  The decision does not move: a 196× win against ~0.02 ms per insert is not
  close. These are the numbers to size a bulk import with.

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
  `GETSETPAID_ALLOW_HOSTED=1` is set (so the production host, where `.env.local`
  is absent, is unaffected -- an IONOS VPS, founder 2026-09-30, Q142). `tests/integration/rls/support/env.ts` already contains the
  loopback assertion to reuse.

- **PARTLY DISCHARGED (Task 3a / Phase 2), one residual open — verified at HEAD
  by Task 8, 2026-08-31.** `getCurrentOrg()` NO LONGER filters `deleted_at`
  (`lib/auth/index.ts:196` documents the removal), so a suspended workspace no
  longer 404s when selected — it resolves to the read-only banner state
  (`isSuspended` at `:276`, `app/(app)/layout.tsx:146`). **The residual is the
  switcher half only:** `getActiveMemberships()` (`:135`) still does not select
  `organisations.deleted_at` and `components/org/workspace-switcher.tsx` renders
  no read-only marker, so the workspace is listed without a badge — a missing
  marker, not a broken link. Owner: Phase 3-members. The original entry follows;
  its "wrongly 404s" conclusion is the part that is now stale.

- **A soft-deleted organisation still appears in the workspace switcher.** Not
  Task 3's code; found by the reviewer while building fixtures.
  `getActiveMemberships()` filters on membership `status` but not on
  `organisations.deleted_at`, while `getCurrentOrg()` filters it — so a
  suspended workspace is listed in the header switcher and 404s when selected.

  **REWRITTEN BY TASK 3a, AND THE FIX DIRECTION IS NOW THE OPPOSITE ONE.** This
  entry originally called `getCurrentOrg()`'s filter "correct" and the whole
  thing "a dead entry rather than an access problem (the database denies either
  way)". Both halves were true only under the decision Q6 reversed. Since
  `20260828210000` the database **permits** the read, so the filter in
  `getCurrentOrg()` is now the single line that makes the founder's decision
  unreachable from a browser, and the switcher entry is not dead — it is the
  correct entry pointing at a page that wrongly 404s. See the Task 3a item under
  "Phase 3 — events" below for the full description of what the UI owes this.

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
- **CORRECTED BY TASK 6: THE ORDERING CONSTRAINT BINDS ON A SOFT DELETE TOO.**
  The entry below says "Soft delete leaves the row in place, so the ordinary
  path is unaffected -- this only bites on a genuine hard delete". That stopped
  being true when `20260829011000` (Task 5) added `private.entity_is_live()` to
  `custom_field_values_delete_via_entity`: a soft-deleted entity is not live, so
  its values become undeletable by every client role the instant it is
  soft-deleted -- the exact orphan state the sweep exists to prevent, reached by
  the path this note calls safe. Reproduced as `rls_phase2_crm.sql` W40-W42
  (`ok(0)` while deleted, the row still present, `ok(1)` after a restore).
  `public.merge_records()` therefore carries values over, sweeps, and THEN
  soft-deletes, and `20260829020000`'s DECISION 4 says so on the migration.
  **Phase 7's organisation deletion and the DSR erasure inherit the corrected
  rule, not the one below.** The original text follows.
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
  Task 3 on will hit it. **Every mutation must ask for the row count and treat
  zero as a denial, not a success** — `Prefer: count=exact` is the cheap way
  (the count is in the `Content-Range` header, never in the status code);
  `Prefer: return=representation` also works and costs a full body. See § "Task
  3/4" item 5 for the measurement and the sixteen endpoints this applies to.
  The two CRM `DELETE` policies are the worst case: a
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
- ~~**Task 6: a record-scoped `merges` list is ~2.3 s per page at 20k rows, and
  no policy can fix it.**~~ **DONE, Phase 2 Task 6**, with two corrections to
  the design this entry proposed. (1) IT HAS TO BE BOTH SIDES: a
  `winner_owner_user_id` term alone would re-open the IMP-2 leak the both-sides
  policy exists for. (2) IT CANNOT REPLACE THE DISPATCH, only narrow it -- the
  columns are a snapshot and a stale snapshot must never GRANT -- so the two
  equalities are AND-ed in FRONT of `entity_is_visible()`, which remains the
  authority. Measured on 20,000 merges over 20,000 contacts with 200 visible to
  the record-scoped reader, 50-row page: **602.463 ms -> 39.859 ms (15.1x)**,
  same plan, same 4851 rows removed by filter, 50 rows returned in both. The
  full-scope reader is unchanged (0.599 -> 1.098 ms) and H15 still passes. The
  original text follows. `merges_select_via_winner` is the one CRM SELECT policy
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
- **Task 3/4: THE READ-ONLY SUSPENDED WORKSPACE IS UNREACHABLE FROM THE BROWSER,
  and one line is why.** Raised by Task 3a, which implemented DECISIONS-QUEUE Q6
  in the database (`20260828210000`) and deliberately did not build the UI.

  Q6 (founder, 2026-08-28) makes suspension **read-only**: a suspended
  organisation's members keep `view_crm` and lose every write. The database now
  does exactly that — `rls_phase2_crm.sql` § P proves a manager reads all 13
  contacts of a suspended organisation and cannot insert, update or delete a
  single row on any of the eight surfaces. **The application never gets that
  far.** — **CORRECTED AT HEAD (Task 8, 2026-08-31): this is no longer true.**
  `getCurrentOrg()` (`lib/auth/index.ts:196`) NO LONGER filters `deleted_at`;
  the filter was removed and replaced by an `isSuspended` flag (`:276`), the
  read-only banner (`app/(app)/layout.tsx:146`) and the write gate. **Points
  1, 2, 3 and 5 of the specification below SHIPPED** — the flag, the banner, the
  disabled-and-explained controls, and the `count: "exact"` failed-write signal
  on the save path (asserted by `source-shape.test.ts`). **Point 4 is the sole
  residual:** `getActiveMemberships()` filters on `status` only, so the switcher
  still lists a suspended workspace, now WITHOUT a read-only marker — selecting
  it lands on the banner state, not a 404. Owner: Phase 3-members. The original
  (pre-fix) description follows so the specification is preserved; its 404
  premise is discharged.

  This was previously written up here as "not a security issue — the database
  denies either way". **That is no longer true and it is the reason this entry
  was rewritten rather than ticked off:** the database no longer denies, so the
  filter is not a redundant belt-and-braces, it is the thing that defeats the
  decision. Until it moves, Q6 is implemented at the only layer that enforces
  anything and at none of the layers a customer can see.

  What the UI owes it, at minimum:
  1. `getCurrentOrg()` returns the organisation with an `isSuspended` flag
     instead of `null`. Do **not** simply delete the filter — the flag is what
     every consumer needs, and a silent unfiltered read gives a
     normal-looking workspace whose every write 403s with no explanation.
  2. A persistent, non-dismissible banner on every route of a suspended
     workspace: the workspace is read-only, why (suspended by the platform),
     and who to contact. It must not imply the user can fix it themselves —
     `manage_organisation` is a write, so an Owner genuinely cannot un-suspend
     (P7; DECISIONS-QUEUE consequence P7).
  3. Write controls **disabled**, not hidden and not present-and-failing.
     Hidden loses the explanation; present-and-failing produces a 403 the user
     cannot interpret. The same `isSuspended` flag drives both, alongside the
     role and entitlement checks the Task 4 item above already lists.
  4. The switcher renders the suspended workspace with a read-only marker
     rather than dropping it — dropping it hides a workspace the user still has
     lawful read access to, which is the outcome Q6 exists to prevent.
  5. **Check the row count on every mutating request, and treat zero as a
     failed write.** Item 3 is necessary and not sufficient: PostgREST is
     reachable from the browser with the anon key regardless of what the UI
     disables, so the save path — not only the button — has to be able to tell
     an applied write from an accepted no-op. It cannot today. A PATCH refused
     by a USING clause matches no rows and PostgREST answers **204 No Content**,
     byte-identical *in the status line* to a PATCH that changed fifteen rows:

     ```
       LIVE:      manager PATCHes contacts   204   (15 rows changed)
       SUSPENDED: manager PATCHes contacts   204   ( 0 rows changed)
     ```

     **The row count is in the `Content-Range` response header, and it is never
     in the status code.** Fix round 1 measured only the status line, concluded
     that `Prefer: count=exact` "does NOT distinguish them (still 204)", and
     wrote that into four places. It is false — corrected here in fix round 2
     after the re-review measured it. Same caller, same PATCH, live then
     suspended, on the local stack:

     ```
       no Prefer header      204   Content-Range: 0-14/*    vs   */*
       count=exact           204   Content-Range: 0-14/15   vs   */0
       return=representation 200   6056 bytes of body       vs   2 bytes ([])
     ```

     Three mechanisms, all of which work, in increasing cost:

     1. **Nothing at all.** The *range* half of `Content-Range` is `first-last`
        when rows were written and a bare `*` when none were. Free, but it is
        the shape rather than the number, and a `DELETE` reports `*/n` — range
        `*` with a real total — so this one does not generalise across verbs.
     2. **`Prefer: count=exact`** — the total after the slash *is* the number of
        rows written (`/15` versus `/0`). Still a 204 with an empty body. In the
        pinned supabase-js (2.112.4) this is `.update(values, { count: 'exact' })`
        and `.delete({ count: 'exact' })`, and the count arrives on the result
        object — measured through the client library, not only over curl:

        ```
          LIVE       status=204 count=15 data=null error=null
          LIVE       DELETE status=204 count=1
          SUSPENDED  status=204 count=0  data=null error=null
          SUSPENDED  DELETE status=204 count=0
        ```

        Note `error` is `null` and `status` is `204` in **both** rows: the only
        thing that differs is `count`. **This is the right default for a save
        path**, and `count === 0` is the failed-write signal.
     3. **`Prefer: return=representation`** (`.select()` in supabase-js) — also
        works, returns `[]` on a refused write, and costs a full body on every
        save: 6056 bytes for fifteen contacts, against 0 for the header that
        carries the same fact. Use it when the save path *wants* the written row
        back (server defaults, triggers, `updated_at`), not to learn a count.

     All three are asserted in `run-rls-tests.sh` against a live control.

     **The rule, rather than a list, because a list cannot stay correct: every
     PostgREST `PATCH` and `DELETE` answers 204 on no-match, so the count has to
     be checked on all of them.** As of today that is **sixteen** endpoints, not
     the twelve fix round 1 called "every mutating endpoint the Phase 2 tables
     expose today" and not the nine the Task 3a review counted. Derived from
     `pg_policies` (every `public` table carrying an UPDATE or DELETE policy a
     member can reach) and then each one measured over HTTP in a suspended
     workspace — all sixteen `204` with `Content-Range: */0`:

     - `PATCH` on `contacts`, `companies`, `venues`, `artists`, `agencies`,
       `venue_rooms`, `custom_field_values`, `custom_field_definitions`,
       `organisation_memberships`, `organisations`, **`artist_fee_history`**,
       **`artist_representations`**, **`contact_companies`** — thirteen;
     - `DELETE` on `contact_companies`, `custom_field_values`,
       **`organisation_memberships`** — three.

     (`profiles` and `organisation_subscriptions` also carry UPDATE policies and
     are deliberately not in the list: `profiles` is user-scoped rather than
     organisation-scoped, and `organisation_subscriptions` UPDATE is the
     platform-billing path, not a member surface.) Phase 3 adds more, so treat
     the list as today's derivation and the rule as the thing to implement.

     **It is not a defect Task 3a introduced.** 204-on-no-match is generic
     PostgREST behaviour — a PATCH at an id that does not exist, or at another
     tenant's row, is also 204. What Task 3a changed is *reachability*: before
     it, a suspended organisation's member could not read the record at all, so
     no edit form could exist to submit. Now one can, and a naive save path
     would tell them it worked.
- **STILL TRUE AFTER TASK 6, and extended.** The record-scoped branch now leads
  with the two denormalised owner equalities and evaluates `entity_is_visible()`
  on both sides behind them; `rls_phase2_crm.sql` W62-W65 assert the guarantee
  directly, including that no discarded value leaks by any path. THE COROLLARY
  DOES NOT ARISE TODAY: Task 6's merge SOFT-deletes the loser, so no merge this
  product performs makes its own record invisible. It still arises for a Phase 7
  hard delete. The original text follows.
- **Task 6: `merges` SELECT now requires BOTH sides visible, not just the
  winner.** Changed in fix round 1 (`20260828140500`) because
  `field_resolution` copies both records' values verbatim and a record-scoped
  user was reading the DISCARDED email and phone of a record that was never in
  their scope. A merge screen can therefore only show merges where the viewer
  can see both records. The corollary: if a loser is ever HARD-deleted its merge
  record becomes invisible to everyone, so a merge whose record is gone must be
  read through the audit trail rather than through this policy.

## Phase 3 — events

> **TRIAGED AT THE PHASE EXIT (Task 8, 2026-08-31).** This section mixes two
> kinds of bullet and the difference matters to whoever reads it next.
>
> **OBLIGATIONS — each now carries an owner and a phase, in the bullet itself:**
> the five Phase 2 `<select>`s and the pre-hydration sibling (Phase 4, first
> task); the no-JavaScript submit (same change); the UPDATE-policy record-scope
> blind spot on five Phase 2 tables (Phase 4, with the `*_links` tables); the
> venue "Events here" index (Phase 5, or earlier, with the named measurement);
> the artist 50-slot window (founder decision, with a one-line honest stopgap
> owed sooner); `loadLinkOptions`'s untested `organisation_id` filter and the
> `entity_is_live` CI blind spot (both § "Opened by Task 8 (the Phase 3 exit
> gate)" below, Phase 4); the Free-tier "Add one" copy defect (Phase 3 fix
> wave); `20260901031000`'s needless `grant execute` (Phase 4's first
> migration).
>
> **RECORDED MEASUREMENTS, each with its decision already taken in-line and
> nothing owed:** the `include (owner_user_id)` non-reproduction, `loadEvent`'s
> three round trips, the count query's O(tenant) cost, `§ EX` covering events
> only, the room and artist picker caps, `lib/list/cursor.ts` being server-only
> in practice, the two comment-accuracy notes, and the events-are-not-mergeable
> decision. They are kept because re-deriving them costs a day each; they are
> not work items and should not be triaged as though they were.
>
> **Struck-through bullets are DONE** and are kept for the correction they
> carry, which is usually the useful half.


- ~~**FIRST TEST TASK OF PHASE 3 (added 2026-08-30, final review I-7): the
  merge fixtures must call `merge_records()`.**~~ **DONE, Phase 3 Task 1**
  (`rls_phase2_crm.sql` § Z, `run-rls-tests.sh`'s `p2_json` probes). Five
  dedicated pairs -- one per mergeable entity type, ids `ccce0000-…` /
  `ccce1000-…` -- are merged through `public.merge_records()` as `pmanager`,
  and Z6/Z7/Z8 assert the exact jsonb paths the two screens read, including
  the activity view's `field_resolution -> 'loser' -> 'before' ->> 'name'`.
  Mutation-tested: renaming `'before'` to `'prior'` in `merge_records()`'
  snapshot write turns Z6-Z8, Z10 and three HTTP probes red while every
  pre-existing assertion stays green.

  **TWO DEVIATIONS FROM THE PLAN, both deliberate and both still true of the
  suite today.** (1) The existing hand-written `merges` rows were NOT
  converted -- `merge_records()` soft-deletes the loser and repoints its join
  rows, and ~680 assertions are built on `cccc0000-…-000000000002`. So the
  suite now holds merge rows in two shapes on purpose: hand-written ones with
  no `<side>.before` snapshot, and real ones with it. (2) The new pairs are
  planted **in § Z**, not in the fixture block at the top of the file, because
  this file counts rows in org ALPHA in a dozen places and ten more records
  would have moved most of those numbers. § Z is the last section, so nothing
  else sees them. Anyone adding a sixth pair should add it there too.

The following are carried out of Phase 2 Task 1 into the migration that creates
`public.events`. **ALL DISCHARGED IN PHASE 3 TASK 1
(`20260901001000_event_entity_type_widening.sql`)** -- the original text is kept
below because two of the four were wrong about their own scope, and the
corrections are the useful part. Each now says what was actually done.

- ~~**`artist_fee_history.event_id` needs a TENANT-SCOPED foreign key, and is
  held NULL until it gets one.**~~ **DONE, Phase 3 Task 1.**
  `20260901001000` drops `artist_fee_history_event_id_unwritable_until_phase_3`
  and adds `artist_fee_history_event_fkey`, composite and with the
  `on delete set null (event_id)` column list, plus the covering index D3
  requires. Both traps this entry names were obeyed and both were re-measured
  on this stack rather than taken on trust: with the column list removed,
  deleting a venue an event names raises
  `23502 null value in column "organisation_id"`, and the CONTEXT line shows
  Postgres nulling `organisation_id` alongside the intended column.
  Regression tests: `schema_invariants.sql` A14 (cross-tenant), B11
  (positive), C4 (dangling uuid, `23503`), C4b (the Phase 2 CHECK is really
  gone), E4/E5 (the SET NULL column list, on `events_venue_fkey`); and
  `rls_phase2_crm.sql` T32d-T32g through a real session. The original text
  follows. It could not have one in Phase 2 —
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
- ~~**`'event'` is missing from three `entity_type` allowlists AND from two
  policy helpers — that is five places, not three.**~~ **DONE, Phase 3 Task 1,
  AND THE COUNT IN THIS HEADLINE WAS WRONG IN BOTH HALVES.** Measured out of
  the catalogue rather than by hand:

  * there are **FOUR** `entity_type` CHECK constraints, not three --
    `merge_candidates_entity_type_allowed` was never written down anywhere;
  * there are **SIX** `case p_entity_type` dispatches in `private`, not two --
    `entity_is_visible`, `entity_is_manageable`, `entity_is_live`,
    `entity_org_unchanged`, `dedup_entity_table`, `dedup_mergeable_columns`.
    `entity_org_unchanged` alone carries twelve arms.

  So the true count was **ten places, not five**, and the way to find that out
  is a catalogue query, which is now
  `tests/integration/crm/entity-dispatch-branches-match-db.test.ts` -- a census
  that asserts the exact arm set of all six AND that the set of dispatches it
  found equals the set it expects, so a seventh added later fails rather than
  being skipped.

  **WHAT WAS ACTUALLY WIDENED:** the two custom-field CHECKs, and
  `entity_is_visible` / `entity_is_live` / `entity_org_unchanged`.
  `entity_is_manageable` is Task 2's, in the same migration that seeds
  `manage_events`. The two merge CHECKs and the two dedup helpers were
  DELIBERATELY NOT widened -- see the open decision below. The original text
  follows.

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

- **OPEN DECISION, taken by Phase 3 Task 1 and re-filed here rather than
  closed: `merges.entity_type` and `merge_candidates.entity_type` were NOT
  widened to include `'event'`. Events are not dedup-screened and not
  mergeable at MVP.** The entry above asked for three CHECKs; two were
  widened and the third was refused, with the argument written onto
  `merges_entity_type_allowed` and `private.dedup_entity_table()` in the
  database so nobody has to find this file first. The argument:

  * `20260829020000`'s DECISION 1 already established that a name is only ever
    a **fuzzy** signal — "two venues called The Social in two cities are two
    venues";
  * an event's name is weaker still: a recurring club night shares its name
    with every previous instalment **by design**, so a name match on events is
    close to noise;
  * `public.events` has no `email` column, so `exact_email` — the only branch
    that can ever auto-merge — is unreachable for events by construction.
    Every candidate pair would be `fuzzy_name`, and a review queue full of
    noise trains users to dismiss it;
  * widening the allowlist without wiring a reachable merge path would ship a
    permission the product can never exercise, which reads as a working
    control and is worse than a narrow allowlist.

  **Consequences, all carried out in Task 1 rather than left implied:**
  `private.dedup_entity_table` and `private.dedup_mergeable_columns` get no
  `'event'` branch (and their comments, one of which promised one, are
  corrected); `lib/crm/dedup.ts`'s `MERGEABLE_COLUMNS` gains no entry;
  `MERGE_ENTITY_TYPES` stopped being an alias of `CUSTOM_FIELD_ENTITY_TYPES`
  and is now its own five-value tuple; and the Phase 3 event create action
  must **not** call `screenAfterCreate`.

  **What would change the answer:** a duplicate-event problem reported by a
  real customer, or an event gaining a natural identity key (a ticketing
  provider's event id, say) that is exact rather than fuzzy. Revisit then, as
  a product decision with a diff — not as a fix for a red test. Asserted by
  `tests/integration/crm/entity-dispatch-branches-match-db.test.ts`, which
  checks the ABSENCE of the two branches deliberately.

- ~~**`ENTITY_PATH_SEGMENT.event` points at `/[orgSlug]/events`, which does not
  exist until Phase 3 Task 3.**~~ **DONE** — Task 3 landed the list and Task 4
  the detail page, so both the segment and the `/{orgSlug}/events/{id}` shape
  `entityHref()` builds now resolve. (`public.activity_events` still emits no
  event rows; that is the separate bullet below and is Task 6's.) The original
  entry follows.

  It was a known dangling link, added in Task 1 because
  `otherHref()` (`lib/crm/activity.ts`) and `entityHref()` (`lib/crm/dedup.ts`)
  are total over that record and a missing key would put `undefined` in a URL
  rather than produce a 404. Nothing reaches it today: the only route in is a
  timeline entry on an event, and `public.activity_events` does not union
  `public.events` until Task 3 either. Delete this bullet when the route lands.

- ~~**`public.activity_events` does not know about events yet.**~~ **DONE,
  Phase 3 Task 6** — and by Task 6 rather than Task 3, which is what the
  original text guessed. `20260901030000` adds FOUR sources (events in the
  subjects CTE; `event_lineup` from the event side and from the artist side;
  `events.venue_id` from the venue side) and `20260901031000` adds the
  `status_changed` kind over `public.event_status_changes` (founder Q33).
  Assertions are in `rls_phase3_events.sql` §§ EM-EQ, not in
  `rls_phase2_crm.sql` § X. The original entry follows.

  `20260829040000` unions the five Phase 2 tables. Task 1 widened
  `ActivitySubjectType` (it is an alias of `CustomFieldEntityType`) and gave
  `SUBJECT_NOUN` its `event` entry, so the renderer is total over the union
  before any row can arrive — but the view emits no event rows. Phase 3
  Task 3 owns adding them, and `rls_phase2_crm.sql` § X is where the
  assertions go.

- ~~**`private.entity_is_visible()`'s `'event'` branch has no behavioural test
  through a real session.**~~ **DONE, Phase 3 Task 2**, and it grew a second
  half on the way. `supabase/tests/rls_phase3_events.sql` § EK drives *both*
  `entity_is_visible` and `entity_is_manageable` with `'event'` under real
  JWTs — `pstd1` gets `true/true` on their own event, `false/false` on
  `pstd2`'s and on a BETA one, and `false` when their own event is named
  under the wrong organisation id (the cross-tenant hole no foreign key can
  reach, `SECURITY.md` § 10); `pmanager` is the full-scope positive control on
  the same row § EK2 refused.

  **The assertion that carries the most is EK6, and it was not in the brief.**
  `pfinance` is full-scope and holds `view_crm` and NOT `manage_events`, so
  they get `visible=true, manageable=false` **on the same row** — which is
  only possible if the two dispatches really consult different keys. A
  dispatch that ignored the key, or that copy-pasted `view_crm` into the
  manageable arm, answers `true/true` and goes red there and nowhere else.

- ~~**PHASE 3 TASK 2 OWES `PERMISSION_FOR_ENTITY.event` A TRIPWIRE.**~~
  **DONE, Phase 3 Task 2**, in the same commit that seeds `manage_events` and
  adds `private.entity_is_manageable()`'s `'event'` arm, as this entry
  required.

  **It was MOVED, not extended, and the reason is the second half of the
  finding.** The old mirror lived in `tests/unit/crm/source-shape.test.ts` and
  had two independent blind spots: it iterated its OWN hardcoded five-entry
  map rather than `PERMISSION_FOR_ENTITY` (so Task 1's sixth entry was
  asserted in neither direction), and it read
  `20260828120500_crm_policy_helpers.sql` **as text** — the file that first
  *created* the function, which stopped being what is deployed the moment
  `20260901010000` replaced it with `create or replace`. Extending the map
  would have closed the first and left the second.

  The replacement is
  `tests/integration/crm/permission-for-entity-matches-db.test.ts`. It
  iterates the real table; reads the deployed body through
  `pg_get_functiondef()`; asserts the two key sets are **equal**, so a seventh
  entity type added to either side alone is red; checks every key it names
  exists in `public.permissions` (a typo in either mirror fails *closed*, which
  is the invisible direction); asserts `manage_events` is granted to exactly
  the six roles Q29 named; and drives the dispatch **behaviourally** as a
  Booker — who holds `manage_events` and `manage_artists` and not
  `manage_venues`, and is therefore the one role that can tell "the key is
  chosen per entity type" from "the key is ignored". A comment block stands
  where the old describe was, saying all of this, so nobody re-adds it.

  **AND THE MOVE COST A CI GATE — stated here because it was stated nowhere
  when the move was made (fix round 1, review finding F.2).** CI runs
  `pnpm exec vitest run tests/unit` and nothing else
  (`.github/workflows/ci.yml`, "Unit tests"), so everything under
  `tests/integration/` — which needs a live local Supabase stack over HTTP —
  runs on a developer's machine via `pnpm test` and **on no pull request at
  all**. Moving the mirror there made it better and made it invisible to the
  gate that fires on every PR.

  So the check is now **split, deliberately**, and neither half subsumes the
  other:

  * **unit, runs in CI on every PR** —
    `tests/unit/crm/source-shape.test.ts`, "PERMISSION_FOR_ENTITY is total and
    names only real permission keys": the TS table is total over
    `CUSTOM_FIELD_ENTITY_TYPES`, and every key it names appears as a seeded
    `('<key>', <bool>,` row in `supabase/migrations/`. That catches a typo, a
    dropped entry, or a seventh entity type shipped without its mapping, on
    the PR that introduces it. Measured: renaming the value to
    `manage_evnets` fails it with the key named in the message. It
    deliberately does **not** re-implement the mapping — a hardcoded expected
    mapping here is exactly what was wrong before.
  * **integration, runs locally** — the mirror above, which is the only half
    that can ask whether the TS table and the **deployed** dispatch agree
    about *which* key each entity type resolves to.

  **The underlying gap is not this test's.** Nothing in `tests/integration/`,
  the psql/HTTP suite or Playwright runs on a pull request, which `CLAUDE.md`
  § Current state already records as "a deliberate decision nobody has made
  yet". Wiring a Supabase stack into CI is that decision and its own change.

- **THE ARTIST END OF A LINEUP ROW HAS NO DATABASE GUARD AGAINST A
  SOFT-DELETED ARTIST, DELIBERATELY — and the application half does not exist
  yet.** `20260901011000`'s three `event_lineup` write policies check the
  EVENT and never `public.artists`, for `20260828235000`'s reason: a policy
  predicate is evaluated as the caller, so an `artists.deleted_at` term would
  collapse "the artist is deleted" into "I cannot see the artist" and start
  refusing legitimate writes by a record-scoped user who owns the event and
  not the artist. `rls_phase3_events.sql` § EH measures exactly that: `pstd1`
  cannot even *see* the artist (EH1), books them anyway (EH2), and the artist
  is soft-deleted (EH4).

  Cross-tenant is covered — `event_lineup_artist_fkey` is composite and
  refuses it for every writer including `postgres` (§ EF4b). **Soft-deleted is
  not, and nothing but `lib/crm/events.ts`'s `liveInOrg(supabase, "artists",
  org.id, artistId)` will ever refuse it. Phase 3 Task 5 owns writing that
  call, and until it lands the product has no guard at all.** Do not delete
  that call later believing a policy is behind it; § EH is the assertion that
  says so out loud, and EH5 asserts structurally that no lineup policy
  expression mentions `artists`.

- ~~**`public.events` and `public.event_lineup` have FK-covering indexes only,
  and Task 2 measured what that costs.**~~ **DISCHARGED, Phase 3 Tasks 3 and
  5.** `20260901020000` adds the four `(organisation_id, <sort>, id) include
  (owner_user_id) where deleted_at is null` indexes the events list declares in
  `backedBy`, and `20260901021000` adds the lineup's. `rls_phase3_events.sql`
  §§ EX and EL look every one of them up in `pg_class` and assert the shape, so
  a `backedBy` naming an index that does not exist is red. **Two honest
  residues, both filed with owners elsewhere in this file:** the
  `include (owner_user_id)` benefit did NOT reproduce when re-measured (Task 3),
  and the venue's "Events here" list is O(tenant between cursors) because no
  index leads on `venue_id` and can also serve the ordering. The Task 2
  measurement follows, as the baseline those were measured against. `EXPLAIN (analyze, buffers)` as a
  record-scoped user (`pstd1`), on the suite's fixtures — 11 ALPHA events, 8
  ALPHA lineup rows:

  * a 50-row page of `events` ordered `starts_at desc, id desc` takes an
    **Index Scan on `events_organisation_id_idx` followed by a Sort**, with
    `Rows Removed by Filter: 9`. No index can serve the ordering, so every
    page is a full sort of the tenant's events.
  * the `event_lineup` page's parent check is a **hashed SubPlan containing a
    Seq Scan on `events`** (`Rows Removed by Filter: 12`). The lineup's own
    access happened to use `event_lineup_event_artist_live_unique`, whose
    leading column is `event_id` — an accident of that partial unique index,
    not a list index.

  The **good** half is the half that was designed: every
  `permitted_organisations` / `full_scope_organisations` set appears as a
  **hashed SubPlan or InitPlan**, evaluated once per statement, never per row.
  That is the property `rls_phase3_events.sql` EB12-EB14 guard structurally.

  Phase 3 Task 3 owns the `(organisation_id, <sort>, id) include
  (owner_user_id) where deleted_at is null` set, declares the sorts and can
  measure against this baseline.

- **THE RECORD-SCOPE TERM IN AN UPDATE POLICY CANNOT BE MEASURED WHILE THE
  SELECT POLICY CARRIES ITS OWN COPY — and the five Phase 2 entity tables have
  no assertion that can see theirs.** Found in Phase 3 Task 2's mutation run:
  removing the disjunction from BOTH clauses of
  `events_update_manage_events` left the whole suite green (999 psql
  assertions, 195 HTTP checks, zero failures). Measured on this stack:

  ```
  UPDATE policy mutated, SELECT intact, new owner = pstd2    -> 42501
  UPDATE policy mutated, SELECT intact, new owner = pmanager -> 42501
  BOTH policies mutated, new owner = pstd2                   -> UPDATE 1
  ```

  PostgreSQL applies the SELECT policies both to the rows an UPDATE reads and
  to the NEW row it writes, so `events_select_view_crm`'s copy of the term was
  answering the whole time. `rls_phase3_events.sql` ED11–ED16 now lift the
  SELECT policy's disjunction for four statements and ask the UPDATE policy
  alone, restoring and asserting the restore — the § Y / P11 discipline.

  **`companies`, `contacts`, `agencies`, `artists` and `venues` have exactly
  the same policy pair and no equivalent lift** (`rls_phase2_crm.sql` § D and
  § G are written the same way § ED was). Their UPDATE policies' record-scope
  terms are therefore untested in isolation today. This is NOT a live defect —
  the terms are present and the SELECT policy backstops them — but it is five
  more places where a "simplification" would pass every gate. One
  parameterised lift over all six tables would close it; whoever writes it
  should make it fail first, on each table, before believing it.

  **OWNER: Phase 4's first task, alongside the `*_links` tables it is about to
  add** (scheduled by Phase 3 Task 8, 2026-08-31). Phase 4 adds five more
  child tables with the same policy pair, so the parameterised lift is worth
  writing when it can cover eleven tables rather than six, and writing it any
  later means writing it over more. **It is not a live defect and it does not
  block this phase's merge** -- the terms are present and the SELECT policy
  backstops them; what is missing is the assertion that would notice their
  removal.

- **`20260901001000`'s comment on `private.entity_org_unchanged()` named the
  wrong migration for the `event_lineup` arm, and the correction is a
  re-issued `comment on function` rather than an edit.** It said the arm would
  arrive in `20260901010000`; it arrived in `20260901011000`, with
  `event_lineup_update_via_event`, which is the only thing that calls it —
  "with the policy that needs it" is the rule and the policy is there.
  `20260901010000` is the file the permission KEY had to be in. Task 1's
  migration was not edited (it must not be); `20260901011000` re-issues the
  comment with the correction written into it. Nothing to do — this entry
  exists so the next reader does not "fix" the comment back.

- ~~**`tests/unit/crm/source-shape.test.ts` is RED on any CRLF checkout, and
  was red at Phase 3 Task 1's starting commit (`00a4790`) before that task
  touched anything.**~~ **THE LOCAL HALF IS DONE, Phase 3 Task 1.** That
  file's single multi-line `toContain` assertion matched an escaped
  newline against source Git checks out with CRLF on Windows (`.gitattributes` sets no
  `text` policy and `core.autocrlf` is on), so it failed against perfectly
  correct `lib/crm/artists.ts`. Its `read()` helper now normalises `\r\n`
  to `\n` before any assertion sees the source, which weakens nothing --
  no assertion in that file is about line endings -- and `pnpm test` is
  green again (927/927).

  **THE REPOSITORY-WIDE HALF IS STILL OPEN, and it is the one that will
  bite again.** Nothing stops the next multi-line source-text assertion in
  a different file hitting exactly this, and the underlying cause is
  unchanged: with no `text` policy in `.gitattributes`, what is on disk
  depends on each developer's `core.autocrlf`, so a test can be green in
  CI and red on a laptop with nothing wrong in either. The fix is a
  `.gitattributes` line, which rewrites every file's line endings in one
  commit and therefore wants to be its own change with nothing else in it.
  Whoever takes it should grep for other multi-line `toContain` assertions
  over source text first.

### Opened by Task 3 (the events list surface)

- **`include (owner_user_id)` bought NOTHING measurable on the events list page
  query, and Phase 2's headline number for it does not reproduce.**
  `20260829000000` and the Task 3 brief both justify the INCLUDE with "without
  it a Standard User's page costs a heap fetch per candidate row (measured
  3.170 ms vs 1.545 ms in Phase 2)". Re-measured for real on 24,998 live events
  in one tenant, as `authenticated` with a record-scoped claim set, the same
  index with and without the INCLUDE, each run twice warm:

  | | exec | buffers | plan |
  |---|---|---|---|
  | without `include` | 0.566 ms | shared hit=14 | Index Scan Backward |
  | with `include`    | 0.484 ms | shared hit=14 | Index Scan Backward |

  Identical plan, identical buffer count, and the difference is inside the
  run-to-run noise. The mechanism is why: an INCLUDE column only avoids a heap
  fetch in an **Index Only Scan**, and `EVENT_SELECT` names nine columns, so
  the heap tuple is fetched for the output regardless and the record-scope qual
  is evaluated on a row that is already in hand. The INCLUDE is kept anyway,
  for shape consistency with the five Phase 2 entities and because a narrower
  future query (a `count`, an existence probe) could still use it — but it
  costs ~1.9 MB of index on 25k rows and the justification in three files is
  currently stronger than the measurement.

  **What to do:** re-measure the Phase 2 contacts claim the same way. Either it
  reproduces on a query shape this one does not have (in which case say which),
  or the sentence should be corrected in **`20260828180000`, `20260829000000`
  and `lib/list/spec.ts`** together. Do not drop the INCLUDEs on the strength of
  this one measurement.

  **`20260901020000` is NOT on that list** (fix round 1, review Important 2).
  The first version of this item listed it — a file this task wrote in the same
  series of commits, whose header at the time pasted an AFTER plan with a
  `Heap Fetches: 0` line that an `Index Scan Backward` cannot emit, and asserted
  the very benefit the table above measures as absent. That header has since
  been corrected in place (a comment-only edit to an unpushed migration; the
  four `create index` statements are byte-identical) and now carries the real
  plan and the real INCLUDE finding. It is the one file in the family that
  already says the measured thing.

- **`§ EX` guards the events indexes only. The other five entities' `backedBy`
  names are still unasserted.** `lib/list/spec.ts` has required `backedBy` to
  be "a real index name" since Phase 2 and nothing checked it until Task 3;
  `supabase/tests/rls_phase3_events.sql` § EX now checks the four that
  `lib/crm/events-list.ts` names. The fifteen names in `contacts-list.ts`,
  `companies-list.ts`, `artists-list.ts`, `agencies-list.ts` and
  `venues-list.ts` have the same exposure — a rename in a later migration
  leaves every gate green and the list back to a Seq Scan plus a top-N sort of
  the whole tenant. § EX is written so the same six assertions parameterise
  over a table name; the cheap version is to lift them into
  `rls_phase2_crm.sql` for the other five.

- **The count query beside every list page is still O(tenant), and these
  indexes do not change that** — re-measured on the events fixture with all
  four in place: 7.42 ms / 478 buffers for `count(*)` over 12,373 visible rows,
  against 8.72 ms / 478 before them. Same Seq Scan, same buffers. This is
  already recorded in `lib/list/query.ts` ("it is the one part of this page
  that is O(tenant)"); it is repeated here because the page query's 20x
  improvement makes it easy to conclude the whole page is now indexed, and the
  count is what will dominate a large tenant's list. It runs in parallel with
  the page and fails independently, so the ceiling is latency, not a broken
  page.

- ~~**NEITHER events route has a working destination yet:
  `/{orgSlug}/events/new` AND `/{orgSlug}/events/{id}` both 404 until
  Task 4.**~~ **DONE, Phase 3 Task 4**, which landed `/events/new`,
  `/events/{id}` and `/events/{id}/edit`. The read-only-at-the-route
  assertion the Task 3 brief asked for and had nowhere to run was walked in a
  browser and is recorded in `task-4-report.md` § 4. **THE PERMANENT SPEC IS
  STILL OWED** — see "A permanent Playwright spec for events" below, which is
  where that third debt now lives rather than inside a struck-through item.
  The original entry follows.

  The create route was the obvious half — the "New event" button is a `<Link>` for a caller who holds
  `manage_events`. The larger half, corrected in fix round 1 (review Minor 3),
  is that **every row's Name link on both routes** points at the detail page
  that does not exist, so on a populated workspace the dead surface is 25 links
  per page rather than one button. It is worst for `read_only`, who gets no
  "New event" link at all and for whom therefore *every* interactive element on
  both routes is currently dead.

  Nothing is reachable that should not be, and nothing is writable: the INSERT
  policy (`20260901011000`, asserted at `rls_phase3_events.sql` EC9 for
  `read_only`, EC4/EC7 for finance and marketing) refuses the write from any
  client regardless. The columns are brief-mandated and Task 4 owns both routes;
  what was wrong was the disclosure, not the links.

  **Task 4 owes three things here:** the two routes; a repeat of
  `golden-path.spec.ts:114`'s shape ("a read-only member cannot reach the create
  form, not just the button") for events, which is the assertion the Task 3
  brief asked for and that had no route to run against; and a permanent
  Playwright spec covering the events list, since Task 3's browser walk was a
  temporary spec (kept at
  `.superpowers/sdd/phase-3-events/task-3-browser-walk.spec.ts` for
  reproducibility) and its findings live only in a report.

### Opened by Task 4 (the event write path and the detail page)

- **A `<select>`'s `defaultValue` DOES NOT SURVIVE REACT 19'S POST-ACTION FORM
  RESET, and five other selects in `components/crm/` are written the way the
  event form was before it was fixed.** Measured in a browser on the event
  form: type a name, pick "Club night", "On sale", a venue and a room, mistype
  the ticket link, submit — the four text fields come back correctly and all
  four selects snap back to the options the page first rendered with ("Other",
  "Draft", no venue, no room). Retrying the submit then SAVES four values the
  user never chose, which is worse than the text-field version of this defect
  (`lib/forms.ts`'s header): losing what you typed is visible, silently saving
  something else is not.

  **The mechanism, so nobody has to re-derive it.** React syncs an
  `<input>`'s `defaultValue` prop to the DOM `defaultValue` PROPERTY on every
  update, so `form.reset()` restores the echoed value. A `<select>` has no such
  property: its default is the `selected` ATTRIBUTE on an `<option>`, which
  React writes at MOUNT and then leaves alone unless `multiple` changes. So the
  reset restores the mount-time option no matter what the echo says. The fix on
  the event form is a `key` on the select that includes its shown value,
  forcing a remount — the same mechanism as `merge-form.tsx` keying its field
  rows on the survivor (final review I-2).

  **THE FIVE THAT ARE STILL WRITTEN THE OLD WAY**, found by grep and NOT
  re-measured in a browser one by one — the mechanism is identical and the
  markup is the same shape, so this is inferred rather than observed for each:

  | file | control | what a refusal loses |
  |---|---|---|
  | `representation-panel.tsx:588` | `contactId` (add form) | the named agent |
  | `representation-panel.tsx:826` | `contactId` (edit form) | the named agent |
  | `link-panel.tsx:322` | the record to link | the chosen record |
  | `custom-field-editor.tsx:257` | `fieldType` | the field type |
  | `custom-fields-panel.tsx:328` | a `select` custom field's value | that value |

  Deliberately NOT fixed here: it is a diff across four reviewed Phase 2
  components for a defect this task did not introduce, and each needs its own
  browser walk to confirm the before and the after. It is a real, live defect
  in shipped code and it should be taken as one change with one walk, not
  folded into a feature.

  **OWNER: Phase 4's first task, as its opening change** (scheduled by Phase 3
  Task 8, 2026-08-31). Phase 4 builds tasks/meetings/notes and therefore builds
  more `<select>`-bearing panels of exactly this shape; fixing the five before
  writing the sixth is the only ordering in which the fix is cheap and the
  walk is one walk. It is NOT Phase 7 -- there is nothing entitlement- or
  admin-shaped about it -- and it is not "whenever someone opens the file",
  which is what this entry said for a phase and which produced no fix.

- **A `<select>` VALUE SET BEFORE HYDRATION IS DISCARDED, which is the entry
  above one step earlier in the lifecycle -- measured in a browser, Phase 3
  Task 8.** The `key` fix means React MOUNTS the select with the right
  `selected` option; it also means that anything which set the DOM value
  between the server-rendered markup arriving and that mount is overwritten.

  **Measured, twice, on `/events/{id}/edit`.** Interacting with the three
  `<select>`s (venue, room, status) the instant the markup arrived: the form
  posted the LAST value set and reverted the first two -- the event's venue and
  room were unchanged while its status changed, from a submit in which all
  three had been chosen. Repeating the identical walk with one `await` for a
  server-rendered value before the first selection: the form posted
  `venueId=E2E Basement room="" status=sold_out` and all three applied.
  Transcript in `.superpowers/sdd/phase-3-events/task-8-browser-walk.spec.ts`
  (WALK 1) -- the `await` is in the file with the finding written on it.

  **Why it is filed and not fixed.** The two obvious fixes are both worse than
  the defect. Removing the `key` reintroduces Task 4's measured defect (a
  refused submit silently saving four values the user did not choose), and
  making the form controlled abandons the property these forms exist to have
  -- they work with JavaScript disabled (`components/crm/event-form.tsx`'s
  header). The honest fix is to not accept input before hydration: disable the
  selects until mount, or render them from a component that does not remount.
  Both are a change to the shared form primitives, not to one form.

  **How likely is a human to hit it?** Less likely than an automated script and
  not impossible: it needs an interaction inside the hydration window, which on
  a cold route over a slow connection is measured in whole seconds, and a user
  who tabs straight to a `<select>` and presses a letter key is doing exactly
  what the script did. **It is silent when it happens**, which is what makes it
  worth an entry: the form posts a value the user did not choose and shows them
  a saved record.

  **OWNER: Phase 4's first task, in the same change as the five selects above**
  -- the mechanism is the same and the walk is the same walk.

- ~~**A permanent Playwright spec for events is still owed.**~~ **DONE, Phase 3
  Task 8** — `tests/e2e/events.spec.ts`. Four of the five acceptance criteria
  named below are now permanent assertions (the soft-delete/restore round trip
  is in `tests/e2e/tenant-breakout.spec.ts`); the fifth, the no-JS submit, is
  NOT and is the one thing this entry leaves open — see the note at the end.
  The original entry follows.

  Task 3's walk was temporary and Task 4's is too — `.superpowers/sdd/phase-3-events/task-4-browser-walk.spec.ts`,
  kept for reproducibility and deliberately outside `tests/e2e/` because one of
  its five tests DROPS AND RE-ADDS `events_ticket_link_is_http` (the only way
  to observe the render path for a value the CHECK refuses) and because it logs
  more than it asserts. So the five acceptance criteria — the echo, the
  soft-delete/restore round trip, `read_only` refused at the route, the no-JS
  submit, and the inert `javascript:` link — are green in a transcript in a
  report and in no gate. The permanent version asserts rather than logs, does
  not reshape the schema, and belongs beside `golden-path.spec.ts`.

  **WHAT IS STILL NOT IN A GATE: the no-JavaScript submit.** Every form in
  `components/crm/` is uncontrolled precisely so it works with scripting off,
  and no test anywhere runs with it off — Playwright's
  `javaScriptEnabled: false` context option would do it and is one line, but a
  page whose Server Actions are progressive-enhancement-only needs its own
  assertions rather than a flag on the existing suite. **Owner: Phase 4's
  first task**, in the change that fixes the five `<select>`s above — that is
  the change that has to prove the no-JS path still works anyway.

- **The room picker offers every live room in the workspace, bounded at
  `LINK_PANEL_LIMIT * 10` = 1,000, and there is no cascade.** With JavaScript
  off there is nothing to repopulate the room `<select>` when the venue changes,
  so the honest control is every room grouped under its venue with `<optgroup>`
  and a server-side refusal for a mismatch. That is correct and it does not
  scale: a workspace with 100 venues and eight rooms each renders an 800-option
  select. The right answer is the same search-backed picker `LINK_PANEL_LIMIT`
  already names as owed, plus a progressive JavaScript enhancement that filters
  the groups live — an enhancement, never the only way the control works.

- **`loadEvent` costs up to three round trips.** The row, then the venue name,
  then the room name, each a `maybeSingle()` by primary key and each skipped
  when the column is null. A PostgREST embed would do it in one and was
  rejected for `loadVenueNames`' reason (an embed of a row the caller cannot
  read comes back null anyway, so it buys a round trip and costs the same
  branch). Worth revisiting only if the detail page's latency is ever measured
  and found wanting; it is recorded so nobody concludes the second and third
  queries were an oversight.

### Opened by Task 5 (the lineup builder)

- **`lib/list/cursor.ts` IS SERVER-ONLY IN PRACTICE AND NOTHING SAYS SO: any
  Client Component that renders `ListPager` throws at hydration.** Measured in
  the Rule 17 walk, in the browser console:

  ```
  [browser] Uncaught TypeError: Unknown encoding: base64url
  ```

  `ListPager` → `buildListHref` → `encodeCursor` →
  `Buffer.from(...).toString("base64url")`, and the `Buffer` shim in the client
  bundle does not implement that encoding. It throws while React is hydrating,
  so **the whole page's client tree never hydrates** — every `useActionState`
  pending state, every in-place update, and every `<Link>` on the page stop
  working.

  **It is invisible for the worst possible reason.** Every form in
  `components/crm/` is uncontrolled by design, so it posts natively and React 19
  falls back to a full round trip; the surface still SAVES, still shows field
  errors, still echoes values. What breaks is the pager — a click on "Next" does
  nothing at all — which is how the walk found it, and nothing else in the
  repository could have.

  **Fixed for the lineup by splitting the panel** (`lineup-panel.tsx` is a
  Server Component; `lineup-forms.tsx` holds the four forms), and guarded by
  `tests/unit/crm/source-shape.test.ts`'s "the panel is a SERVER component"
  assertion — which is specific to that one panel.

  **THE GENERAL TRAP IS STILL OPEN.** `lib/list/params.ts` deliberately is NOT
  `server-only`, because `components/list/list-toolbar.tsx` is a Client
  Component that imports `buildListHref` — and it gets away with it only
  because it never passes a `cursor` override, so `encodeCursor` is never
  reached. The next author who renders a pager inside a client panel, or who
  gives a prefixed list a toolbar that carries a cursor, meets the same throw.

  Two candidate fixes, neither taken here because each is a change to a
  well-tested shared module and deserves its own diff:

  1. Make the codec isomorphic — `toString("base64")` plus the three-character
     URL-safe substitution, and the mirror on the way in. Cheap, and it removes
     the hazard entirely. `tests/unit/list/cursor.test.ts`'s 56 tamper cases are
     the safety net.
  2. Make the failure LOUD instead — split the cursor codec into its own
     `server-only` module so a client import is a build error. Bigger, and it
     needs `buildListHref` to stop calling `encodeCursor` unconditionally.

- **`public.event_lineup`'s table comment overstates the ordering, and the
  migration cannot be edited to say so.** 20260901000000 says the ordering is
  `(position, created_at, id)`. The RENDERED order is `(position, id)`, and it
  cannot be anything else: `fetchListPage` orders by the spec's one sort column
  and then by the primary key, which is the whole shape a keyset cursor can
  carry (`lib/list/query.ts`, `buildPage`).

  Measured in the walk: two slots both at position 0, added B-then-A, render A
  first, and go on doing so across three reloads. So the tie-break is a
  `gen_random_uuid()` — **total and permanent, and not insertion order**.
  Stability is the property the panel needs and it holds; the comment is the
  part that is wrong.

  `lib/crm/lineup-list.ts` and `components/crm/lineup-panel.tsx` both say this
  in as many words, and `LINEUP_SELECT` deliberately does NOT select
  `created_at` any more (it was selected to support the claim). The migration's
  comment should be corrected by the next migration that has business with this
  table — never by editing 20260901000000.

- **The lineup's REMOVED rows are capped at `LINK_PANEL_LIMIT` = 100 with no
  pager.** The live bill is a real keyset surface; the `<details>` under it is a
  capped read, ordered most-recently-removed first. Past a hundred removals on
  one event the disclosure shows the hundred most recent and says so. A second
  paginated surface would need a third query-string namespace on a page that
  already has two, for a tail nobody scrolls — recorded rather than built.

- **The artist picker offers the alphabetically first 100 live artists and does
  not exclude the ones already on the bill.** The cap is `LINK_PANEL_LIMIT`'s
  own named stopgap and the answer is the search-backed picker that constant
  already says is owed. The exclusion is a separate decision and is deliberate:
  the panel is PAGINATED, so an exclusion list built from the page in hand would
  hide artists that are on the bill and offer others that are, arbitrarily by
  page. The duplicate is refused by
  `event_lineup_event_artist_live_unique` and by a sentence
  (`LINEUP_DUPLICATE_ARTIST`) instead. If the picker ever becomes search-backed,
  exclusion becomes cheap and should be revisited then.

- **CLOSED IN FIX ROUND 1: the record-scope disjunctions in the two
  `event_lineup` write policies now have assertions, and here is what still
  holds.** The original entry said the terms could not be observed at all. That
  was true of the suite as shipped and is no longer true of the suite:
  `rls_phase3_events.sql` § EF20-EF29 lifts the two masking SELECT policies
  (`events_select_view_crm`, then `event_lineup_select_via_event`) inside one
  transaction, asks the write policies on their own, restores both and asserts
  the restores structurally and behaviourally. Measured: removing the INSERT
  policy's disjunction now turns **EF21** red (`denied(42501)` → `ok(1)`);
  removing the UPDATE policy's turns **EF24** and **EF26** red.

  **What remains true, and is the part worth keeping:** the terms are each
  other's backstop, so **no single-policy mutation can turn the HTTP probe
  red** —

  | schema | `pstd1` POSTs a slot on pmanager's event |
  |---|---|
  | shipped | **403** |
  | record scope removed from `event_lineup_insert_via_event` only | **403** |
  | record scope removed from `events_select_view_crm` only | **403** |
  | removed from **both** | **201** — the slot lands |

  A reader who mutates one policy, sees the HTTP block green and concludes the
  probe is toothless is reading it wrong: the probe measures the composition,
  and the psql lift is what measures each term alone. Recorded because the same
  masking applies to every child table in this schema, and § ED11-ED16 plus
  § EF20-EF29 are now two worked examples of the technique.

- **`20260901021000`'s header sends a reader to the wrong file for
  `applyFilters`.** It says "`applyFilters` in lib/crm/lineup-list.ts pins the
  event by equality". The claim is true about the query and false about the
  file: `LINEUP_LIST` has `filters: {}` and the string does not appear in that
  module at all — the callback is in `loadLineupForEvent`, `lib/crm/queries.ts`.
  This repository treats a migration comment as load-bearing and a reader who
  greps the named file finds nothing.

  **Not corrected in place**, because no existing migration is edited — the same
  discipline 20260901011000 followed when it found a stale file reference in
  20260901001000's deployed comment. § EL2's header in
  `supabase/tests/rls_phase3_events.sql` (a test file, not a migration) carries
  the correction now and names the misattribution explicitly; the next migration
  with business on `public.event_lineup` should restate the index comment with
  the right file.

- **A permanent Playwright spec for events is STILL owed** — Task 3 filed it,
  Task 4 re-filed it, and this task re-files it again.
  `.superpowers/sdd/phase-3-events/task-5-browser-walk.spec.ts` is the third
  throwaway. It is better than its predecessors in one respect worth keeping
  when the permanent version is written: it resets the lineup in `beforeEach`
  and plants what each test needs, so no criterion depends on an earlier one
  passing — the first draft did, and two of its five "failures" were that
  coupling rather than the product. It still logs more than it asserts, which is
  what the permanent version must not do.

### Opened by Task 7 (the cross-entity event surfaces)

- **AN ARTIST ON MORE THAN 50 EVENTS DOES NOT SEE THEM ALL, and the panel does
  not say so.** `loadEventsForArtist` (`lib/crm/queries.ts`) is a TWO-STEP read:
  it takes the artist's live `event_lineup` rows ordered `created_at desc, id`
  and capped at `MAX_PAGE_SIZE` (50), then pages `public.events` with
  `.in("id", ids)`. So the panel shows a stable 50-slot WINDOW, paged 25 at a
  time — and it is not "the 50 most recent events", because the date lives on
  `events` and step one cannot order by it.

  **Why it is shaped that way rather than fixed now.** `fetchListPage` reads ONE
  relation. A PostgREST embed filter (`events?event_lineup.artist_id=eq.…`) is
  not reachable through its single-relation contract — the `count=exact` head
  request and the two boundary probes all change shape with an embed, which is
  the same refusal `loadVenueNames` records. Paging `event_lineup` separately is
  a SECOND CURSOR over a second relation ordered by something that is not the
  date the panel sorts by, and `lib/crm/activity.ts`'s header states the rule
  outright: "a second cursor in one codebase is a defect."

  **THE SAME CLASS OF NAMED STOPGAP AS `LINK_PANEL_LIMIT`** (this file's Phase 2
  entries), and it is worse in one respect and better in another: worse because
  a busy resident DJ crosses 50 events in a couple of seasons, where 100 linked
  companies on one contact is rare; better because the window is deterministic
  and stable between reloads rather than "whatever Postgres returned".

  **THE ON-SCREEN CONSEQUENCE IS A NUMBER THAT IS CONFIDENTLY WRONG, not merely
  a short list** (review fix round 1, M-2). `EntityList` renders `total`
  (`components/list/entity-list.tsx`), and `count=exact` runs over the *capped*
  `id IN (…)` set — `applyScope` reaches the count query as well as the page
  query — so an artist on 200 events gets a count line reading **"50 events"**.
  A user cannot tell that from a genuine 50. Two ways out when this is fixed
  properly: either the real fix above (the count becomes true), or suppress
  `total` on this one surface so the line reads "N events on this page", which
  `ListPage` already supports via `total: null`. Not done now, because
  suppressing it makes the honest surfaces worse to protect the dishonest edge.

  **The shape of the real fix — decide it with the feature, not now.** Two
  candidates, both migrations:

  1. **A `security definer` list function** returning `public.events` rows for
     an artist, joining `event_lineup` inside the function so the caller sees
     ONE keyset-pageable relation. Keeps one cursor. Costs a function that has
     to re-implement the tenant filter and the record-scope term itself, which
     is the thing RLS exists to stop anybody re-implementing — so it needs its
     own psql suite section.
  2. **A denormalised `artist_ids uuid[]` on `public.events`** with a GIN index,
     maintained by a trigger on `event_lineup`. Keeps the read a plain
     `fetchListPage` over one table with a `cs.{…}` filter, and makes the sort
     index reachable. Costs a denormalisation that can drift, so it needs a
     reconciliation check the way any cached column does.

  Neither is guessed at here. Both want measuring against a real booking
  history, and the feature that needs it (an artist's full history, probably
  with its own screen) is the right place to choose.

  **OWNER: the founder, as a product decision; IMPLEMENTATION: deferred to the
  phase that builds an artist's full booking history** (scheduled by Phase 3
  Task 8, 2026-08-31). **It is not scheduled to a phase number on purpose, and
  that is a decision rather than a gap:** both candidate fixes are migrations
  with real costs (a `security definer` list function that re-implements the
  tenant filter, or a denormalised `artist_ids uuid[]` that can drift), and
  choosing between them on an empty database is guessing. **What IS owed
  before then, and is cheap:** the count line currently reads "50 events" for
  an artist on 200, which a user cannot tell from a genuine 50 --
  `ListPage` already supports `total: null`, so suppressing the total on this
  one surface is a one-line honest stopgap. Take that at the next sight of the
  file; take the migration with the feature.

- **Nothing tests that a FAILED upcoming-events query renders the error rather
  than "Nothing coming up"** (review fix round 1, M-1). `loadUpcomingEvents`
  returns a three-way result and `app/(app)/[orgSlug]/page.tsx` renders the
  `Alert` for `unavailable` — the rule this codebase opens `lib/crm/queries.ts`
  with, because "you have nothing on" is a claim about the customer's data and
  making it when the database was unreachable reads as deletion. Collapsing
  that branch into an empty `loaded` turns **nothing** red.

  **Unlike its sibling gap (the hand-written `deleted_at is null`, closed in fix
  round 1 with a soft-deleted fixture row), this one is not cheap**: it needs an
  injected query failure, and this repository has no mechanism for one — no
  network-level fault injection in the Playwright suite, and `tests/unit` is
  pure functions by `vitest.config.ts`'s own rule, so it cannot reach a module
  that imports `@/lib/supabase/server`. The honest options are a seam for
  fault injection (worth having, and a decision bigger than one loader) or
  leaving it reviewed rather than measured. Filed so it is owed to something
  durable rather than to a task report.

- **The venue's "Events here" list is O(tenant between cursors), not O(page).**
  `VENUE_EVENTS_LIST.sort.starts.backedBy` names
  `events_org_starts_at_id_live_idx`, which is `(organisation_id, starts_at, id)
  WHERE deleted_at is null` — so the ORDER BY and the keyset range ARE index
  conditions, and `venue_id = $1` is a FILTER applied over that range. Fine for a
  venue holding a normal share of a workspace's nights; not fine for a workspace
  where one venue holds a small fraction of them, because the scan has to walk
  every event between the cursor and a page's worth of THIS venue's.

  `events_venue_id_org_idx` (20260901000000) exists and leads on `venue_id`, so
  it cannot serve the ordering — naming it in `backedBy` would have been the
  dishonest choice, and `lib/list/spec.ts` requires that field to name the index
  that makes the sort O(page).

  **The fix is one `create index`:** `(organisation_id, venue_id, starts_at, id)
  WHERE deleted_at is null`, mirroring the four in 20260901020000. This task
  ships no migration by its brief, and the number that would justify the ~2MB
  per 25,000 rows has not been measured on a venue-heavy fixture — so it is
  filed rather than added on a guess.

  **OWNER: whoever ships the next `public.events` migration; SCHEDULED: Phase 5
  (finance sits on events and will touch this table), or earlier if a
  venue-heavy tenant appears first** (scheduled by Phase 3 Task 8,
  2026-08-31). **The measurement it is waiting on is named, so it cannot stall
  indefinitely:** `EXPLAIN (analyze, buffers)` of `VENUE_EVENTS_LIST`'s second
  page against a fixture of ~25,000 events in one tenant where the venue under
  test holds under 2% of them. If that comes back O(page) after all, close this
  entry with the number; if it does not, the index is one additive migration
  and `backedBy` moves to it in the same change. **Not a merge blocker for
  Phase 3:** `backedBy` names the index that really serves the ordering, which
  is the honest declaration `lib/list/spec.ts` requires, and the cost is a
  scan length rather than a wrong answer.

- ~~**A permanent Playwright spec for events is STILL owed**~~ **DONE, Phase 3
  Task 8.** `tests/e2e/events.spec.ts` walks create event -> add an artist to
  the bill -> change the venue -> read the activity timeline as a manager, in
  one ordered test, plus four independent ones (the route refusing `read_only`
  at `/events/new`, the standard user's scope note, the status chip's text
  label, and a stored ticket link rendering inert). `tests/e2e/tenant-breakout.spec.ts`
  gained the three pickers and a soft-deleted event on its own fixture row.
  Playwright is 17 -> 34. The throwaway named below is superseded by
  `task-8-browser-walk.spec.ts`, which is the per-role transcript rather than a
  gate. The original entry follows.

  This task moves the line rather than only re-filing it: FIVE of its
  assertions are now permanent, in `tests/e2e/tenant-breakout.spec.ts` (the venue list, the
  cross-tenant event refusal from both slugs — literal 404 under the foreign
  slug, the streamed not-found contract under one's own since the
  loading-skeletons pass — record scope on the list AND on the
  record, the artist history through the lineup, and the workspace home).
  `.superpowers/sdd/phase-3-events/task-7-browser-walk.spec.ts` is still a
  throwaway, and what stays in it is the part a permanent assertion is the wrong
  shape for — "paging one list leaves the other two alone", which is a claim
  about three URLs at once and reads as a `console.log` walk rather than a test
  name. A permanent version of THAT would want its own fixture with enough rows
  to page without `?…_size=1`.

- ~~**The axe golden-path test has no time headroom, and now says so.**~~
  **DONE, Phase 3 Task 8 — the durable fix was taken rather than the budget
  raised again.** `tests/e2e/accessibility.spec.ts` is now one test per page
  (13 pages, four of them Phase 3's), `test.slow()` is deleted, and the
  slowest page in the cold run that followed was 4.1s against its own 60s
  budget. It became mandatory rather than optional the moment this task added
  four pages: eleven pages under one budget is the same failure with more
  headroom spent. **And splitting it paid for itself immediately** — the
  event detail page, scanned on its own for the first time, reported
  `landmark-unique`. See § "Opened by Task 8" below. The original entry
  follows.

  **The axe golden-path test has no time headroom, and now says so.**
  `tests/e2e/accessibility.spec.ts`'s seven-page scan measured **49.6s against
  the config's 60s budget** on a fully warm dev server at this task's HEAD.
  Cold, inside a full `pnpm test:e2e`, it exceeds the budget and fails with
  "Test timeout of 60000ms exceeded" — an EMPTY failure with no violation
  attached, which reads exactly like an accessibility regression and is not
  one. It failed that way twice in this task's gate runs and passed every time
  it was run alone.

  **This task is a contributing cause and not the root one.** `lib/crm/queries.ts`
  grew by ~300 lines and now imports `lib/crm/events-list.ts`, and every CRM
  page imports `queries.ts` — so each of the seven first-hit Turbopack compiles
  got marginally more expensive. The root cause is a single test that does
  seven pages' work under one 60s budget.

  **Papered over deliberately, with `test.slow()` on that one test** (tripling
  its budget, rather than raising `timeout` globally and hiding a real hang in
  one of the fast tests). **The durable fix is to split it into one test per
  page**, so a slow page is named rather than averaged and adding an eighth
  page does not silently spend another test's headroom. Worth doing the next
  time that file is opened.

- **`app/(app)/[orgSlug]/page.tsx`'s two older sections use a bare `<ul>`.** The
  upcoming-events block added here carries `role="list"`, because Safari with
  VoiceOver drops list semantics from a `ul` whose `list-style` is `none` and
  these rows are ruled rather than bulleted. "Where to start" and "Keeping the
  records clean" predate it and were left alone rather than swept into this
  task's diff. Same one-line fix, three places, whenever that page is next
  opened — `components/ui/ruled-row.tsx`'s `RuledList` has the same gap and is
  the better place to fix it once.

### Opened by Task 8 (the Phase 3 exit gate)

- ~~**Two `navigation` landmarks on one page shared the accessible name
  "Pagination".**~~ **FOUND AND FIXED IN THE SAME TASK (Phase 3 Task 8).**
  Recorded rather than dropped, because the way it was found is the reusable
  part. The event detail page is the first in the product to carry two
  `lib/list/` surfaces on one record, so it renders two pagers; axe reported
  `landmark-unique` on `section[aria-labelledby="lineup-heading"] > nav`, and
  a screen-reader user meets that as two landmark-list entries that cannot be
  told apart. The artist detail page has THREE pagers and the venue detail page
  two, so this was never a corner case — it was invisible until the scan was
  pointed at a page that has them. Fixed in `components/list/list-pager.tsx`
  (the label became "Pagination for " plus the spec's own plural noun), which is unique wherever two
  pagers share a page today (lineup entries/entries; fees/events/entries;
  events/entries); `tests/e2e/tenant-breakout.spec.ts` asserts the specific
  name so it cannot revert to a shared literal silently.

  **THE TWO THINGS TO CARRY FORWARD.** (1) It was caught only because the scan
  runs `best-practice` beside the five WCAG tags — axe classifies every
  `landmark-*` rule as best-practice, so the mandated tag set reports ZERO
  violations on that page. That is the second time the same blind spot has hit
  this project (Phase 2's nested `<main>` was the first). (2) A page rendering
  two pagers over the SAME spec would collide again; nothing does today, and
  the scan is what would say so.

- **`loadLinkOptions()`'s `organisation_id` filter is asserted by NOTHING, and
  Task 8 measured that rather than suspecting it.** Removing
  `.eq("organisation_id", organisationId)` from `lib/crm/queries.ts:392` — the
  one query behind the artist picker, the company picker, the contact picker
  and the agency picker — left **every gate green**: vitest 1129/1129, psql
  1083/0, HTTP 197/0, Playwright 34/34.

  **Why nothing sees it.** RLS answers identically for a caller who belongs to
  one organisation, and every user in every fixture that exercises a picker
  belongs to exactly one. The loader's own filter is defence in depth against
  the day a caller is a member of two — which the product supports from MVP
  (`CLAUDE.md` § Tenancy model: the workspace switcher ships at launch), so
  this is not a hypothetical role.

  **THE PROPOSED ASSERTION, which is a fixture change and not a new test file.**
  `tests/e2e/support/fixtures.ts` already builds two organisations; add a FIFTH
  user who is an active member of BOTH (the psql suite's `pmulti` is the same
  idea and is the precedent), sign in as them, and assert that the event form's
  artist picker on org A's slug offers org A's artist and NOT
  `OTHER_ARTIST_NAME`. That single assertion covers all four pickers, because
  they are one query. **Do it in Phase 4's first task**, which adds
  `task_links` and therefore a fifth and sixth picker over the same helper.
  Owner: Phase 4.

  **A weaker unit-level version exists and is not a substitute:** a
  `source-shape.test.ts` census that every `from(<table>)` in `lib/crm/queries.ts`
  is followed by `.eq("organisation_id"` would go red on this mutation and
  would be cheap. It asserts the TEXT rather than the behaviour, which is the
  thing `tests/integration/crm/permission-for-entity-matches-db.test.ts`'s own
  history warns about — take it as a stopgap if Phase 4 slips, not instead.

- **The psql/HTTP suite is blind to `private.entity_is_live()`'s `'event'`
  arm, and the only thing that catches it does not run in CI.** Measured:
  deleting the `when 'event' then ...` branch left the psql suite at 1083/0 and
  the HTTP checks at 197/0, and turned exactly ONE file red —
  `tests/integration/crm/entity-dispatch-branches-match-db.test.ts` (2 tests).
  That file lives under `tests/integration/`, and `.github/workflows/ci.yml`
  runs `pnpm exec vitest run tests/unit` and nothing else, so the branch is
  guarded on a developer's machine and on no pull request.

  This is the CI split already recorded against `PERMISSION_FOR_ENTITY`,
  showing up on a second control — which makes it a pattern rather than an
  incident. **The consequence is concrete:** `entity_is_live('event', …)` is
  what makes a soft-deleted event's custom-field values read-only, so removing
  the arm silently reopens writes to them, and the suite that exists to prove
  event policies would not notice.

  **The cheap half, owed to Phase 4:** `rls_phase3_events.sql` § EG (a
  soft-deleted parent) already has the fixtures — add an assertion there that
  a `custom_field_values` INSERT against a soft-deleted EVENT is refused, with
  the live event as the positive control. **The real half is unchanged and is
  bigger than this entry:** nothing in `tests/integration/`, the psql/HTTP
  suite or Playwright runs on a pull request, which `CLAUDE.md` § Current state
  already records as "a deliberate decision nobody has made yet". Owner: the
  founder for the CI decision; Phase 4 for the § EG assertion.

- **`20260901031000:180` issues a `grant execute` on
  `private.record_event_status_change()` that nothing needs** (Task 6 deferred
  minor, re-filed here with an owner). It is a trigger function; `authenticated`
  never calls it by name, and Task 6's reviewer measured that it is not
  exploitable. **The fix is deleting one line in a NEW migration** — the
  original is pushed and must not be edited — and the assertion worth adding
  beside it is a `schema_invariants.sql` one: no `private` `SECURITY DEFINER`
  trigger function is executable by `authenticated`. That assertion is the
  reason to do it at all, because it closes the class rather than the instance.
  Owner: Phase 4's first migration. Not a live defect.

- **A comment in `components/crm/activity-timeline.tsx:403-406` documents the
  wrong entry.** "THE LABEL, NEVER THE VALUE" belongs to `custom_field_set` and
  now sits above `status_changed`, which was inserted between them (Task 6
  deferred minor). Cosmetic, wrong, and in the file a reader goes to in order
  to learn the rule. One-line fix at next sight of the file.

- **`public.events.ticket_link` cannot hold a `javascript:` value at all, and
  `SECURITY.md` § 3 now says so.** Task 8 tried to plant one as `postgres` for
  a render assertion and could not: `events_ticket_link_is_http` is a
  *validated* CHECK, so it binds every writer, and the table was created with
  it, so there are no older rows. (Task 4's browser walk reached the render
  path by DROPPING and re-adding the constraint, which is why that walk is a
  throwaway outside `tests/e2e/`.) The permanent assertion instead plants a
  value the CHECK admits and `safeHref()` refuses, which measures the property
  that actually protects the render. **Nothing to do** — this entry exists so
  the constraint's own "a row written before it … is still possible" comment is
  not read as describing a reachable state on this column, and so nobody
  weakens `safeHref()` on the strength of it.

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

## Phase 4 — CI decision (blocks Phase 4's start)

- **DECIDE WHETHER CI RUNS THE STACK-DEPENDENT SUITES. Owner: the founder.
  Due: before Phase 4 starts. Added 2026-08-31 (Task 8 exit, condition 3;
  `DECISIONS-QUEUE.md` Q41).** `.github/workflows/ci.yml` runs `pnpm lint`,
  `next typegen`, `pnpm typecheck`, `vitest run tests/unit` and the two scans,
  and **nothing else** — the 1083 psql assertions, 197 HTTP probes, every
  `tests/integration/` file and all 34 Playwright tests need a running Supabase
  stack and run only on a developer's machine, which `CLAUDE.md` § Current state
  already records as "a deliberate decision nobody has made yet".

  **Why it is dated to a boundary rather than left open.** Task 8's mutation M-7
  is the first *measured* cost of the split: deleting `private.entity_is_live`'s
  `'event'` arm — which makes a soft-deleted event's custom-field values
  read-only — left the psql suite at 1083/0 and the HTTP probes at 197/0, and
  the only red was one `tests/integration/` file CI does not run. Phase 4 adds
  five more child tables (`*_links`) whose only guards will be integration
  tests, so the number of controls that no pull request checks grows the moment
  Phase 4 ships. The decision must be made before that, not after.

  **The decision may legitimately be "no"** — a Supabase stack in CI is a
  container pull and minutes per run. But if it is "no", the M-7 class of gap
  needs a psql or HTTP assertion each time a control's only guard would
  otherwise be an integration test, and that obligation is the real cost of
  answering "no". This entry is the scheduled home the Task 8 exit document's
  condition 3 points at; it is not a reminder, it is a gate on Phase 4's start.

  **Task 5 count (the strongest evidence yet, added 2026-09-01).** The
  file-security pipeline (Task 5) is the clearest case, because none of its
  controls is visible to `lint`/`tsc`/`vitest run tests/unit` — the whole point
  of file security is runtime behaviour. **Eight** file-security controls have
  **no** source-only guard and are caught only by a stack suite:
  (1) the `documents_storage_key_shape` CHECK refusing a cross-tenant key
  (psql, `file_access_phase4.sql` A2); (2) the `storage.objects` deny-all fence,
  proven to hold even under a broad permissive grant (psql B1/B2 + HTTP);
  (3) the scan-status transition guard freezing a terminal verdict (psql C1/C2);
  (4) the quarantine download gate — a non-`clean` document yields no URL
  (integration, EICAR to 409); (5) the download audit written *before* the URL —
  every download logged (integration, deterministic count); (6) the cross-tenant
  download to 404 through RLS (integration + HTTP); (7) the `audit_document_action`
  RPC guard — `view_crm` + document-in-org, fail-closed (HTTP 403 probes +
  integration); (8) the schema placement of the audit helper — `private` writer
  unreachable, `public` wrapper guarded (HTTP probes). The **one** file-pipeline
  mechanism that *does* have a source-only guard is the soft-delete's
  `{ count: "exact" }`, caught by `tests/unit/crm/source-shape.test.ts`'s census.
  So a source-only CI leaves **eight** file-security regressions shippable
  green — every mutation this task reproduced red (remove the clean gate, issue
  the URL without auditing, drop the storage-key CHECK, drop the deny-all fence)
  is one CI would miss.

## Phase 4 — operations

Opened by Phase 4 Task 1 (the operations schema — `tasks`, `meetings`, `notes`,
`documents`, dormant `document_versions`, and the four `*_links` tables), which
was deliberately schema-only: no policies, no write paths, no UI. These are the
debts it carried forward.

- **The nine operations tables ship with RLS ON and ZERO policies — Task 2 owes
  every one of them a policy, and until then `schema_invariants.sql` D4/D5/D11b
  are RED by design.** This is the identical safe-order interval Phase 3 Task 1
  opened for events. Measured at Task 1 exit: D4 actual `9` (nine tables with no
  policy), D5 actual `25` (24 select/insert/update grants on the eight writable
  tables + one select grant on the read-only `document_versions`, none with a
  policy behind it), D11b actual `22` against an expected `39`. **D11b's `39` is
  a PREDICTION of Task 2's policy shapes** — 22 existing + 16 (four `*_links` ×
  select/insert/update×2, mirroring `venue_rooms`) + 1 (`document_versions`
  SELECT-only via-documents) — computed in Task 1 and confirmed when Task 2
  turns it green. If Task 2's design differs (a link table needing a delete
  policy, `document_versions` policed directly rather than via-parent), Task 2
  corrects the `39`; that is the assertion working, not a Task 1 defect. **Owner:
  Phase 4 Task 2**, which must check these three went GREEN, not that they were
  silenced. `public.document_versions` specifically owes a SELECT-only policy on
  `view_crm` and NO write grant/policy (it is dormant — file versioning is
  Release 1.1).

- **The custom-field entity_type allowlists were DELIBERATELY NOT widened to the
  operational entities (Q47), and that is a decision, not an oversight.**
  `custom_field_definitions_entity_type_allowed` and
  `custom_field_values_entity_type_allowed` stay at the six CRM entities: tasks,
  meetings, notes and documents do not get custom fields at MVP. Recorded on
  `20260902003000`'s header and in the census test's `dedup`/custom-field
  expectations (unchanged). The reversal is additive and cheap (a drop-and-add
  ALTER per constraint plus the mirror in `lib/crm/custom-fields.ts`), and is a
  product decision if the founder ever wants it — not a red-test fix. Because
  `ActivitySubjectType = CustomFieldEntityType` is unchanged, `SUBJECT_NOUN`
  (`lib/crm/activity.ts`) needed no new entry either, and `LINK_ENTITY_TYPES`
  equals that same six-value set by construction — the three are kept as
  separate constants on purpose (their equalities are independent), so a future
  divergence touches one and not all three.

- **`ParentTable` (`lib/crm/actions.ts`) gained `tasks`/`meetings`/`notes`/
  `documents` BEFORE any caller.** The `*_links` write paths (later Phase 4
  tasks) will call `liveInOrg(supabase, "tasks", …)` etc. to refuse a link whose
  parent is soft-deleted or out of workspace — exactly the role the `events` arm
  was added for in Phase 3 Task 1 ahead of its first caller. A union member with
  no caller is harmless (nothing switches exhaustively on `ParentTable`); the
  obligation this creates is that whoever writes the link paths uses it rather
  than re-deriving the check. **Owner: the Phase 4 task that ships the link write
  path.**

- **The `<select>` pre-hydration and post-hydration defects, the no-JS submit
  gate, and the multi-org picker e2e assertion were scheduled against "Phase 4's
  first task" by Phase 3 Task 8 — but Phase 4's first task is schema-only, so
  they move to the first Phase 4 task that ships a form.** They are UI changes to
  the shared form primitives (`components/crm/`) and to `tests/e2e/`, and have
  nothing to do with the schema. See the four entries under `## Phase 3 — events`
  → "Opened by Task 8" and "Found in a browser": the five stale `<select>`s, the
  value-set-before-hydration discard, the no-JavaScript submit, and the
  five-and-sixth-picker multi-org e2e assertion. **Owner: Phase 4's first
  form-bearing task**, which is the change that has to build a `<select>`-bearing
  panel and the golden-path "add a task" step anyway.

- **`20260901031000:180`'s needless `grant execute` and the § EG soft-deleted-
  event assertion remain owed to a Phase 4 SQL task, and were NOT taken by the
  schema-only Task 1.** The grant cleanup is a one-line new migration plus a
  `schema_invariants.sql` assertion that no `private` `SECURITY DEFINER` trigger
  function is executable by `authenticated`; the § EG assertion adds a
  soft-deleted-event custom-field-write refusal to `rls_phase3_events.sql`. Both
  are additive and neither is a live defect. **Owner: a Phase 4 SQL task (Task 2
  is the natural home — it is already writing policies and can add both
  assertions beside them).**

### Opened by Task 8 (the phase exit gate)

- **The Task 1 RLS-interval debt is DISCHARGED.** D4/D5/D11b were RED-by-design
  while the nine operations tables carried RLS-on/zero-policies; Task 2 turned
  all three GREEN (D11b's predicted `39` confirmed) and the psql/HTTP suite is
  **1191 / 0 and 211 / 0 at HEAD** after a fresh `db reset`. No silencing: the
  Task 8 mutation table reddens these controls on demand (M-1 reopens A15/D8 and
  § OE; M-11 reopens § OB; M-12 reopens the storage fence). Recorded closed so a
  reader does not mistake the Task 1 bullet above for an open interval.

- **MERGE CONDITION 1 — a real malware scanner (Q42). Owner: the founder. Gate:
  Phase 10.** The pipeline is proven end to end by the EICAR stub
  (`documents.spec.ts`, `tests/integration/documents/upload-scan-download.test.ts`,
  file_access § A/B/C) — **but the stub proves the pipeline, not detection.**
  **2026-10-13: chosen and wired** — self-hosted ClamAV (`ClamdScanner`,
  `docs/clamav.md`). **Still owed before launch:** run the opt-in live test
  (`CLAMAV_LIVE_HOST=… npx vitest run tests/integration/security/clamav-live.test.ts`)
  against clamd on the first server, and set `MALWARE_SCANNER=clamav` +
  `CLAMAV_HOST` there. Full finding: § "Opened by Task 4" (Q42). Also owed to that
  same scanner-wiring task: the **stuck `pending`/`error` re-scan sweep**
  (§ "Opened by Task 5") — no security hole (fail-closed, no URL ever issued),
  a reachability gap.

- **MERGE CONDITION 2 — rate limiting, now over a wider surface. Owner: the
  founder. Build: Phase 7. Gate: Phase 10.** Nothing enforces `SECURITY.md` § 5,
  and Phase 4 grew the surface again: **four** new searchable list specs
  (`TASK_LIST`, `MEETING_LIST`, `NOTE_LIST`, `DOCUMENT_LIST`) **plus a new
  write endpoint that no other entity has — the document upload action**, which
  reads bytes, sniffs, and runs a synchronous scan per call with no limiter. The
  re-count at this exit is **24 list specs carrying a `searchColumn`** (20 at the
  Phase 3 exit) and the upload endpoint on top. The gate in § "Phase 10 — launch
  hardening" and the build in § "Phase 7 — admin/security" are restated over
  these numbers. Scheduled as **Q55** (DECISIONS-QUEUE).

- **MERGE CONDITION 3 — the screen-reader pass, extended by Phase 4's new
  component shapes. Owner: the founder (or a nominee). Gate: Phase 10.** No
  assistive-technology pass has ever run on this product. Phase 4 adds four
  shapes to the Phase 10 script: the **task priority chip**, the **document scan
  chip** (`Ready`/`Scanning…`/`Quarantined`, a state rendered as decoration-
  adjacent text), the **entity-link picker** (a grouped `<select>` whose option
  value is `entity_type:id`), and the **three-list related panel** (Tasks, notes
  & documents on one entity page, each list with its own pager). The axe pass is
  clean over all 19 pages and is **worth exactly its rule set** — it cannot hear
  any of these. The Phase 10 screen-reader script is extended. Scheduled as
  **Q56** (DECISIONS-QUEUE).

- **MERGE CONDITION 4 — the CI stack-suite decision, now overdue and escalated.
  Owner: the founder. Due: before Phase 5 starts. Scheduled as Q57 (was tracked
  as Q41).** Phase 4 shipped **eight file-security controls with no source-only
  guard** (enumerated in § "Phase 4 — CI decision"): a source-only CI leaves
  every one shippable-green, and the Task 8 mutation table is the proof — M-1,
  M-2, M-3, M-4, M-5, M-11 and M-12 each reproduce a real regression that
  `lint`/`tsc`/`vitest run tests/unit` cannot see. This was gated "before Phase 4
  starts" and Phase 4 has now shipped without the decision being made; it must be
  answered before Phase 5 builds on the same split. If the answer is "no", the
  M-4-SELECT gap below is the standing cost — a control whose only guard would be
  a stack suite needs a psql/HTTP assertion added by hand each time.

- **The M-4 SELECT-side link-target check has NO test — a measured coverage gap
  (Task 8 mutation table). Owner: a Phase 4 fast-follow SQL task.** Switching the
  INSERT policy's target check (`task_links_insert_via_task` `with_check`) from
  `private.entity_is_visible` to `entity_is_manageable` is caught by
  `rls_phase4_operations.sql` § OF (OF1 goes `ok(1)` → `denied(42501)`). Switching
  the **SELECT** policy's target check (`task_links_select_via_task` `using`) the
  same way reddens **nothing** — no assertion reads a link whose target is
  see-but-not-manage. Not a live defect (the read-side check is more permissive,
  not less), but an untested one. **Proposed assertion:** a § OF-read cell that
  plants a task-link to a venue the booker can SEE but not MANAGE and asserts the
  link ROW is still visible on select (the positive that a manageable-only SELECT
  predicate would drop), across all four `*_links` select policies.

- **A document restore is not audited while its delete is (minor).** Carried from
  § "Opened by Task 6"; deliberate (the audited set is byte-actions + the
  quarantine verdict), a one-line additive widening if delete/restore symmetry is
  wanted. Owner: whoever revisits the document audit surface. **No filename sort
  on the org-wide documents list (minor):** carried from § "Opened by Task 6", a
  one-index + one-sort fast-follow if asked for.

## Phase 7 — admin/security

- **RATE LIMITING. Owner: the founder. Scheduled here 2026-08-30 (final review
  I-9), discharging the Task 8 exit document's merge condition 1.** The full
  finding, with the measurements behind it, is in § "Opened by Task 8" above:
  nothing in the product enforces `SECURITY.md` § 5; the only real limiting
  anywhere is GoTrue's own per-IP `sign_in_sign_ups = 30` /
  `token_verifications = 30` per 5 minutes (`supabase/config.toml:264,266`),
  which does not meet § 5's Login row (5 / 15 min per IP **and per account** --
  no per-account limit exists); and search asks for 60/min/user and has none
  across **twenty** list specs (fifteen at the end of Phase 2; Phase 3 added
  five, and fifteen of the twenty are reachable from a rendered search box --
  re-counted by Task 8, evidence in § "Opened by Task 8" above), on a path
  Task 3 measured at ~75 ms of database time per search at 20,000 rows, growing
  linearly, because a non-leakproof operator cannot become an index qual for a
  caller RLS applies to. An authenticated member can issue those as fast as
  they like.

  Phase 7 because it is cross-cutting infrastructure that belongs with the
  admin/security surface rather than with any one entity, and because the
  superuser dashboard's incident alerting (`CLAUDE.md` § Superuser dashboard)
  is the natural consumer of whatever counters this produces.

  **This is not the deadline.** The deadline is the Phase 10 gate below. If
  Phase 7 slips, the gate still holds.

## Phase 7 — superuser dashboard

This is where the privileged surface actually lands, so these must be fixed
before the first real consumer exists rather than alongside it.

### Opened by Task 2 (break-glass impersonation)

Everything below is a KNOWN, MEASURED property of what shipped, not a defect
found later. Each is queued in
`.superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md`
with the default that shipped, and each names what the fix would be so the
next person does not have to re-derive it.

- **A SUSPENDED organisation cannot accept a support-access request (Q98).**
  `manage_organisation` has `survives_suspension = false`, so a suspended
  workspace's own Owner/Admin can neither see nor answer one. Consistent with
  consequence P7 (suspension is not self-serviceable) and measured in
  `rls_phase7_impersonation.sql` § IS — but it bites the support case most
  likely to need impersonation. **The fix, if the founder wants one, is a NEW
  catalogue key** (`accept_support_access`, `survives_suspension = true`,
  granted to Owner/Admin) — never a special case inside `has_permission()`,
  which is the one function in the schema that must stay readable in one pass.
  Note the other half is already right: an ALREADY-LIVE session survives
  suspension for reads, because `view_crm` does.
- **Consent cannot be withdrawn between accept and start (Q100).**
  `public.end_impersonation_session()` acts on a RUNNING session. The window is
  minutes in practice and the page says so in as many words, but a customer who
  changes their mind in it has no control. **The fix needs a SEVENTH status**
  (`withdrawn`), not a reuse of `declined`: the state CHECK ties `declined` to
  `accepted_at is null`, deliberately, so that no reader has to consult
  `status` to know what a timestamp column means.
- **The accepting admin is `aal2` but not step-up-fresh (Q99).** The superuser
  side has both. Cheap to add if wanted: wrap the accept CONTROL (never the
  page — a re-auth prompt in place of a list would be the first read in the
  product to demand one) in `<StepUpGate>`, and add the `checkStepUp()` call
  the superuser actions already carry to
  `acceptImpersonationRequestAction`.
- **Nothing notifies the customer that a request exists.** Q45 for the third
  time (after `reminder_at` and connection requests, both of which ARE emailed
  since Phase 8 Task 9b job 3, `20261016000000`): no email covers an
  impersonation request, so `/[orgSlug]/support-access` is the whole discovery
  surface. **This is the entry the email fold-in later in Phase 7 should
  discharge** — an impersonation request is a better first transactional email
  than most, because the customer cannot act on it if they never see it.
- **The page-access audit is APP-SIDE and over-records.** It fires at
  `getCurrentOrg()`, which is the only choke point every org-scoped page
  passes through (an `[orgSlug]` layout does not re-run on a client-side
  navigation between two routes that share it). Two consequences, both
  deliberate and both worth a reviewer's attention: a Next.js **prefetch**
  lands a `page_viewed` row for a page nobody opened — the opposite of Task
  1's decision for the audit-log viewer, because here the safe direction is
  over-recording; and a **direct PostgREST read** by an impersonating
  superuser would be authorised by the grant and not recorded as a page view,
  though the session and its start/end remain audited. Closing the second
  needs a trigger-based read audit, which does not exist anywhere in this
  product and should not be invented for one feature.
- **`/super` is now a landing page, and the next operator surface adds a row
  to `SURFACES` in `app/(app)/super/page.tsx`.** It stopped being a redirect
  to `/super/audit-log` the moment a second surface existed. Its own loading
  skeleton moved with it.
- **The impersonated view has one fidelity gap worth naming:**
  `public.profiles` is readable via `private.shares_active_organisation()`,
  and an impersonating superuser shares no organisation — so a name resolved
  from `profiles` (an activity-timeline actor, a record owner) may render
  blank during a session where the customer would see a person's name. Not a
  leak (the direction is less information, not more) and not measured as a
  defect anywhere, but it is the class of thing that makes a support engineer
  doubt what they are looking at. If it matters, the fix is the same shape as
  every other policy here: one additional SELECT policy probing
  `private.impersonated_organisations('view_crm')`.

- ~~**`private.custom_field_limit()` has the SAME escape, and it dies in the
  same migration.**~~ **DISCHARGED 2026-09-08, Phase 7 Task A
  (`20260908000000`).** Task 5 (`20260829010500`) mirrored
  `private.crm_write_organisations()` clause for clause, including reading "no
  subscription row" as **unlimited** rather than as Free. That is not a
  copy-paste convenience: Free's `custom_field_limit` is `0`, so reading a
  missing row as Free would give every organisation in the product zero custom
  fields on every entity type and ship the feature dead. The TypeScript half
  (`customFieldLimit()` in `lib/crm/custom-fields.ts`) carried the same branch,
  and `tests/integration/crm/custom-field-limit-matches-db.test.ts` binds the
  two. **Removed in exactly the three places this entry names, in the same
  migration/change as the entry below** — but NOT by deleting the branch the
  way `crm_write_organisations()` was fixed: falling through to the Free case
  would still zero every organisation's fields, so `private.custom_field_limit()`
  now RAISES (`errcode XX000`) when an organisation exists with no subscription
  row instead, an invariant the backfill + `create_organisation()`'s new write
  make structurally impossible. `customFieldLimit()` and the binding test were
  updated to match (the TS half falls through to Free's `0`, the safe default,
  rather than raising).
- **Custom field slot cycling is a billing question, not a schema one.** Founder
  decision Q12 (2026-08-29): a soft-deleted `custom_field_definitions` row frees
  its tier slot, so an organisation on Starter can remove five definitions and
  create five more, holding ten definitions' worth of **values** while paying
  for five slots. Nothing prevents it and nothing should at the schema layer —
  the alternative is a restriction on removing a field, in a product where
  removing a field is the operation the soft delete exists to make possible
  (`20260829010000` closes Task 2's "a mistyped key is permanent" deviation).
  Phase 7 owns whatever metering answer is right: count removed definitions
  toward the limit for some window, meter stored values rather than definitions,
  or decide it does not matter. `private.custom_field_slot_available()` is the
  one function that changes.
- ~~**Switch the subscription entitlement gate on: remove the escape and
  backfill, in ONE migration.**~~ **DISCHARGED 2026-09-08, Phase 7 Task A
  (`20260908000000`, commits `02e944d`/`5a4af78`/`41aa9c3`/`dabd986` on
  `worktree-admin-phase`).** `private.crm_write_organisations()`
  (`20260828140000`) was on all 25 CRM write policies and was **deliberately
  inert**: its `s.organisation_id is null` branch meant an organisation with
  no subscription row was not gated, and `create_organisation()` wrote no such
  row, so it gated nothing. Without that branch it would have denied every CRM
  write in the product on the day it shipped. **Done, in exactly the order
  this entry specified**: (1) backfilled an `organisation_subscriptions` row
  for every existing organisation, (2) made `create_organisation()` write one,
  and (3) deleted the branch — in one migration, in that order. `rls_phase2_crm.sql`
  § N's N1 and N16 were flipped to prove the gate now DENIES a stripped
  organisation rather than proving the machinery works while switched off, and
  every fixture across the psql/HTTP suite that relied on "no subscription
  row" as its ambient state (ALPHA/BETA, `org-merge`, `org-http-merge`,
  `rls_foundation.sql`'s org_a/org_b) was given a real row of its own. Full
  psql/HTTP suite and `pnpm test` verified green — see `task-A-report.md`.
- **`private.finance_module_organisations()` and `private.network_publish_organisations()`
  carry the SAME "no subscription row" escape Task A did not touch.** Added
  2026-09-08, alongside the entry above going DISCHARGED, so the gap does not
  just disappear with it. Both mirror `private.crm_write_organisations()`'s
  pre-Task-A shape clause for clause (`finance_module_organisations()`:
  `20260903001000`; `network_publish_organisations()`: `20260904001000`) —
  "no row => not yet billed => not yet gated" — and Task A deliberately scoped
  around them (`.superpowers/sdd/plan-the-whole-build-synthetic-thompson/progress.md`'s
  Task A description names only `crm_write_organisations()` and
  `custom_field_limit()`), not by oversight. Two things a future task should
  know going in: (1) `financial_entries`' own write policies (`20260903003000`)
  are gated ONLY by `finance_module_organisations()`, never by
  `crm_write_organisations()`, so removing the finance escape needs no
  `custom_field_values`-style double-gate fix; `custom_field_values` writes for
  `entity_type = 'financial_entry'` DO carry both, which is exactly the
  interaction Task A's `rls_phase5_finance.sql` § FI fixes hit. (2) Every
  fixture organisation across the whole psql/HTTP/e2e suite now carries a real
  subscription row from birth (Task A's `create_organisation()` change), which
  already forced every fixture that relied on "no row" for the finance/network
  escapes specifically (`rls_phase5_finance.sql` FE1/FE12,
  `rls_phase6_network.sql` § NT's NT1, `network_leakage_phase6.sql` § LI) to
  strip that row explicitly before testing it — so removing these two escapes
  is a smaller fixture-ripple than Task A's was, not a repeat of it.
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
- ~~**Ship the superuser REINSTATE path in the same change as the suspend
  button.**~~ **DISCHARGED 2026-09-08, Phase 7 Task 3 (`20260908030000`).**
  Built to the shape this entry specifies, exactly: a NEW permissive policy,
  `organisations_update_platform_lifecycle`, which is the only policy in the
  schema whose `USING` clause can match a soft-deleted organisation row and
  therefore the only way `deleted_at` can ever be cleared.
  `organisations_update_manage_organisation` is untouched, `manage_organisation`
  is still `survives_suspension = false`, and `rls_phase2_crm.sql` P7/P7a/P7b
  and P11-P11f all pass unchanged. **Three things this entry could not have
  anticipated, recorded because the next reader should not have to re-derive
  them:**
  (1) the new policy needed a matching SELECT policy,
  `organisations_select_platform_lifecycle`, because Postgres applies SELECT
  policies to an UPDATE's row-matching and the superuser is a member of
  nothing, so without it every reinstate would match zero rows and report
  success (`20260826154304` documents the same trap on
  `organisation_subscriptions`); that widening is why
  `rls_phase7_impersonation.sql` IX4/IZ3 were re-measured.
  (2) the three RPCs are `SECURITY INVOKER`, against the house pattern, so the
  new policy is the *enforcement* rather than dead code beside a definer that
  bypasses RLS.
  (3) the policy carries a second term, `private.lifecycle_transition_in_progress()`,
  so a raw `PATCH /rest/v1/organisations` from the superuser's own browser
  cannot make an un-audited, un-reasoned lifecycle change; the marker is set
  only inside the three RPCs and closed again by them.
  `rls_phase7_lifecycle.sql` sections LP and LR are the proof, driven from the
  Owner, a foreign aal2 Owner and an aal1 superuser. **ORIGINAL ENTRY BELOW,
  kept because its mechanism description is what made the fix buildable.**
  **CORRECTED IN TASK 3a FIX ROUND 1 — the first sentence used to say
  "since `20260828140000`, a soft-deleted organisation grants no permission at
  all", which has been false since `20260828210000` and cites a superseded
  migration. The conclusion below is unchanged; the mechanism behind it is
  different, and this is the entry Phase 7 reads to build reinstate, so getting
  the mechanism right matters more here than anywhere else.**

  Since `20260828210000` (Q6), a soft-deleted organisation grants `view_crm`
  and nothing else — suspension is READ-ONLY, not a lockout. `manage_organisation`
  is a write, so its own Owner still cannot clear `deleted_at`, and there is
  still no superuser write policy on `public.organisations`. Since
  `20260828220000` that is enforced twice: by the catalogue
  (`permissions.survives_suspension = false` for `manage_organisation`) and by
  an unconditional `deleted_at is null` in the policy's own `USING`.

  Today, reinstatement is a DBA action. That is the fail-closed direction and it
  matches CLAUDE.md (suspend/reinstate is a superuser function), but shipping
  suspend without reinstate is a one-way door.

  **What the Phase 7 change has to do, given both gates:** add a NEW permissive
  policy for the superuser (permissive policies OR together, so the term added
  in `20260828220000` does not block a separate policy) — do **not** relax
  `organisations_update_manage_organisation`, and do **not** open
  `manage_organisation` in the catalogue, because either would hand
  self-service un-suspension to every Owner. `rls_phase2_crm.sql` P7 (the Owner
  cannot un-suspend) and P11a/P11b (nor can they with the catalogue gate
  disabled) both stay true under that shape and will need updating only for the
  new superuser path, not for the Owner one.
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
  ~~**What genuinely remains for Phase 7** is the volume half: one audit row per
  cascaded child row, each with its own `correlation_id` because
  `private.log_audit_event()` mints a fresh one per call. Either thread one
  correlation id through the deletion path or suppress row-level audit inside the
  bulk operation and write a single summary row.~~ **THE VOLUME HALF IS
  DISCHARGED 2026-09-08, Phase 7 Task 3 (`20260908030000`), AS THREADING PLUS
  SUMMARY — and the mechanism is deliberately general, so the hard purge and the
  DSR erasure reuse it rather than inventing their own.**
  `private.log_audit_event()` now resolves its correlation id in THREE steps
  rather than two: an explicit `p_correlation_id` wins, then the thread
  `private.begin_lifecycle_transition()` declares, then — unchanged — a fresh
  uuid per call. An operation declares itself once and every audit row written
  anywhere inside it, **by any trigger, including one added years later**, joins
  one thread with no call site edited. `private.end_lifecycle_transition()`
  closes it, and that pairing is not optional: an `is_local` GUC stands to the
  end of the *transaction* whatever `SET` clauses the call stack carries
  (measured, after the first cut assumed otherwise). Beside it,
  `private.log_organisation_lifecycle_event()` writes ONE summary row per
  transition whose `after` payload carries the new state, both clocks, the
  operator's reason and COUNTS of what the transition touched (active members,
  published profiles) — counts, never rows, so the audit table stays free of
  tenant record content.
  **Suppression was considered and rejected**: it discards evidence to save
  space, in the table whose whole purpose is evidence, and unrecoverably — a
  summary saying "1,412 rows" cannot answer "was contact X among them".
  Threading keeps both, and if a purge is ever large enough that per-row rows
  are genuinely intolerable, the place to add suppression is that one function,
  on the same GUC, not thirty call sites.
  `rls_phase7_lifecycle.sql` LA6/LA6b is the proof, and it is deliberately TWO
  writes inside one declared operation: every real lifecycle transition happens
  to be alone on its thread, so a one-row-per-thread assertion would have passed
  identically against the old function. **The purge itself is still Phase 8+
  machinery and still does not exist** — Task 3 shipped the states, the clocks
  and the reversibility, not the deletion. This matters beyond tidiness —
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
- **Full CRM write auditing — DONE 2026-09-12 (Phase 7 Task 6b,
  `20260912000000` + `20260912001000`).** INSERT and UPDATE on all eleven
  mutable Phase 2 tables are audited by trigger (the twelfth, `merges`, is
  append-only and its INSERT was already audited); the before/after diff
  design is name-only with a per-table structural allowlist in ONE function
  (`private.audit_crm_value_columns()`), soft-delete/restore are their own
  actions, the four multi-row RPCs share one correlation id per call, and
  the retention/volume answer is measured (**472 bytes per row with its six non-PK indexes** — 216 was the row-only figure and `SECURITY.md` § 7 formally withdrew it as "understates real storage by more than half"; a volume projection built from this ledger was wrong by over 2×), ~0.36 ms per
  row of trigger cost, no per-table opt-out). Everything is in
  `SECURITY.md` § 7, "Every CRM INSERT and UPDATE is audited too". **What
  this did not do:** the Phase 3–6 tables (events, lineup, tasks, meetings,
  notes, documents, links, financial entries) carried no INSERT/UPDATE audit —
  Q94 scoped this to "the twelve" and the extension was queued as Q122.
- **Q122 — DONE 2026-09-30 (Phase 8 Task 7, `20261006000000`).** The same
  trigger function and the same allowlist now cover **sixteen more tables**,
  derived from the catalogue rather than copied from a list: `events`,
  `event_lineup`, `tasks`, `meetings`, `notes`, `documents`, the four
  `*_links`, `financial_entries`, `network_profiles`, `network_links`, and
  three the derivation found that nobody had named —
  `organisation_memberships` (an invite, a role escalation and a removal were
  all unaudited; removal is `membership.deleted`), `organisation_subscriptions`
  and `merge_candidates`. Structural columns only: never `notes.body`,
  `meetings.attendees`, `documents.filename`, an amount or any free text.
  `private.audit_coverage()` derives every tenant-owned table a client can
  write and classifies its coverage, and
  `tests/integration/admin/crm-audit-coverage-census.test.ts` is red by NAME
  for a new one nobody decided about (proved with a planted table, and by
  dropping a real trigger). The connection-request writer gained `.withdrawn`
  and a name-only `.updated`; three `network_connection.*` names the database
  had written since Phase 6 were on neither side of the catalogue and are now
  registered. **Still open:** whether a `network_link.*` row is compatible with Q82
  is Q188 (shipped default: yes). `SECURITY.md` § 7 has the as-built text and
  the measured volume. **Fix round 1 (`20261007000000`, `20261007001000`)**:
  the allowlist's person ids (an invitee's `user_id`, a reassigned
  `owner_user_id`) survived a completed account erasure on rows whose actor
  and target were someone else -- the erasure now replaces the id inside
  every audit payload and refuses if one survives (C1); the census now
  requires an ENABLED trigger, RLS on for the RPC-only class, and sees an
  FK-less `organisation_id` table and a writable view (M1/M2). **Still open
  from it:** Q191 (`merge_candidate.restored` has no client path) and Q192
  (the erasure's payload scan is a sequential scan; measured 0.45 s at 500k
  rows).
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

- **PRE-DEPLOYMENT GATE: rate limiting must be implemented before this product
  is deployed. Owner: the founder. Added 2026-08-30 (final review I-9).** This
  is a refusal, not a reminder: if `SECURITY.md` § 5 is still unenforced when
  launch is otherwise ready, launch does not proceed. **The surface grew again in
  Phase 4 and the gate is restated over the new number:** **~41** list specs carry
  a `searchColumn` today (20 at the Phase 3 exit; 24 after Phase 4 added
  `TASK_LIST`, `MEETING_LIST`, `NOTE_LIST`, `DOCUMENT_LIST`; Phases 5-7 took it
  to 42 `searchColumn:` occurrences of which one is the type declaration in
  `lib/list/spec.ts` — `grep -rc 'searchColumn:' lib components app` is the
  count, and this entry says to re-count at each phase exit precisely because
  the number in it goes stale) **and Phase 4 added the first
  write endpoint that does real per-call work — the document upload action (byte
  read + magic-byte sniff + synchronous malware scan) — which has no limiter
  either.** The unmetered `ilike` path this gate is about is now a fifth wider
  again than at the Phase 3 exit. Re-count it at each phase exit rather than
  inheriting this sentence. (Task 8 exit condition 1; DECISIONS-QUEUE Q55.) The implementation is
  scheduled in § "Phase 7 — admin/security" above and the evidence is in
  § "Opened by Task 8"; this entry exists so that a slip in Phase 7 cannot turn
  into a ship. `SECURITY.md` § 1 makes security an acceptance criterion rather
  than something applied afterwards, and the Task 8 exit document was explicit
  that closing this as "accepted" rather than scheduled would have blocked the
  Phase 2 merge.
  **DISCHARGED 2026-09-09, Phase 7 Task 5 (`20260909020000`), with one
  narrowed residual that stays a gate.** `SECURITY.md` § 5 is now built: one
  mechanism, one config table holding the values, metered at the single
  `lib/list/query.ts` chokepoint every one of those `searchColumn` specs flows
  through (so the count that kept growing is no longer the thing to re-count --
  a twenty-fifth spec inherits the meter by construction), plus a genuine
  per-account login lockout in GoTrue's password-verification hook. § 5's
  table now carries a per-row status. **The narrowed gate that replaces this
  one:** a direct `GET /rest/v1/network_directory` with the anon key and a
  session JWT is still unmetered and cannot be metered from inside a
  PostgREST GET (read-only transaction; a counter increment is a write) --
  DECISIONS-QUEUE Q107, whose recommended closure is a `pgrst.db_pre_request`
  DENY of the direct path for the two directory views. **The document-upload
  action named above is still unmetered** and is the second residual: its
  budget is not in § 5's table at all, so it needs a founder decision on a
  number before it can be added -- queued as part of Q107's follow-on rather
  than invented here.
- **PRE-LAUNCH GATE: an impersonating superuser's DIRECT PostgREST reads are
  authorised and unrecorded. Owner: the founder. Added 2026-09-08 (Phase 7
  Task 2, fix round 1, Important 4.)** This is a NAMED GATE, not a note, and
  it is here so that a residual disposed of as "acceptable at MVP" cannot
  quietly become "done". **The measured fact:** `authenticated` holds `SELECT`
  on every tenant table, those policies call
  `private.permitted_organisations()` / `private.full_scope_organisations()`,
  and both now consult `private.impersonated_organisations()`. So
  `GET /rest/v1/contacts?organisation_id=eq.<target>` with the browser's anon
  key and a live session **returns rows and mints no
  `impersonation.page_viewed` row**. The app-side audit at `getCurrentOrg()`
  is complete for every path through the Next.js app and fails closed, but it
  is not a database-level control, and Postgres cannot fire a trigger on
  SELECT. **Why it was accepted at MVP:** no read-audit mechanism exists
  anywhere in this product; the *session itself* — request, consent, start,
  end/expiry — remains audited in-transaction at the database, which is
  exactly the set the binding constraint enumerates ("actor, org, reason,
  start/end"); and the window is consented, time-boxed and read-only.
  **What closing it looks like, so the next person does not have to derive
  it:** either `pgaudit` (session/object audit on the impersonating role) or
  an RPC-only read surface for this grant — i.e. revoking direct table SELECT
  for an impersonating session and routing its reads through auditing
  definer functions. Both are real work and neither is a one-line fix, which
  is precisely why it is a gate with an owner rather than a TODO.
  Cross-referenced in `SECURITY.md` § 10's "Break-glass impersonation" risk
  row (residual 1) and § 7's page-access subsection; **if this entry and
  those disagree, this one is the schedule and they are the description.**
- **SCREEN-READER PASS. Owner: the founder (or a nominee). Due: before Phase 10
  exit. Script: `task-8-report.md` § 3.** Added 2026-08-30 (final review I-13).
  No screen-reader pass has ever been run on this product -- it has now been
  deferred by Tasks 3, 7 and 8, in each case because the environment has no
  NVDA/JAWS/VoiceOver. Final review I-12 is the direct evidence that the
  automated half does not substitute for it: axe reported ZERO violations on the
  custom-fields settings page while an error `<p>` there was referenced by no
  `aria-describedby` at all, which is an error a screen-reader user could not
  hear. `CLAUDE.md` § Legal and regulatory compliance names the Equality Act
  2010 obligation behind it. Walk `task-8-report.md` § 3's golden path as each
  of its five roles, plus the custom-field editor, the merge screen and the
  in-app 404.

  **EXTENDED BY PHASE 3 (Task 8). Four more surfaces, and the first three are
  new component shapes rather than more of the same page:**

  1. **The event STATUS CHIP** (`components/crm/status-chip.tsx`). A `<span>`
     with a border and an uppercase label, inline beside the `<h1>` and again
     in every row of the events list table. Ask: is the label announced as part
     of the row, or lost between the name and the date? It is the one place in
     the product where a *state* is rendered as decoration-adjacent text, and
     DESIGN.md forbids colour being the only signal — the automated half can
     only confirm the text exists, not that it is reachable in reading order.
  2. **The LINEUP PANEL** (`components/crm/lineup-panel.tsx`). A
     `<ul role="list">` whose `role` is explicit *because* Tailwind's preflight
     drops list semantics in Safari/VoiceOver — so the specific question is
     whether VoiceOver announces "list, 3 items" here, which is exactly what
     the `role` was added to buy and what nothing has ever verified. Each row
     also carries its own form with a number input and two `<select>`s, and the
     Save button's accessible name includes the artist.
  3. **THREE lib/list/ SURFACES ON ONE PAGE.** The event detail page carries
     the lineup panel, the custom-fields panel and the activity timeline; the
     artist detail page carries the fee history, the event history and the
     timeline. Each has its own pager. Phase 3 Task 8 found by scanner that two
     of those pagers had the IDENTICAL accessible name ("Pagination") and fixed
     it (`Pagination for ${noun.many}`) — the screen-reader question that
     remains is whether the landmark list is now *usable*, not merely unique.
  4. **The MFA ENROL GATE as an OWNER sees it.** Walk 4 of
     `task-8-browser-walk.spec.ts` records that signing in as an Owner replaces
     the whole application shell with "Set up two-factor authentication". A
     shell that is REPLACED rather than navigated to is the shape most likely
     to leave focus somewhere stale, and it is the first screen a paying
     customer's Owner ever sees.

  **EXTENDED BY PHASE 4 (Task 8). Four more shapes, three of them new:**

  1. **The task PRIORITY CHIP** (`components/crm/priority-chip.tsx`) and the
     **document SCAN CHIP** (`components/crm/scan-status-chip.tsx`:
     `Ready`/`Scanning…`/`Quarantined`). Both render a *state* as
     decoration-adjacent text, and DESIGN.md forbids colour being the only
     signal — the automated half confirms the text exists, not that it is in
     reading order or announced as part of the row it labels.
  2. **The ENTITY-LINK PICKER** (`components/crm/entity-link-picker.tsx`). A
     grouped `<select>` whose `<optgroup>`s are entity types and whose option
     value is `entity_type:id`; the Link button's accessible name and the
     resulting "Unlink <name>" control are the question — is the picked target
     announced, and is the unlink reversible by keyboard.
  3. **THE THREE-LIST RELATED PANEL** (`components/crm/related-panel.tsx`).
     "Tasks, notes & documents" on one entity page: three lists, each with its
     own pager (`rel_tasks_`/`rel_notes_`/`rel_docs_`). The same landmark-list
     usability question Phase 3 asked of the event detail's three surfaces, now
     on every CRM record. The documents sub-list additionally carries a Detach
     control per row and inert (non-link) filenames for non-`clean` files —
     "Quarantined — cannot be opened" must be *spoken*, not only shown.
- **A real assistive-technology pass has never been run.** No NVDA, JAWS or
  VoiceOver was available at any point during Foundation; accessibility-tree
  and DOM/spec-level evidence was used instead and disclosed each time. The
  workspace switcher, both MFA gates and the idle-timeout banner are the
  surfaces that most need it.
- **The idle-timeout banner's live-region behaviour** (`role` and politeness on
  a non-modal banner wrapping a countdown that updates every 5s). Real WCAG 2.2
  AA concerns, and both need a screen reader to validate the fix. Do not "fix"
  them blind first — a change nobody can hear is not an improvement.
- **Google SSO completed a real sign-in on 2026-09-09** against the hosted
  project: `POST /login` -> `signInWithGoogleAction` -> `GET /auth/callback?code=`
  303 -> `/` 307 -> the org workspace 200. The auth-provisioning trigger fired
  and placed the account in its organisation. Two things that cost time and are
  not obvious from the code:
  - **`env()` in `supabase/config.toml` is resolved at `supabase start`, not per
    request.** A stack started before `.env` existed sent Google the literal
    string `env(GOOGLE_OAUTH_CLIENT_ID)`, and the only visible symptom was a
    failed sign-in. Restart the stack after touching either value.
  - **It hung indefinitely in a normal Chrome profile and worked first try in
    incognito**, with identical config on both sides — so a browser extension or
    stale Google cookies, not the app. Worth remembering before debugging the
    server again: CSP, credentials and provider config were all verified good
    while the profile was still hanging.
  Still unexercised: sign-in against the **local** stack (only the hosted
  project has been driven end to end), and any Playwright coverage — the flow
  needs a real Google account, so it stays a manual check.
- **The hosted project's Site URL is `http://127.0.0.1:3000`** while the app and
  `NEXT_PUBLIC_SITE_URL` use `http://localhost:3000`. Different origins to a
  browser. It does not break sign-in — `http://localhost:3000/**` is in the
  redirect allow-list, which is what the successful run used — but it is the
  fallback GoTrue redirects to when a flow errors before `redirect_to` is
  recoverable, so an auth failure lands the user on an origin with no session
  cookies. Align the two before the first real deployment.
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

## Found in a browser, Phase 3 Task 6

- **A Free-tier workspace is told to add a custom field it cannot add.** On
  `Settings > Custom fields` at a zero limit the page renders three sentences in
  a row, and the third contradicts the first two: "Your plan doesn't include
  custom fields. An Owner can upgrade the workspace to add some." then "No
  custom fields on events yet. **Add one** and it appears on every event record
  in this workspace." then "Your plan doesn't include adding or editing
  records." The middle one is `CustomFieldEditor`'s ordinary empty state, which
  does not know about the limit — it is reached whenever `live.length === 0`,
  and at a Free tier that is always. This is the rule the phase set for
  `DELETED_RECORD_EXPLANATION` ("an instruction that will not help is worse than
  no explanation") and for `customFieldLimitMessage` (which was fixed for
  exactly this at `limit === 0`), applied inconsistently one component along.

  **OWNER: Phase 7, with the rest of the custom-field / entitlement copy work.
  SCHEDULED: Phase 7 — it does NOT block the Phase 3 branch** (Task 8 exit
  document § 6/§ 7, corrected 2026-08-31). Measured, so the call is made rather
  than deferred by default: it is Phase 2 copy in `CustomFieldEditor` that reads
  identically on all six entity types, so it is neither events-specific nor
  introduced by Phase 3, and its blast radius is a Free-tier settings page, not
  the golden path. The earlier draft of this entry said "before the Phase 3
  branch merges", which contradicted the exit document listing it as a
  non-condition; this line is the reconciliation, and the exit document is the
  authority.
  **Not events-specific and not this task's code** — it is Phase 2 copy and it
  reads the same on all six entity types, which is why it is filed rather than
  fixed here. The fix is one condition: suppress the "Add one" empty state when
  `limit === 0`, because the gate sentence above it already says everything
  true. Observed in `.superpowers/sdd/phase-3-events/task-6-browser-walk.spec.ts`
  test 6, whose log carries the verbatim page text.

## Gate: after any `npx skills experimental_install` or `npx skills check`

Six vendored skill files carry local patches. They fix contradictions the skills ship
with — each one was verified against the source files, not inferred. **A skills
update overwrites all six silently**, and `skills-lock.json` stores a `computedHash`
per skill, so patched files will also read as drift.

Find them all with `grep -rn "GSP-PATCH" .agents/skills/`. Re-apply after any update.

| File | What the patch fixes |
| --- | --- |
| `hallmark/references/hero-enrichment.md` | Tier letters said "C generated / D library"; `custom-craft.md`, which *defines* the tiers, has C = declarative animation, D = Three.js, E = generated, F = library. Realigned to E/F. |
| `hallmark/references/hero-enrichment.md` | Self-contradiction in one file: HP3 · Cursor-spotlight names SaaS marketing in its "Use when" and cites Linear/Raycast, while the banned list forbade mouse-follow gradients on SaaS. Ban rescoped to what HP3 already forbids. |
| `hallmark/references/components/s1-left-margin-numbered.md` | Ships `grid-template-columns: 10rem 1fr` with the label left and `<h2>` right — the exact shape gate 54 hard-bans — with no warning. Three other files agree it is banned by default. Warning added. |
| `hallmark/references/custom-theme.md` | The `italic-serif` and `display-condensed-italic` display axes auto-fail gate 38a, which bans italic on headings and wordmarks "for every theme". Tension stated; neither side deleted. |
| `hallmark/references/microinteractions.md` | "Use `IntersectionObserver`, never scroll listeners" read unqualified, banning the passive rAF-throttled scroll listener that `floating-nav.md` correctly uses for nav state. Scoped to reveals. |
| `vercel-react-best-practices/rules/rendering-hydration-no-flicker.md` | Recommends an inline `dangerouslySetInnerHTML` script. Blocked by `CLAUDE.md`, by the nonce-based `script-src`, and it would falsify the "ships zero `dangerouslySetInnerHTML`" claim that `lib/security/headers.ts` uses to justify `style-src 'unsafe-inline'`. |

Two upstream defects were **not** patched, deliberately — fixing them means asserting
facts we cannot verify, and they cost nothing while unfixed:

- **`supabase-postgres-best-practices/SKILL.md` frontmatter says `version: "1.1.1"`
  while its own `CHANGELOG.md` is at `1.6.0`.** Stale vendor metadata. Report
  upstream rather than inventing a version locally.
- **`hallmark/references/export-formats.md` `tokens.css` disagrees with
  `layout-and-space.md` and `typography.md` on `--space-*` / `--text-*` values.** The
  project takes neither — `app/globals.css` is canonical, per DESIGN.md § Motion.

## Standing lesson from Foundation

Three defects shipped past a source-only review and were caught only by running
the application in a browser: a sign-out lockout on every returning user, a
context tracker that never fired on client-side navigation, and an enrolment QR
code that never rendered. None was visible to `tsc`, ESLint, the build, or the
test suite.

Any task that ships a screen needs someone to open it. Treat a browser
walkthrough as part of the definition of done, not as optional diligence.

### Opened by Task 4 (the file-security pipeline core)

- **Q42 — WHICH PRODUCTION MALWARE SCANNER, AND AT WHAT COST — remains a founder
  decision.** Task 4 built the `MalwareScanner` seam (`lib/security/malware-scan.ts`)
  and a local `EicarStubScanner` that makes quarantine exercisable end to end,
  but **no real engine runs anywhere in this codebase.** `getScanner()` reads
  `MALWARE_SCANNER` (default `stub`); `clamav` and any SaaS name resolve to an
  **unconfigured adapter that throws "not configured"** rather than silently
  passing a file unscanned. Wiring the real scanner is a future task that owns:
  the adapter implementation, the credential/DPA (a scanning SaaS is a
  sub-processor — `CLAUDE.md` § Sub-processor register), whether scanning moves
  to a **webhook** (a real SaaS is not synchronous — the upload action's
  synchronous scan is an MVP stub property, noted in `lib/crm/documents.ts`), and
  setting `MALWARE_SCANNER` in production so the throwing default cannot ship.
  **Owner: founder decision (Q42), then the task that wires it.**
  **ANSWERED 2026-10-13: self-hosted ClamAV** (free; in-region; no
  sub-processor, no DPA, synchronous so no webhook). Wired as `ClamdScanner`
  — fail-closed on every non-verdict reply; unset `MALWARE_SCANNER` under
  `NODE_ENV=production` now throws rather than running the stub. Deployment:
  `docker/clamav/`, runbook `docs/clamav.md`. Open: the live test on the first
  server (MERGE CONDITION 1 above).

- ~~**The upload is NOT audited yet — the audit call is a marked seam awaiting
  Task 5's helper.**~~ **DONE, Phase 4 Task 5.** `20260902031000` ships
  `public.audit_document_action` (the guarded thin RPC over
  `private.log_audit_event`), and `uploadDocumentAction` now writes
  `document_uploaded` on a clean/error verdict and `document_quarantined` on a
  malware hit, fail-closed (an audit fault does not report success). Download and
  soft-delete are audited in the same change (`document_downloaded`,
  `document_deleted`). See `SECURITY.md` § 7.

- **A scanner FAULT stores the file at `scan_status='error'` and the pipeline is
  fail-closed on it — but there is no retry/re-scan path.** A thrown or `'error'`
  scanner verdict lands the row `error` (never `clean`), so no signed URL is ever
  issued (Task 5), which is the safe direction. What is missing is a way to
  RE-SCAN an `error` row once the scanner is healthy again — today it is stuck.
  Not needed for the stub (which never errors unbidden); owed by whoever wires
  the real scanner alongside the webhook decision above.

- **The OOXML macro check keys on plaintext ZIP markers (`vbaProject.bin`, a
  `macroEnabled` content type), not a full unzip.** This is correct because a
  ZIP stores entry names uncompressed in every header, so the markers appear
  verbatim without decompression — but it is a substring scan, not a parser. If
  a future requirement needs deeper OOXML validation (e.g. rejecting external
  relationship targets / OLE-embedded objects), that is a real unzip-and-parse
  step, a deliberate addition, not a tightening of the current sniff. Recorded so
  the sniff's scope is not mistaken for full OOXML validation.

### Opened by Task 5 (the download half — authorised signed URLs, audit, soft-delete)

- **Soft-delete does NOT purge the bytes — a byte-GC job is owed (Phase 8 /
  retention).** `deleteDocumentAction` sets `deleted_at` and audits
  `document_deleted`, but the object stays in the `documents` bucket by design
  (soft-delete discipline — `CLAUDE.md` § Non-negotiable rules; a deleted row is
  restorable, and a hard byte-delete is not). What is missing is a
  **retention/GC job** that removes the bytes of documents whose rows are past
  the retention window (7yr financial / 2yr other, pending legal sign-off), so
  storage does not grow without bound. **Owner: Phase 8 (retention), or the DSR
  erasure flow (`Data subject request`), whichever lands first — a GDPR erasure
  of a document must purge its bytes, not only its row.** Until then, deleted
  documents keep their storage footprint, and a tenant's storage-used metric
  counts them.

- **A stuck `pending` or `error` document has no re-scan/sweep.** Two ways a row
  can sit un-terminal forever: an upload that crashes between the `pending`
  insert and the terminal update (stuck `pending`), and a scanner fault that
  lands `error` (carried from Task 4). Both are fail-closed — neither yields a
  signed URL, because the download gate serves only `clean` — so this is a
  reachability/cleanup gap, not a security hole. The scan-status transition guard
  (`20260902031000`) deliberately does **not** block `pending`/`error` →
  `clean`, so a future re-scan path is unobstructed; what is missing is the path
  itself (re-run the scan, or a sweep that quarantines rows older than N hours
  with no verdict). **Owner: the task that wires the real scanner (Q42), which
  needs the same webhook/verdict plumbing.** Recorded here so a stuck upload is
  understood as a known gap with a safe failure mode, not a silent one.

### Opened by Task 6 (the documents UI and cross-entity attachment)

- **A document restore is not audited, while its soft-delete is.**
  `deleteDocumentAction` writes a `document_deleted` audit row;
  `restoreDocumentAction` writes none, because `public.audit_document_action`'s
  closed action set (`20260902031000`) carries no restore verb and restore is a
  metadata-only flip (no bytes touched, no signed URL minted). The asymmetry is
  deliberate — the audited set is "byte-actions plus the quarantine verdict" —
  but a `document_restored` row would be a one-line additive widening of that
  RPC's `in (...)` check if a later phase wants delete/restore symmetry in the
  log. **Owner: whoever revisits the document audit surface (audit-viewer work,
  or the scanner-wiring task that already touches `20260902031000`).** Not a
  live defect: the delete is on the record, and a restore returns it to exactly
  the audited-uploaded state.

- **The related panel's document detach is a per-entity un-attach (DONE, review
  fix round 1).** The panel's Documents surface now carries a per-row **Detach**
  control that calls `removeLinkAction` on the one `document_links` row attaching
  the document to that record — a per-entity un-attach that leaves the document
  and its other attachments untouched. (The earlier note here recommended
  "delete from /documents and re-upload" as the workaround; that was **wrong and
  destructive** — a document soft-delete removes it from *every* linked entity,
  not just one — and is removed. Deleting a document is deleting the document,
  never a way to detach it from one record.) No follow-up remains.

- **The org-wide documents list offers no `filename` sort.** Only `created_at`,
  because `filename`/`updated_at` have no `(organisation_id, <col>, id)` live
  index and rule 9 forbids a sort naming an index nobody created. If sorting the
  file list by name is wanted, it is one `documents_org_filename_id_live_idx`
  migration plus a sort entry — the same shape as the events list's name sort.
  **Owner: a documents fast-follow, if the sort is asked for.**

## Phase 5 — finance

Opened by the Phase 5 whole-branch review (`d7fec54..2bee9b1`, 2026-09-01) and
by its task-level reviews. **The phase's own working record —
`.superpowers/sdd/phase-5-finance/` — is gitignored and disappears with the
worktree, so anything from it that must outlive the branch is written here.**
The three code findings below were FIXED in the post-review wave and are
recorded for the history and the residual each leaves; the rest are open.

### Fixed in the post-review fix wave, recorded for the residual

- **The finance tier gate did not reach the custom-field VALUE write path
  (review I1) — FIXED, `20260903030000`.** The `financial_entry` arm of
  `private.entity_is_manageable()` carried no tier term, and the three deployed
  `custom_field_values` write policies gate on
  `private.crm_write_organisations()`, which **Starter passes**. A never-Pro
  Starter organisation was safe only by accident (it can hold no
  `financial_entries` row); a Pro organisation that **downgrades** keeps its
  lines by design (Q67) and kept the ability to write custom-field values
  against them. The fix adds `finance_module_organisations()` to that one arm.
  **Residual worth knowing:** it was *inert* when found, because
  `create_organisation()` writes no subscription row and the entitlement escape
  branch matches every organisation — and the two tests that looked at it had
  **baked the wrong assumption in** (the vitest case wrote against a nonexistent
  line id, on the reasoning "no `financial_entries` row exists in a Starter
  org"). **Owner of the general lesson: Phase 7,** when it removes the escape
  branch. Every entitlement assertion written while the gate is inert should be
  re-read then, not just re-run: an inert gate makes a wrong test green.

- **Three implementations of the money parser, two untested (review I2) —
  FIXED.** `lib/format/money.ts`'s `parseGbpToMinor` was dead (only its own test
  called it) while every real write went through a parallel `parsePounds` in
  `lib/crm/finance.ts` with no unit test, and a third converter
  (`minorToPoundsInput`) rendered every stored amount back into the edit form
  from inside `components/crm/finance-panel.tsx`, module-private and untestable.
  Consolidated to one `parseGbpDetailed`. **Residual:** `parsePounds` still
  cannot be imported by a test — every export of a `"use server"` module is a
  server action — so its guard is a source-shape assertion, not a behavioural
  one. Any future validator that lives in a `"use server"` module has the same
  problem and needs the same split (pure logic outside, message mapping inside).

- **A failed summary query rendered £0.00 / "break-even" (review I3) — FIXED.**
  `loadEventFinanceSummary` collapsed "no row" and "query failed" into one
  all-zeros return. It now returns a three-way outcome and the panel renders an
  error note. **Residual:** the failure branch is **unreachable from the local
  stack** — no fixture makes PostgREST error on a well-formed read the caller is
  entitled to make — so it is covered by a faked client in
  `tests/unit/crm/finance-summary-outcome.test.ts` and by nothing else. The same
  is true of every other loader's `unavailable` branch in the product.

### Open — Phase 5's own deferred debt

- **Orphaned custom-field VALUES on a removed finance definition are invisible
  and unclearable** (Task 3 review M6, routed here by its reviewer and by the
  whole-branch review). Removing a `financial_entry` custom-field definition
  keeps its stored values — deliberately, and the same as every other entity
  (`20260829010000` decision 1: "removing a field keeps what was filled in").
  The difference is that a finance line has **no detail page**, so the generic
  `CustomFieldsPanel` — which is where a removed definition's orphaned value is
  surfaced and cleared for the other six entity types — never renders for one.
  The value is therefore stored, unreadable in the UI, and unclearable by the
  user. **Not a leak** (it is the organisation's own data, behind
  `view_finance`), and not a correctness bug; it is a data-hygiene gap with no
  user-facing exit. **Owner: whichever phase gives finance lines a standalone
  route** (the same route `ENTITY_PATH_SEGMENT`'s
  `__financial_entry_has_no_standalone_route__` sentinel is a placeholder for),
  or a settings-side "clear orphaned values" action if that route never arrives.

- **Disabled custom-field controls in the finance form lose their
  `aria-describedby` why-note** (Task 3 review M5). Every other field in the
  same form points at the panel-wide "Read-only." explanation when it is
  disabled; the custom-field inputs do not. It is a WCAG-adjacent inconsistency
  *within a single form*, and **axe cannot see it** — the controls are validly
  disabled and validly labelled, so nothing automated goes red. **Owner: the
  next change that touches the finance form's disabled state.**

- **The finance render gate has no source-only assertion.** The event page
  mounts the panel only when the caller holds `view_finance`; that is
  Constraint 12's first job, and it is proved by an e2e run and by the psql/HTTP
  suites — none of which CI executes. A `source-shape.test.ts`-style assertion
  that the panel's JSX is gated on `financeReadable` would be the CI-visible
  half. **Owner: whoever next extends `tests/unit/crm/source-shape.test.ts`.**
  (The same gap in general form is Phase 4's "CI decision" item above.)

- **The finance panel has had no screen-reader pass.** Task 5's axe scan over
  the event page *as a Finance user* found and fixed a real `empty-table-header`
  defect on the summary table — the first time any browser ran axe over a
  session holding `view_finance`, after nine prior page scans could not have.
  That is the automated half only. The manual VoiceOver/NVDA spot check
  `CLAUDE.md` § Testing gates asks for has not been done for the summary table,
  the category/status chips or the removed-lines disclosure. **Owner: the
  accessibility pass before launch** (`Phase 10 — launch hardening`).

- **Q69 and the phase's other founder questions live only in the gitignored
  queue.** Phase 5 raised Q58–Q69; the answered ones are recorded in the code
  and its comments, but the queue file itself is not tracked, so the reasoning
  behind each answer does not survive the worktree. **Owner: the founder-facing
  decisions process** — if the queue is meant to outlive a branch, it needs a
  tracked home.

- **`FINANCIAL_ENTRY_DELETED_LIST` is dead, and an index exists only to back
  it** (review N1). `lib/crm/finance-list.ts`'s deleted-list spec,
  `DeletedFinancialEntryRow` and both `*DeletedSortKey` types have no callers —
  the panel reads removed rows directly with `FINANCIAL_ENTRY_DELETED_SELECT`,
  mirroring the lineup, which is the right pattern. The spec was a Task 1 plan
  deliverable and `financial_entries_org_deleted_at_id_idx`
  (`20260903000000:229`) was added specifically so its `backedBy` would name a
  real index. Net: an unused spec plus a partial index nothing queries.
  **Owner: either the standalone finance route (which would use both), or a
  cleanup that deletes the spec and restates the index comment.**

- **The `ENTITY_PATH_SEGMENT` sentinel turned a fail-closed guard into a
  fail-open one** (review N2). `lib/crm/custom-fields.ts` maps `financial_entry`
  to `"__financial_entry_has_no_standalone_route__"`; `otherHref`
  (`lib/crm/activity.ts:500`) gates on `Object.hasOwn(ENTITY_PATH_SEGMENT, ...)`,
  so what used to return `null` for an `other_type='financial_entry'` now
  returns a link to that sentinel path. **Unreachable today** —
  `activity_events` emits no finance rows (Q62) — but the guard that protected
  it no longer does. Fix is one line: narrow `otherHref`'s lookup to
  `ActivitySubjectType`, which already `Exclude`s `financial_entry`. **Owner:
  whoever next touches the activity timeline's link building, or the phase that
  gives finance a route.**

- **The finance create path reports "Saved." when the custom-field RPC faulted**
  (Task 3 review M2). The *update* path already returns a message saying the
  line saved and its custom fields did not; the create path does not, so a user
  can silently lose a typed custom-field value. The whole-branch review called
  this the worst of the 22 deferred minors and endorsed it as a fast follow. The
  update path proves the shape works without inviting a duplicate INSERT.
  **Owner: a finance fast-follow.**

- **`finance.spec.ts` uses `mode: "serial"`, so a golden-path failure SKIPS the
  Starter tier test** (Task 5 review M2). The two tests are independent by the
  author's own statement, and the skipped one is the browser proof of the money
  tier gate — signal loss in exactly the suite that should not have any. One-line
  change. **Owner: the next e2e touch.**

- **Small stale prose and near-duplicate constants, all disclosed, none
  load-bearing.** `rls_phase3_events.sql` EC4's "view_crm only" parenthetical is
  stale now that `entity_is_visible` has a `view_finance` arm (the assertion
  itself is still correct); `tests/e2e/fixtures.ts:1254` still says "four per
  run" where `setUpWorld` now creates six auth users, and that number is
  load-bearing to its own paragraph's argument; `MAX_DESCRIPTION = 200` is
  duplicated between `lib/crm/finance.ts` and `components/crm/finance-forms.tsx`
  (browser hint vs server enforcement — the same trade the lineup already
  carries). **Owner: the next change that touches each file.**

- **A Starter or Free organisation can spend custom-field definition slots on a
  module it cannot use** (review N4). `CUSTOM_FIELD_ENTITY_TYPES` drives a
  "Financial entries" tab in the custom-fields settings page for every tier, so
  a Starter organisation can burn 2 of its 5 slots per entity type on fields no
  row will ever carry. This is Q64's accepted consequence and correct as
  specified — the module gate lands on the value, not the definition — but a
  one-sentence tier hint on that tab would close it. **Owner: a settings-page
  fast-follow.**

### For the Phase 6 plan (a process defect, not a code one)

- **Phase 5's plan carried Phase 4's Global Constraints forward verbatim but not
  Phase 4's Task 8, "reconcile the reference docs with what the phase shipped".**
  Consequence: `SECURITY.md` § 10's pentest-facing dispatch row still described a
  six-entity, `view_crm`-only world, and `FOLLOW-UPS.md` gained nothing from a
  phase that deferred 22 minors — this whole section is the late repayment.
  The same plan also specified a `parseGbpToMinor` "for the form" without
  specifying that the server action must **use** it, which is how review I2
  happened: the deliverable shipped and the guarantee did not. **A Phase 6 plan
  should either name a `SECURITY.md`/`FOLLOW-UPS.md` reconciliation deliverable
  or state explicitly that none is owed, and should specify wiring, not just
  existence, for anything it asks to be built.**

## Phase 6 — network

### Opened by Task 3 (discovery) — Q86, the cost ceiling, measured

- **Directory SEARCH is O(published profiles ACROSS THE WHOLE PLATFORM), not
  O(tenant) — the one list in the product where that denominator is every
  customer's published rows combined, not one workspace's.** Every other
  list's search cost note (Task 3 of Phase 2, above) is about one tenant
  growing large; this one is about the PLATFORM growing large, and it is
  worse for exactly the reason `lib/list/query.ts`'s own header names:
  `network_directory` carries no `organisation_id` predicate at all — Task 1's
  deliberate Constraint 9 deviation — so there is no tenant boundary to narrow
  the scan the way `contacts_organisation_id_idx` narrows the contacts case.

  **Measured, as `authenticated`, on a LOCAL stack seeded with 20,000
  published profiles across 3 organisations** (a throwaway `.sql` script —
  `generate_series`, one `insert` per row, `analyze`, one throwaway
  `auth.users` row + an active membership so the directory policy's "exists
  an active membership" term is satisfiable — run against the local stack
  only and never committed; `npx supabase db reset --local` afterwards, so
  the suites that followed ran on a clean world):

  | | plan | planner cost | buffers | time |
  |---|---|---|---|---|
  | (i) browse, page 1 | `Index Scan using network_profiles_directory_idx`, `Index Cond: (status = 'published')` | `8.18..4025.36`, estimating 15,000 rows will match | 257 | **1.668 ms** |
  | (ii) search ~4% (`Zephyr`, 800/20,000) — page | `Seq Scan on network_profiles`, `Rows Removed by Filter: 19200` | `7.77..895.94`, estimating 5 rows will match | 505 | **52.420 ms** |
  | (ii) search ~4% — count | same shape | `7.77..895.76` | 499 | **33.318 ms** |
  | (iii) search matching ONE row (`Quillfeather`) — page | `Seq Scan on network_profiles`, `Rows Removed by Filter: 19999` | `7.77..895.84`, estimating 2 rows will match | 499 | **21.901 ms** |
  | (iii) search matching ONE row — count | same shape | `7.77..895.76` | 499 | **21.958 ms** |

  *(Fix round 1, I3. Every planner row-estimate above is the number that
  ACTUAL EXPLAIN output attaches to that plan node — it is the planner's
  guess at how many rows will satisfy the node's own condition, not a claim
  about the corpus. The corpus is, and stays, 20,000 published rows across 3
  organisations — every seeded row was inserted `status='published'`, so the
  true published count is 20,000, not 15,000. That the browse plan's own
  Index Scan node estimates only 15,000 rows will have `status='published'`
  is a `pg_statistic`/`ANALYZE`-sampling artefact — Postgres's row-count
  estimator is not exact, and this run did not chase why it under-counts by a
  quarter — recorded here as an observed number, not smoothed over or
  reconciled into 20,000. The earlier version of this entry used "~15,000
  published rows" as if it were an assertion about the corpus, which
  contradicted the stated 20,000 and the Seq Scan arithmetic below; that was
  wrong, and this correction is why the sentence changed rather than the
  numbers.)*

  **THE BROWSE PAGE IS FINE.** `network_profiles_directory_idx` (`status,
  display_name, id`, Task 1) does exactly what its own comment promises: an
  `Index Scan` ordered by `display_name`, no sort, sub-2ms regardless of how
  many organisations have published. The ceiling is entirely in SEARCH.

  **THE MECHANISM IS THE SAME ONE `lib/list/query.ts`'s header names for
  `contacts`, and it is worth restating why it still applies here even though
  the browse path uses a real index:** `ilike`/`~~*` is not `proleakproof`,
  and Postgres will not promote a non-leakproof qual to an index qual on a
  relation carrying RLS security quals for the current caller. So even though
  `network_profiles_directory_idx` COULD in principle narrow the scan to
  `status = 'published'` first, the planner's own cost estimate puts a plain
  `Seq Scan` of the whole table (**895.94**, the search page's own row in the
  table above) below an index-driven visit to the published rows via that
  index (**4025.36**, the browse page's own row in the table above — the two
  are different queries' plans, cited by their own recorded cost rather than
  assumed equal, and the comparison is exactly what explains why the planner
  picks a Seq Scan for search and an Index Scan for browse) — ONE MORE reason
  a trigram index would not rescue this path even if one existed:
  `network_profiles.display_name` has no trigram index at all today, and
  adding a plain one would not change the leakproofness problem, only which
  unusable index the planner declines to use.

  **THE NUMBER THAT MATTERS: two sequential scans of the WHOLE PLATFORM'S
  published-profile count per search** (the page and the count, run in
  parallel by `fetchListPage` — sequential above only because EXPLAIN was run
  one statement at a time). At 20,000 rows that is **~44–86 ms of database
  time per search**, and it grows linearly with a number this phase does not
  control the growth of: every paying customer's published identity, summed
  across the whole product, not this one workspace's row count. 100,000
  published profiles (a plausible multi-year outcome, not a stress-test
  number) puts a single search in the **200–450 ms** range; 500,000 puts it
  over a second. Nothing about that failure mode is visible from inside one
  organisation's own usage — a workspace with three published profiles pays
  the platform's whole cost on every search keystroke.

  **NO SECURITY DEFINER SEARCH FUNCTION IS BUILT HERE, and that is Q86's own
  answer, not an oversight this entry is quietly reopening.** The contacts
  case's `private.contact_search(p_org, p_term)` pattern does not transfer
  cleanly here regardless: its whole safety argument is "re-establish the
  ENTIRE tenant policy inside the function body, because `SECURITY DEFINER`
  skips RLS and the body is the only control left" — and the policy being
  re-established there is a SINGLE-TENANT one
  (`organisation_id = p_org` plus record scope). The network directory's real
  policy is "every active member of every organisation, if the row is
  published" — i.e. already close to unconditional for the read case — so a
  `SECURITY DEFINER` wrapper here would not be re-implementing a narrow
  tenant check, it would be re-implementing "is this caller logged in and a
  member of something", which is a much smaller safety margin to get exactly
  right in a function body that bypasses RLS, for a feature this phase's own
  Global Constraints already flag as out of scope to build ahead into
  (`Q86: do not add a SECURITY DEFINER search function regardless of the
  numbers; a finding for the follow-up if they argue for one`). **This is
  that finding, and the decision it asks a reviewer to make explicitly**:
  either accept the linear-with-the-platform search cost as a known ceiling
  (with the rate limiter below as the mitigant) until profile counts actually
  approach the six-figure range, or scope a dedicated `SECURITY DEFINER`
  search function as real Phase 7+ work with its own security review — not a
  default reached for under time pressure inside a discovery task.

  **THE 30/MIN RATE LIMITER (`SECURITY.md` § 5) IS PHASE 7'S, NOT THIS ONE's,
  and its absence today is what makes the ceiling above a live exposure
  rather than a theoretical one.** Nothing in this codebase throttles how
  often one session can hit `/rest/v1/network_directory?display_name=ilike.*`
  today — a script issuing one request per second against a 100,000-profile
  platform costs the database ~300-450ms of Seq Scan time per request,
  indefinitely, from a single authenticated session on any tier including
  Free. **Owner: Phase 7's rate-limiting work, and it should name this
  endpoint by name rather than rely on a generic per-user budget catching it
  incidentally** — a generic budget sized for ordinary CRM list traffic (one
  tenant, index-backed) would be many times too generous for a query whose
  unit cost scales with the whole platform instead.

  **BUILT 2026-09-09, Phase 7 Task 5, and it DID name the endpoint by name.**
  `rate_limit_policies` carries `network_discovery` as its own category at
  30/60s, keyed on the TABLE (`network_directory`) in `lib/list/query.ts`
  rather than on a spec flag, so a copied spec cannot opt out and a plain
  BROWSE is metered as well as a search -- the O(platform) cost is paid with
  or without a term typed. The 31st read in a minute is refused through the
  real page function against a real Postgres in
  `tests/integration/security/rate-limit-network-discovery.test.ts`, which
  also proves the search budget is a genuinely separate one. **The sentence
  above stays true of ONE path:** a script hitting
  `/rest/v1/network_directory?display_name=ilike.*` DIRECTLY, without the
  app, is still unmetered and cannot be metered inside a PostgREST GET
  (read-only transaction vs. a counter write). DECISIONS-QUEUE Q107, and a
  named gate in `SECURITY.md` § 5 and § 10.

### Opened by Task 4 (request-to-connect, the accept unlock, the link picker)

- **FIXED in Phase 8 Task 9b fix round 1 (`20261017000000`, review C1 +
  m3): a sender could INSERT a connection request already `accepted`** and
  read the target's `connections`-level fields through
  `network_connected_profiles` without the target accepting — pre-existing
  since this task (the INSERT policy had no status term; the only status
  guard was BEFORE UPDATE), made silent by Task 9b job 3 (the target is
  emailed only about a `pending` row). Probed and measured leaking before
  the fix. Now a BEFORE INSERT trigger refuses any non-pending birth, a
  pre-filled response or a foreign `requested_by` (23514, every role but
  `postgres`/`supabase_admin`, so `service_role` too), stamps
  `requested_by`/`requested_at`, and the INSERT WITH CHECK repeats the
  status terms (`rls_phase6_network.sql` § NP, plus an HTTP block).
  **The responder half of m3 — CLOSED in fix round 2 (`20261020000000`,
  re-review N1):** it was not only cosmetic. Combined with unpinned party
  columns it let a SENDER rewrite its own pending request into an `accepted`
  connection FROM the target and back-date `responded_at` so the target was
  never emailed — measured leaking. Now `private.connection_request_bound_update`
  pins the parties, binds each answer to its side and stamps both
  `responded_*` columns; `authenticated` holds UPDATE on the three answer
  columns only. `rls_phase8_crm_audit_p3_6.sql` PN5c (a same-status
  `responded_at` edit) now runs as the exempt owner role, because no client
  can make that edit any more.

- **DISCHARGED in Phase 8 Task 9b job 3 (founder 2026-09-30,
  Q157(3)/Q174/Q45; `20261016000000`, `lib/email/network-notifications.ts`):
  a connection request is now EMAILED when it is received (to the requested
  workspace's active Owners and Admins), accepted and declined (to the member
  who sent it while still an active member of the sending workspace, else
  that workspace's active Owners and Admins — Q202), on the existing `pg_cron`
  tick and stamped in `private.notification_deliveries` only after
  `ok:true`. Each carries the counterparty's published display name at most
  and one link to `/[orgSlug]/network/requests`. `reminder_at` shipped in the
  same piece of work, as this entry predicted. Still true: a WITHDRAWN
  request is not emailed to anybody, and there is no in-app toast — the
  requests page and the hub's pending-received count remain the in-app
  surfaces.** The original entry, kept as history: **There is no
  notification of any kind when a connection request is sent, accepted,
  declined or withdrawn — this is the shipped design, not a gap.**
  CLAUDE.md's own `reminder_at` precedent (Q45: a task's reminder is stored
  and never delivered, because no notification subsystem exists at MVP) is
  the same answer here, by the same reasoning, for a second feature. A
  request is discovered exactly two ways: visiting
  `/[orgSlug]/network/requests`, or the pending-received count on the
  workspace hub's Network card
  (`countPendingReceivedRequests`, `lib/network/requests-list.ts`). Nothing
  else tells either side a request exists, was accepted, or was declined —
  not email, not an in-app toast, not a badge outside those two surfaces.
  **Recorded here because "we sent them a request and nothing happened" will
  read as a bug report to anyone who has not read this entry**, exactly the
  outcome the brief asked this file to head off. When a real notification
  subsystem is eventually built (Phase 7+, alongside `reminder_at` delivery,
  which has the identical shape and should very likely ship in the same
  piece of work rather than as two separate features), connection-request
  events are the second consumer this codebase already knows it owes one.

- **A `"use server"` module that illegally exports a plain value breaks its
  whole route at RUNTIME, and none of the five gates can see it coming.**
  Found during Task 4's own browser walk: `lib/network/link-search.ts`
  (a Server Action module) originally also exported
  `EMPTY_LINK_PICKER_SEARCH_STATE`, a plain object, alongside its one async
  action. Next.js refuses this with "A 'use server' file can only export
  async functions, found object" — but only when the route is actually
  requested by a browser. `tsc --noEmit`, `eslint`, `vitest run` (unit and
  integration) and even a correct psql/HTTP RLS run all stay green against
  this exact mistake, because none of them renders a Next.js route; and
  `pnpm build` — the tool that WOULD catch it at compile time — is forbidden
  in every worktree pointed at the local stack (this repo's own convention,
  since `pnpm build`/`pnpm start` resolve to the hosted project). The fix
  shipped in the same task: split the constant and its type into a plain
  module (`lib/network/link-search-state.ts`) that both the action and the
  client component import from, and the action module now exports nothing
  but its one async function.

  **No test guards this class of break**, and one is owed:
  `tests/unit/crm/source-shape.test.ts:937-945` already has the pattern to
  copy — it asserts a `"use server"` file's export surface for a different
  module. The identical assertion, generalised to walk every file in `lib/`
  carrying a `"use server"` directive and assert every one of its exports is
  either a function declaration/expression or a `type`/`interface` (never a
  `const` object, array or primitive), would make this class of break
  CI-visible (`vitest run tests/unit`) instead of browser-only. **Owner:
  whichever task next touches a `"use server"` module, or a dedicated
  hardening pass** — flagged here rather than fixed inside Task 4's fix
  round, since the guard's natural home is a shared, codebase-wide
  source-shape assertion (`tests/unit/crm/source-shape.test.ts` or a network
  equivalent), not a network-specific one, and scoping that properly is more
  than a one-line fix.

### Opened by Task 5 (the consolidated network-leakage suite)

- **THE SUSPENSION ANSWER, MEASURED: a counterparty STILL sees a suspended
  organisation's published profile in the directory — nothing about org
  suspension removes it from discovery. This needs a founder decision; the
  suite RECORDS it and does not change it.** `network_leakage_phase6.sql` § LJ
  suspends ALPHA (`organisations.deleted_at = now()`) and measures, from a real
  counterparty session, what remains visible. The finding, in full:
  - **An unconnected counterparty still reads the suspended org's published
    profile and its `network` fields** (LJ1/LJ1b — `Alpha Promotions`,
    `Bristol` still resolve). **A connected counterparty additionally still
    resolves its `connections` fields** (LJ2 — `bookings@alpha.test`). The
    cause is structural and one clause wide: `network_profiles_select_
    published_directory` (20260904003000) is `status='published' AND deleted_at
    IS NULL [on the PROFILE row] AND an active membership of ANY organisation`,
    and **neither term consults `public.organisations.deleted_at`.** Org
    suspension is invisible to the directory predicate.
  - This plan's stated default was exactly this (the org row's `deleted_at` is
    not in the directory predicate), so the measured behaviour is not a
    regression — but it is a **product decision a reviewer should make
    explicitly**: should suspending a workspace also pull its published
    identities out of the industry directory? If yes, it is a one-clause change
    — add `AND NOT EXISTS (select 1 from organisations o where o.id =
    p.organisation_id and o.deleted_at is not null)` to the directory view's
    predicate (and the connected view's), plus a founder sign-off that a
    suspended customer disappears from discovery. If no, this entry is the
    record that it was considered and left. **Do not change the policy without
    that sign-off** — it is a Task 6 doc-reconciliation / founder-default item,
    not a test's call.
  - **SECONDARY, AND IT CONTRADICTS A SHIPPED COMMENT (Task 1 ledger M2/M3).**
    The same directory policy means a suspended organisation's OWN members
    **still browse the directory and still read their own PUBLISHED profiles**
    through it (LJ5/LJ5b), while losing their `view_network`-gated keys — their
    drafts (LJ4), their `network_links` (LJ4b) and their ability to write the
    profile (LJ6). That directly contradicts the comment shipped at
    `supabase/migrations/20260904002000_...:42-45`: *"a suspended
    organisation's members cannot browse the directory or read their own
    network profiles until the workspace is reinstated."* The comment is
    wrong on both halves (browse, and read-own-published). **Owner: Task 6 doc
    reconciliation** — either correct the comment to match the measured
    behaviour, or, if the founder decides suspended members should indeed be
    locked out of discovery, that is the same one-clause view change as above
    plus a matching change to the directory policy's membership term. Recorded
    here so the divergence is a decision on the record, not a latent surprise.

- **M2 SURFACED A REAL SUITE HOLE, NOW CLOSED: nothing proved the directory
  VIEW's own `deleted_at is null` predicate is load-bearing.** The mutation
  battery's M2 (drop `deleted_at is null` from `network_directory`) reddened
  NOTHING across the whole `run-rls-tests.sh` run. The reason is that a
  soft-deleted published profile is kept out of discovery by TWO independent
  terms — the `network_profiles_select_published_directory` RLS policy AND the
  view — so for a COUNTERPARTY the RLS term is a backstop the view mutation
  cannot get past, and every counterparty-driven assertion in the leak suite
  and the network suite stayed green. The term still matters: an org's own
  members hold `network_profiles_select_view_network` (org-scoped, and per
  Constraint 7 not soft-delete-filtered), so the view's `deleted_at is null` is
  the only thing keeping a profile the org has UNPUBLISHED out of that org's own
  directory browsing. Closed in this task by `network_leakage_phase6.sql` § LB12
  (plant a soft-deleted published profile, assert ALPHA's own member reads it as
  0 in the directory view, with the base-table read and a live profile as the
  two controls, then tear it down). This is the "a mutation that reddens nothing
  is a hole you fix" discipline applied.

- **M11 is caught STRUCTURALLY, not behaviourally, and that is worth a note.**
  The battery's M11 (`network_connection_requests` SELECT policy →
  `using (true)`) reddens `rls_phase6_network.sql` NS1 (the set-form census:
  `using (true)` is not the `x in (select permitted_organisations(...))` form),
  so the mutation IS caught. But no BEHAVIOURAL assertion proves a non-party
  organisation reads zero connection requests — every request-read assertion
  filters by a party's own org id (LA4/LA5b, NU3/NU5b). A subtler mutation that
  KEPT the set form while widening it (`... or true`) would pass NS1 and leak.
  Not fixed here (it is not the brief's M11 and not a reddens-nothing hole), but
  recorded: a non-party unfiltered request-read assertion (GAMMA reads 0 total;
  BETA ≥ 1) is the behavioural belt to NS1's structural braces, owed by whichever
  task next touches the connection-request read path.

- **THE FUNCTION-BODY-DEPTH GUARD (§LF) IS A NAMED CI BLIND SPOT.** `leak.fn_closure`
  (`network_leakage_phase6.sql`, walking `pg_get_functiondef()` recursively from
  both masking views) is the only control in the whole leakage suite that
  inspects a FUNCTION BODY rather than a view definition, a policy expression or
  a rendered page — and it is psql-only, with no source-shape or unit-test
  equivalent, because there is no TypeScript source to read for "does a Postgres
  function transitively call another function that names a private table."
  `.github/workflows/ci.yml` does not run `run-rls-tests.sh` (§ "Phase 4 — CI
  decision", restated for this phase), so **a future migration that adds a
  helper function reachable from `network_directory` or
  `network_connected_profiles` and has that helper name a private relation
  reddens nothing in CI** — only a developer's own `bash
  supabase/tests/run-rls-tests.sh` run would catch it. Named here by Constraint
  19's own CI-note requirement ("a control with only a stack-suite guard is
  listed BY NAME in the exit document as a known CI blind spot, not left
  unstated") rather than left implicit in LF1's passing assertion.

### The readable base table, and the column-level-grants alternative not taken

`public.network_profiles` is reachable, whole-row, by any active member of any
organisation once a row is `published` and live —
`network_profiles_select_published_directory` (§ SECURITY.md § 2, as-built) is
deliberately a ROW policy, and a row policy cannot filter columns. The two
masking views are the only thing standing between that base-table grant and a
foreign caller seeing `organisation_id`, `entity_id` and every `hidden`/
`connections`-level value column. That is a real residual, not a hypothetical
one — Task 5's own `network_leakage_phase6.sql` § LB (IDOR/embed block) proves
the current call sites in `lib/network/` never take that path, but nothing in
Postgres itself refuses a *future* one.

**The alternative this phase considered and did not take: PostgreSQL
column-level `GRANT SELECT (col, col, ...)`,** revoking table-wide `SELECT` on
`public.network_profiles` from `authenticated` and granting back only
`id, entity_kind, display_name, status, published_at` (never the seven
publishable value columns, never `organisation_id`/`entity_id`) at the GRANT
layer itself, so a query that selected `contact_email` straight off the base
table would 42501 regardless of which policy let the ROW through.

**Argument for:** it would make "read the base table for a foreign
organisation" fail at the SQL layer even for a query this phase never
anticipated — the `no-private-table-in-network-path.test.ts` source-shape
census only catches an in-repo caller, not a raw PostgREST request or a future
Edge Function. A column grant is enforced by Postgres itself, the same
class of control `documents.storage_key`'s CHECK constraint is (§ SECURITY.md
§ 10, "the constraint layer binds every writer including `postgres`").

**Argument against, and why it was not built this phase:** (1) it would also
have to deny the OWNER's own columns for a foreign SELECT while permitting them
for the owner's own read — column grants are not row-conditional, so the same
grant applies to `network_profiles_select_view_network` (the owner's own-row
policy, which legitimately needs every column including hidden ones) and to
`network_profiles_select_published_directory` (the cross-tenant one) alike;
splitting that would need two relations with different column grants layered
under one logical table, which is most of the way to just building the views
better rather than adding a second, harder-to-reason-about control beside
them. (2) The application NEVER selects `public.network_profiles` for a
foreign organisation today — every discovery/profile-detail read goes through
the two views — so the marginal risk this closes is a future regression, not a
present one, and the source-shape census (`no-private-table-in-network-path
.test.ts`) already makes that regression CI-visible for any in-repo caller.
(3) `network_profiles`'s own-organisation SELECT (`network_profiles_select_
view_network`) already needs every column for the owning organisation's own
editor, drafts included, so a column grant narrow enough to protect a foreign
reader would be too narrow for the legitimate owner path without a second
relation. **Recorded as a real hardening option for Phase 7, not dismissed** —
worth revisiting if a future PostgREST-adjacent surface (a public API, an
Edge Function) is ever added that reads `network_profiles` directly rather
than through `lib/network/`.

### Every minor deferred by a task review, Tasks 1-5 (the ledger's own list, consolidated)

None of these is a live security hole — each was reviewed and deliberately
deferred; see `.superpowers/sdd/phase-6-network/progress.md` for the review
context each was raised in. T5-M1 is CLOSED (Task 6 reworded the false
size-tie comment at `tests/unit/network/no-private-table-in-network-path
.test.ts:196-204` (the assertion) and its module header — the guard itself was
always correct). Every other item below is still open, routed to whichever
phase next touches its file.

**Task 1 (the three network tables, the publish helper, the boundary):**
- **M1** — a policy comment claims a `network_links` row becomes unremovable
  once its target profile unpublishes, but the row can in fact still be
  soft-deleted; the comment overstates the lock. `20260904003000`.
- **M2** — the directory policy is not suspension-gated, which contradicts the
  comment shipped at `20260904002000:42-45` and `lib/network/access.ts:196-200`.
  Q88 (Task 5) measured the actual behaviour and is the disposition of record;
  the false comment is corrected in this same task (see CLAUDE.md's own note
  below and the additive migration).
- **M3** — a suspended organisation's own published profiles stay in the
  directory. Same finding as M2/Q88, from the opposite direction; Task 5's
  suspension probe (`network_leakage_phase6.sql` § LJ) is the measurement of
  record.
- **M4** — `manage_network_profile` is inert for a Marketing user on `artist`/
  `venue` kinds (the per-kind `entity_is_manageable` dispatch refuses those
  regardless of the general key), and `lib/network/access.ts` does not model
  the distinction — a pointer Task 2 closed for the CREATE picker
  (`manageableNetworkEntityKinds`, M4 in the Task 2 ledger entry) but the
  general-purpose `getNetworkPublishAccess` helper still does not distinguish
  per kind outside that one call site.
- **M5** — a self-correcting header artefact at `20260904003000:17-21` (a
  comment that describes an earlier draft of the migration rather than the
  shipped one).
- **M6** — `D8c` (schema_invariants.sql) uses a bare scalar subquery rather
  than an `exists`, and `NF1b`'s ratings census excludes `audit_network_row`
  from its sweep. Both cosmetic/coverage gaps, not incorrect assertions.

**Task 2 (the publish-field editor):**
- **T2-M1** — a dangling `aria-describedby` in `create-profile-form.tsx:168`
  (points at an element only rendered in one of two branches).
- **T2-M2** — the "publish a record" picker HIDES a kind the caller cannot
  manage rather than rendering it disabled-with-a-reason (`:66-78`) — the one
  place in the publish flow that does not follow Constraint 12's "hiding UI is
  not enforcement, do both" to the letter, because there genuinely is no
  write to refuse for a kind that was never offered.
- **T2-M3** — four parallel `kind -> segment` maps exist across the network
  module rather than one shared lookup (partially closed by Task 4's
  `NETWORK_ENTITY_URL_SEGMENT`, `lib/network/fields.ts` — the remaining
  duplication is smaller than the ledger entry originally found).
- **T2-M4** — `fields.ts`'s "Always shown" rows (`ALWAYS_NETWORK_FIELD_LABELS`)
  are exported but nothing renders them as a labelled row in the editor UI
  today — dead code, not a functional gap (the editor's "Name (always shown)"
  label is a separate hand-written string).
- **T2-M5** — `ProfileFieldValues.visibility` is a dead field on the exported
  interface (never read by the component that declares it).
- **T2-M6** — the editor's several server-action round trips (save, publish,
  quick-hide) run serially rather than inside one `Promise.all` where they
  could — a performance nit, not a correctness one.
- **T2-M7** — the per-kind manageability gate (M4's fix) is applied on the
  CREATE action only; every other network-profile action (update, publish,
  unpublish) relies on the database's own `entity_is_manageable` dispatch to
  refuse rather than mirroring the gate client-side — correct (Constraint 12
  is satisfied by the refused write), just asymmetric with the create path's
  UI-level narrowing.
- **T2-M8** — the disabled-editor note is dropped from the page when a field
  validation error is also present, so the two states' copy can collide.
- **T2-M9** — the read-gate copy on the profiles list/editor pages says
  "suspended" as the reason for ANY `view_network` refusal, not only a genuine
  suspension (there is no other reachable refusal reason today, so this is
  latent rather than currently misleading).
- **T2-M10** — the source-shape census that pins the render-gate discipline
  (module header's own note) matches by literal string only, not by AST —
  a rename that preserves the literal would pass unnoticed.

**Task 3 (discovery — browse and search):**
- **T3-M1** — `directory-results.tsx` re-parses `searchParams` three times
  across the page/results split rather than parsing once and threading the
  result.
- **T3-M2** — the axe fixture's `"Axe Directory Company"` name (pre-fix-round)
  carried a collision risk with concurrent runs on the shared local database;
  fix round 1 suffixed it with `world.orgSlug`, closing the live risk — the
  ledger item is the historical note.
- **T3-M3** — a stale citation to `finance.spec.ts:232` (the real strip-and-
  submit pattern is at `:265-287` as of the file's current line numbers) —
  re-verified at HEAD for this task's own report (Constraint 16) rather than
  fixed at the citing call site, since the citing comments are documentation
  of a pattern, not load-bearing line references a test depends on.
- **T3-M4** — `lib/network/access.ts:76`'s explanation copy says "Publishing"
  beside what is actually the CONNECT button's disabled note — a copy/paste
  residue from the publish-access helper, cosmetically confusing but not
  incorrect (the underlying `canWrite` boolean is correct for each caller).
- **T3-M5** — a profile's OWNER never sees their own profile's real
  `publishedAt` timestamp on the owner-view branch (`OwnProfileView`
  hardcodes it `null`) — `loadNetworkProfileById` does not currently select
  the column, so the owner's own page is honest about omitting it rather than
  wrong, but it is a missed row a future task could add cheaply.
- **T3-M6** — `discovery.ts:72` uses an `organisationId: ""` sentinel in one
  code path rather than an `Option<string>`/`null` — a style nit around a
  value that is never actually read downstream in that branch.

**Task 4 (request-to-connect, the accept unlock, the link picker):**
- **T4-M1** — Q78's ORIGINAL disabled-request-control render was a plain
  `<div>`, not a `<form>` — no strip-and-submit target existed at all, which
  is the exact defect class Task 4's own fix round closed (F1) for the
  Free-tier case; the ledger records the class name because the same mistake
  (a disabled control with nothing behind it to strip) is one a future screen
  could reintroduce independently. **CONFIRMED STILL LIVE, in the OTHER
  disabled branch, by a Task 6 mutation test.** `ConnectButton` has TWO
  disabled states — the tier/permission/suspended refusal (a real `<form>`,
  F1's fix) and `ownProfiles.length === 0` ("publish a profile of your own
  first"), which is a plain `<button type="button">` with no surrounding
  `<form>` at all, i.e. the identical defect class F1 fixed for the FIRST
  branch was never applied to the SECOND. Found by forcing
  `getNetworkConnectionAccess`'s tier check off (Task 6's own mutation 2,
  `exit-document.md`): a Free organisation can never hold a published profile
  of its own (Q76), so bypassing the tier check does not enable the control —
  it falls straight into this second, form-less disabled state, and a
  stripped-and-submitted click reaches nothing. **Not a live security
  hole** (the tier check is not actually broken — this was a deliberate
  mutation, reverted), but a real gap in defence-in-depth: if the tier branch
  were ever removed for `ownProfiles.length === 0`'s sake, this state would
  give no visible sign of the removal because there is no `<form>` here to
  redden either way. Owner: whichever task next touches `ConnectButton`
  should give this branch the same `<form action>` treatment F1 gave the
  other one, even though nothing currently strips-and-submits through it.
- **T4-M2** — no codebase-wide census yet for "every `\"use server\"` module
  exports only async functions" (the defect class the link-search.ts runtime
  break belongs to, this section's own Task 4 entry above) — the pattern
  exists narrowly at `tests/unit/crm/source-shape.test.ts:937` for one module;
  generalising it is the owed work, not yet done.
- **T4-M3** — one assertion hardcodes `toBe(1)` where a fixture-derived count
  would be more robust to an unrelated fixture change.
- **T4-M4** — `requests-list.ts` carries dead `searchColumn`/`searchLabel`
  fields inherited from the generic list-spec shape that this particular list
  does not use (it has no search box).
- **T4-M5** — `loadEntityName` resolves a linked record's display name per row
  rather than batched — bounded by the same page-size ceiling every list in
  the product carries, so not a pagination-bypass risk, just an N+1 query
  shape on an already-small page.
- **T4-M6** — the `pstd2` (Standard User, second fixture org) BETA membership
  grant in the psql suite is only safe as the LAST fixture block in its file —
  an ordering dependency rather than a self-contained fixture, flagged so a
  future reorder does not silently break it.

### Opened by the Task 6 review (the phase's post-hoc task review)

- **Four near-identical hand sign-ins across the e2e specs.** A
  `signInAsOtherMember` helper is duplicated verbatim in
  `tests/e2e/network.spec.ts` and `tests/e2e/tenant-breakout.spec.ts`, next to
  `network-discovery.spec.ts`'s and `network-connections.spec.ts`'s
  `signInAsFreeMember` twins. Promote one `signInAs(page, email)` into
  `tests/e2e/support/sign-in.ts` and delete the four copies — a pure refactor
  best done the next time a spec touches those files, not worth a churn-only
  diff of four specs now.
- **The measured suite baselines lived only in the untracked exit document,
  and now live here.** `.superpowers/sdd/` is gitignored, so
  `exit-document.md` dies with the worktree; `CLAUDE.md` tracks the Playwright
  count (77) and nothing else. The Phase 6 exit baselines, for Phase 7's brief
  to build against: **psql 1692/0, HTTP 338/0, vitest 1514 across 75 files,
  Playwright 77, contrast 16** — psql was 1686 at `f8b0f32`; the Q79 change
  (`20260907000000`) added NR6b/NR6c and the final-review audit fix
  (`20260907001000`) added NX5-NX5d. Any change to a suite updates this line
  in the same commit, the way CLAUDE.md's 77 is maintained.

### Opened by the final whole-branch review (pre-PR)

The review's one Important finding — publishing by direct INSERT emitted no
`network_profile.published` audit row — is FIXED (`20260907001000` + psql
NX5-NX5d), not booked. Two minors were deliberately left as work:

- **The `network_connection_requests` list-tenant-clause exemption is asserted
  structurally, not behaviourally.** `lib/list/query.ts` exempts the table
  from the automatic `.eq("organisation_id", …)` clause and each loader in
  `lib/network/requests-list.ts` supplies `to_/from_organisation_id` through
  an OPTIONAL `applyFilters` closure; the binding test only asserts the
  exempted relation has no `organisation_id` column, never that a reader
  supplies a tenant predicate. RLS bounds the blast radius (the SELECT policy
  is a from-OR-to disjunction), so a future omission is a *workspace*-scoping
  bug for a multi-org user, not a cross-tenant leak — but nothing enforces the
  "the tenant clause is only spelled differently" half of the comment's
  argument. A source-shape guard (any `fetchListPage` caller on an exempted
  relation with tenant columns must pass an `applyFilters` naming one) closes
  it.
- **The connect control never reflects a standing request.**
  `components/network/connect-button.tsx` has three states and none consults
  request status, so a caller with a live `pending` request sees an enabled
  "Request connection" whose click returns the 23505 sentence. Pre-existing
  and deliberate at Task 3 (the tenant-breakout argument for render-and-refuse
  is sound); slightly more visible since the Q79 change, because a declined
  row now sits beside a live one and the two behave differently on click. A
  status-aware button is a Task-3-shaped UI change, not a policy one.

### Q70-Q88, one line each, with the default taken

`DECISIONS-QUEUE.md` is gitignored and dies with the worktree — Phase 5 booked
exactly this loss as an open item ("the reasoning behind each answer does not
survive the worktree"). This is the tracked record. Full argument for each
lives in `~/.claude/plans/phase-6-network.md` § "Open decisions for the
founder" and in `.superpowers/sdd/phase-6-network/DECISIONS-QUEUE.md` while the
worktree lasts; the exit document restates all nineteen in the same form.

- **Q70 (connection requests at MVP):** in-network request-to-connect SHIPS
  between two logged-in customer orgs; public, logged-out profiles/requests do
  not — enforced by the `anon` grant plus the directory policy's membership
  term, not by route absence.
- **Q71 (profile field schema):** one closed vocabulary of 9 fields for all
  four kinds — `display_name`/`entity_kind` always shown, plus 7 opt-in
  fields (`headline`, `bio`, `city`, `region`, `country`, `website_url`,
  `contact_email`). No logo/avatar, genres, phone, socials, address, or
  capacity/tech specs at MVP.
- **Q72 (what an accepted connection unlocks):** nothing in any tenant table —
  only the publisher's own `connections`-level PROFILE fields resolve.
- **Q73 (private-record <-> network-identity matching):** explicit manual
  link only, from a search the user runs and confirms; no fuzzy matching, no
  auto-suggestion, no pre-filled search term.
- **Q74 (publishable entity kinds):** four — company, artist, venue, agency;
  one profile per (org, kind, entity id). Contacts (people) are never
  publishable.
- **Q75 (stored copy vs. source-column allowlist):** `network_profiles` stores
  its OWN values, written only on explicit publish/edit; no sync trigger, no
  join into private tables. Drift between the private record and the
  published copy is correct behaviour, not a bug.
- **Q76 (Free tier on the network):** browse/search/read only; publish,
  send/accept and linking all carry the `network_publish` entitlement term
  server-side. A Free org can be discovered by nobody and connect to nobody.
- **Q77 (permission keys):** three, all `survives_suspension = false` —
  `view_network` (all nine roles), `manage_network_profile` (owner/admin/
  manager/marketing), `manage_network_connections` (owner/admin/manager/
  booker/venue_manager/marketing).
- **Q78 (what the recipient sees; request message):** the requester is
  identified by one of its OWN published profiles, never a tenant/user name;
  no free-text message at MVP.
- **Q79 (request lifecycle / anti-abuse):** `pending | accepted | declined |
  withdrawn`. AS SHIPPED, a declined pair was TERMINAL (no re-request) — the
  one zero-cost anti-harassment control in a product with no blocking or
  moderation. **CHANGED BY THE FOUNDER 2026-09-07** (`20260907000000`): a
  declined pair MAY send a fresh request; the live-pair index now covers only
  `('pending','accepted')`. The declined ROW stays immutable (transition guard
  untouched — the re-request is a new row beside the old record), and
  withdrawn behaviour is unchanged. **The residual this reopens:** a declined
  organisation can be asked again immediately and indefinitely, and nothing
  meters it — the mitigation is the Phase 7 network rate limiter (Q86/Q87),
  NOT anything in the Phase 6 change, so that limiter is now more load-bearing
  than when it was deferred. **METERED 2026-09-09 (Phase 7 Task 5,
  `20260909040000`).** Note it needed its OWN budget rather than the discovery
  one: metering the directory bounds how fast an abuser can FIND
  organisations, not how fast they can pester ones they already found, and
  sending is a server action that never passes the list chokepoint. 10/hour
  **per organisation** — per-user is bypassed by inviting a colleague — and
  the crossing files a `rate_limit_tripped` alert, which is the first
  operator-visible signal of network harassment this product has had. The
  NUMBER is a recommended default rather than a founder ruling
  (DECISIONS-QUEUE Q112): it is the one row in `SECURITY.md` § 5 that document
  proposes rather than inherits, and changing it is one UPDATE plus one line.
- **Q80 (connection scope):** organisation-to-organisation, symmetric, and
  ORG-WIDE — accepting one request also resolves the requester org's other
  published profiles' `connections`-level fields.
- **Q81 (unpublish/soft-delete/downgrade):** unpublish sets `status='draft'`
  and leaves discovery immediately; a downgrade to Free never unpublishes or
  deletes, it only refuses further writes.
- **Q82 (`network_links` visibility):** strictly private to the linking
  organisation; the profile's publisher is never told who linked it. No
  counterparty read path exists at all.
- **Q83 (the bi-tenant request table):** an honest two-column shape
  (`from_organisation_id`, `to_organisation_id`, both `NOT NULL`, both
  indexed) rather than a single misleading `organisation_id`.
- **Q84 (audit actions):** six — `network_profile.published/.unpublished/
  .visibility_changed`, `network_connection.requested/.accepted/.declined`.
  Payload is identifiers and the visibility mask only, never a published
  value. `network_links` writes are not audited (private, reversible).
- **Q85 (custom fields / activity timeline / ratings guard):** no
  `network_profile` custom-field entity type, no activity-timeline source
  rows; plus a FORWARD structural assertion that no network view, policy or
  function body names `rating` in any form, live before a ratings table ever
  exists.
- **Q86 (discovery search cost + rate limit, opened by Task 3):** plain
  PostgREST + RLS, no `SECURITY DEFINER` search function (that shape is the
  one that leaks); keyset pagination with a server page ceiling; measure the
  real cost on a seeded corpus and record it honestly. The 30 req/min limiter
  named in `SECURITY.md` § 5 is deferred to Phase 7 and disclosed as
  unimplemented, not left implied. **CLOSED by Phase 7 Task 5**: built as
  specified, app-side at the list chokepoint, with no `SECURITY DEFINER`
  search function added -- the constraint held. The direct-PostgREST
  residual is Q107.
- **Q87 (accept the linear search ceiling, or build a dedicated search path —
  found mid-phase, Task 3):** accept the linear-with-the-platform search cost
  for MVP (measured: 44-86ms at 20k profiles, growing with the WHOLE
  platform's published-row count, not one tenant's), with the Phase 7 rate
  limiter as the mitigant; a dedicated, separately-reviewed search path is
  scoped future work rather than a default reached under time pressure.
  **The mitigant exists as of Phase 7 Task 5**, so the ceiling is now
  accepted WITH its throttle rather than bare; the dedicated search path is
  still unbuilt and still deliberately so.
- **Q88 (suspended-org network visibility — found mid-phase, Task 5):** leave
  the behaviour as measured for MVP — a suspended org's published profile
  stays visible to a counterparty AND to the suspended org's own members —
  and correct the false comment at `20260904002000:42-45` that claimed
  otherwise, rather than change the policy unilaterally. See CLAUDE.md's own
  "Network, as it actually shipped in Phase 6" section and this task's
  additive migration.

## Keyboard-a11y pass (side pass, branch `keyboard-a11y`)

- **Focus loss after a SUCCESSFUL server-revalidation swap — residual, scoped
  out deliberately (KA-6).** This pass fixed the two big classes of keyboard
  focus loss: the during-flight blur (`components/ui/button.tsx` — pending is
  now `aria-disabled`, focus survives every submit) and the client-side
  reveal/cancel unmounts (`components/ui/use-reveal-focus.ts` over
  delete-restore, request-actions, link-picker). What remains is the class
  where an action SUCCEEDS and the revalidated tree no longer contains the
  focused button: link-panel's "Make primary" (unmounts on `isPrimary`),
  representation-panel's Remove↔Restore/primary swaps, room-panel's
  Close↔Reopen, profile-editor's "Hide now", custom-field-editor's
  Remove→Restore section move, and every per-row Unlink/Detach/Delete whose
  row disappears. Each needs its own "where does focus belong once this row
  is gone" answer (usually: the next row's same control, else the list
  heading) — a per-surface design pass, not a blanket `#main` jump, which is
  why it is recorded instead of half-done. The mechanism to reuse when it is
  done: a ref + effect watching the action's success state, the same shape
  use-reveal-focus establishes.
- **The palette's per-keystroke cost has a first lever if it ever matters
  (KA-3):** `fetchListPage` always runs its count query; a `skipCount` option
  (additive, defaulting to today's behaviour) would halve the palette's
  round trips at the price of the "All N matching…" escape rows. Not built —
  eight bounded counts on a debounced, two-char-minimum search is fine at
  MVP scale, and the option is one more knob on a function whose knobs are
  all load-bearing.
- **`<details>` disclosures do not close on Escape** (room-panel rename,
  custom-field edit, representation edit — native behaviour: no browser
  closes a `<details>` on Escape). Tab-out always works, the `<summary>` is a
  persistent, correctly-announced trigger, and replacing a native disclosure
  with a scripted one to gain Escape would trade real robustness for a
  courtesy. Revisit only if user feedback asks for it.

---

## Phase 7 Task 7 (the permission-test gate) — exit notes

**DONE 2026-09-16.** The task itself is discharged; this section exists because
the final review found it was the only task in the phase with no entry here,
and because it shipped a real hardening change that appeared in none of the
three documents.

- **Q125 — three `UPDATE` grants were table-level where the write is
  three columns. SHIPPED, not owed.** `20260919000000` narrows
  `authenticated`'s `UPDATE` on `public.incident_alerts` to
  `(resolved_at, resolved_by)`, and `20260919001000` narrows both
  `organisation_billing_overrides` and `organisation_feature_overrides` to
  `(revoked_at, revoked_by, revoked_reason)` — exactly what the two
  `revoke_*` RPCs write. **The subtlety that makes such a narrowing real:** in
  Postgres a column-level `grant` does NOT revoke a prior table-level one, so a
  narrowing that forgets the `revoke` is a silent no-op. Both migrations issue
  the `revoke` first, and the net effect was confirmed on the live catalogue
  (`authenticated` holds `UPDATE` on exactly those columns, no later migration
  re-widens, `20260920000000` is comment-only). Every trigger guard is kept as
  defence in depth; three assertions were strengthened rather than relaxed to
  match. Recorded here, in `CLAUDE.md` § Superuser dashboard and in
  `SECURITY.md` § 2 — it was previously recorded only in
  `DECISIONS-QUEUE.md`.
- **Q126 — the server-action layer is not probed as a principal.** Mitigated
  rather than open: no module under `lib/admin/` or `lib/feedback/` imports the
  service-role client, and `tests/unit/email/service-client-census.test.ts`
  makes that an assertion (exactly three `lib/email/*` importers allowed) rather
  than an observation. **Genuinely open:** `lib/supabase/storage.ts` has no
  equivalent census. Full reasoning in `DECISIONS-QUEUE.md` Q126.
- **Two censuses, not two checklists.** The RPC and relation inventories in
  `tests/integration/security/phase7-permission-matrix.test.ts` are unfiltered
  `pg_proc`/`pg_class` queries asserted `toEqual` against the file's own lists
  plus a declared pre-Phase-7 allowlist, so a Phase 8 grant lands as a red test
  naming itself. **What a census still cannot catch** is named in
  `SECURITY.md` § 2 and stays owed: the RPC census matches on `proname` rather
  than signature (an overload is invisible), a function left with
  `proacl is null` inherits EXECUTE to PUBLIC and yields zero rows from
  `aclexplode`, and the page census globs `app/(app)/super/**` only, so a Phase
  8 route handler under `app/api/**` reading platform data would not be seen.
  Three one-line additions, all cheap, none of them made.

## Phase 8 Task 4 (data exports)

- **Task 6 owes the bytes, and read-time expiry is only half a retention
  rule.** `public.export_jobs.expires_at` makes an archive unreachable after
  seven days, by everybody including its own requester, with nothing
  scheduled. The OBJECT in the `exports` bucket is still there. Three orphan
  classes join the retention/GC job: an expired archive; the object of a job
  whose requester's account was deleted (the row cascades, the bytes do not);
  and the object of a job that uploaded and then failed to stamp (the runner
  removes it on the spot, so only a crash between the two leaves one).
  `/legal/data-retention` version 3 says all of this in words rather than
  implying the file is gone.
- **A job stuck in `running` blocks its subject, and nothing reaps it.** The
  runner marks a failure itself, but if the stamp of that failure also fails
  (a database blip at exactly the wrong moment) the row stays `running`, the
  one-live-job partial unique index refuses the next request, and the person
  sees "an export is already being prepared" for ever. It is loud rather than
  silent — the page says so and the log says so — and the fix is one line in
  Task 6's sweep (fail anything `running` for more than an hour). Q166.
- **The account export is ONE live job per person and the workspace export is
  one per WORKSPACE**, which means two Admins pressing at once queue rather
  than double the work. The second Admin's refusal is a `23505` rendered as
  "an export is already being prepared", and they cannot see whose it is —
  there is no cross-member read of the register. That is the deliberate
  consequence of "an archive is a snapshot taken under ONE person's rights";
  if it ever reads as a bug, the fix is a shared *workspace* export with a
  stated access basis, not a relaxed SELECT policy.
- **CLOSED in Phase 8 Task 9b job 2** (founder 2026-09-30, Q157(3)/Q174/Q45;
  `20261015000000`): the requester is now emailed when the export is ready,
  linking the in-app export page only, stamped `ready_notified_at` after
  `ok:true`. The original entry, kept as history: **Nothing tells the
  requester the export is ready.** Q45 for the seventh
  feature: the page is the whole notification, and a person who starts an
  export and closes the tab finds out by coming back. The sender exists
  (`lib/email/send.ts`) and the seam is obvious (a `notified_at` column would
  do it); it is not built.
- **`export_organisation_data` is the THIRD permission key with
  `survives_suspension = true`**, after `view_crm` and `end_support_access`,
  and the set is asserted BY NAME in two psql suites so a fourth cannot
  arrive unnoticed. The justification is Q88/Q92's own: the 60-day window
  after a suspension or closure is exactly when a customer needs their copy.
  An export grants no write, and the archive is built under the requester's
  own read rights, so a suspended workspace's export is read-only by
  construction rather than by a rule somebody has to remember.
- **`lib/supabase/storage.ts` still has no importer census** (Q126, above),
  and this task added a fourth importer (`lib/export/runner.ts`). The
  service-role TABLE client's census WAS extended, so the runner is declared
  there; the storage one remains the gap Q126 names.
- **The ZIP writer is a 150-line subset of the format** (local headers,
  DEFLATE from `node:zlib`, a central directory, an end-of-central-directory
  record) written rather than depended on, because a ninth runtime dependency
  is a supply-chain decision and `tests/unit/legal/storage-census.test.ts`
  makes adding one deliberate. No ZIP64: the limits it implies (4 GiB
  archive, 65 535 entries, 4 GiB per entry) are all unreachable under a 40 MiB
  ceiling and all three are refused explicitly anyway. If an archive ever
  needs to be bigger, ZIP64 is the change, not a bigger ceiling.
- **A second bearer secret and a second Vault pair are owed at deploy**
  (`SECURITY.md` § 15). Unlike the digest's, a missing pair does not stop
  exports — the in-process nudge still runs them — it removes the RETRY for a
  job whose nudge died with its process. That failure is invisible from
  inside the product and its cost is a person waiting.

## Phase 8 Task 5 (erasure)

- **THE STORAGE-CLIENT CENSUS (Q126) IS STILL OWED, AND THIS TASK ADDED A
  FIFTH IMPORTER.** `lib/supabase/storage.ts` has no importer roll;
  `lib/erasure/runner.ts` joins `lib/crm/documents.ts`,
  `lib/feedback/screenshot.ts`, `lib/export/runner.ts` and the feedback
  screenshot route. The service-role TABLE client's census was extended (the
  runner is declared there), so what is missing is the same shape for the
  STORAGE client — and the erasure runner is the first importer whose reach
  includes `remove()`, which is the one Storage verb that destroys something.
  Whoever builds it should start from
  `tests/unit/email/service-client-census.test.ts`, which is the working
  pattern.
- **Nothing tells the person their account has been deleted.** Q45 for the
  eighth feature. The page says "being deleted" and the session then stops
  working; there is no email, no final confirmation and no receipt. For this
  one feature that is arguably correct — the address to send it to is one of
  the things being deleted — but it is a decision, not an oversight, and it
  means a FAILED erasure is discovered only by signing back in and looking at
  `/account/erase`. **Half-closed in Phase 8 Task 9b job 2** (`20261015000000`):
  a failed erasure now emails the SUPERUSER a count and a `/super` link
  (founder 2026-09-30); the person is still not emailed either way, and the
  failure reason still has no dashboard view (Q200).
- **A job left `running` blocks its subject for ever**, exactly as Q166 says
  of the export runner, and the consequence is worse here: the
  `erasure_jobs_one_live_account_job` index refuses the next ask, so a person
  whose erasure died between the claim and the outcome-write cannot try again
  and is told "your account is already being deleted". Task 6's sweep should
  reap both registers with one rule.
- **`data_subject_requests.fulfilment_reference` can dangle.** An `access`
  request fulfilled by an export points at a `public.export_jobs` row, and
  that row is `ON DELETE CASCADE` on `requested_by` — so erasing the account
  deletes the export job and leaves the (kept, anonymised) register row
  pointing at an id that no longer resolves. The column has no foreign key, so
  nothing breaks; what is lost is the ability to say WHICH archive answered a
  request, for an account that no longer exists. Either give the reference a
  soft resolution ("an export, since deleted") or accept it in words on the
  operator's page.
- **The consent ledger goes with the account and the register does not**, and
  the asymmetry is deliberate with a measured reason (the alternating-chain
  invariant — see `SECURITY.md` § 8 and Q173). It is the one place where two
  sibling questions, Q148 and Q158, were answered differently, and it is the
  thing counsel is most likely to want changed.
- **`erase_organisation()` has no caller in the product yet.** Task 6 is the
  caller. Until then it is a tested primitive with one exception path reaching
  it (Q131's empty-solo-workspace case), which is deliberately the narrowest
  possible first consumer.
- **The Q131 guard is now "would this leave no active OWNER", locked, and
  asked at the membership table too (Task 5 fix round 1, Q176).** Two routes
  to an ownerless, memberless, unmanageable workspace were reproduced: an
  aal2 Admin demoting the sole Owner (nothing guarded
  `public.organisation_memberships`), and two co-Owners erasing concurrently
  past an unlocked read. Both are closed — advisory lock plus `FOR UPDATE`
  before the guard reads, a post-delete re-assertion, and
  `private.membership_keeps_an_owner()`. **What is still owed:** the guard now
  also blocks a NON-owner member's own erasure when they are the last active
  member of an ownerless workspace that still holds records, and the way out
  it names (transfer ownership, or close the workspace) needs an Owner they do
  not have — the operator closing the workspace at `/super/organisations` is
  the escape hatch, and nothing in the product tells them so. Q176 carries it.
  **Fix round 2 fixed the readable half of that (N2/Q178):**
  `private.account_erasure_blockers()` carries a third reason,
  `no_owner_to_transfer`, and both the database's refusal and the
  `/account/erase` page now tell that person the workspace has no owner, that
  they cannot fix it, and that support must close it, under its own hint
  `workspace_has_no_owner`. The escape hatch is unchanged and is now named.
  **What is still owed is the founder half of Q178:** whether step 8b should
  widen from `other_members = 0 and is_empty` to `other_members = 0` for a
  workspace with no active Owner at all, so the last member of an ownerless
  workspace takes it with them. That destroys records rather than stranding
  them, which is why a fix round did not take it.
- **A direct `delete from auth.users` still strands a workspace (Task 5 fix
  round 2, N3 -- risk accepted, not closed).**
  `private.membership_keeps_an_owner()`'s account-cascade exemption is keyed
  on "the `auth.users` row has already gone", which only an account deletion
  can satisfy, so it cannot be borrowed by something that is not one -- but
  it does not tell `private.erase_account()`'s deletion from an out-of-band
  one. There is no `auth.admin.deleteUser` call site anywhere in the product;
  the residual is an operator using Supabase Studio's Auth page, after which
  `private.account_last_owner_workspaces()` names what was stranded and
  `/super/organisations` closes it. Closing it properly, with a
  transaction-local GUC the chokepoint sets so the cascade FAILS instead of
  stranding, is **Q179**.
- **The C2 lock's cost is now written down (Task 5 fix round 2, N4).**
  `FOR UPDATE` on every membership row of every live workspace the subject is
  an active member of, held for the whole erasure transaction, blocks every
  concurrent role change, revoke and removal in those workspaces; inserts are
  unaffected, so invitations still work. Measured: 1.22 ms to take the locks
  over 5 workspaces and 250 membership rows, held for the 29 ms an erasure
  takes end to end. `private.account_lock_workspaces()`'s own comment carries
  it, which is where a future reader will look.
- **The roll's catalogue query was widened in fix round 2 (N1), and three
  shapes are deliberately left open.** A natural `user_id uuid primary key`, a
  uuid inside a composite primary key, a `uuid[]`, a domain over uuid and a
  materialized view's column now all make the erasure refuse. A uuid inside
  `jsonb` or `text` does not (a content scan is the only thing that would
  find one; `incident_alerts.details` is the single instance and is rewritten
  by hand for exactly that reason), and nor does a column in any schema but
  `public`/`private` (widening pulls in `auth`, `storage`, `realtime` and
  `vault`, which this product does not own and cannot classify -- every
  erasure would refuse on somebody else's catalogue).
- **A third bearer secret and a third Vault pair are owed at deploy**
  (`SECURITY.md` § 15), and this one runs DELETIONS. It cannot choose one —
  the route takes no argument — but a missing pair removes the retry, and the
  cost of that is higher than for exports: the person cannot even ask again.

## Phase 8 Task 6 — the retention and garbage-collection job

**Six long-open entries close here, and each one closes with what actually
shipped rather than with "done".**

- **Q52 — document bytes. CLOSED.** A soft-deleted document's file is purged
  by `private.sweep_document_bytes()` plus the runner, once the parent
  record's retention class has run out.
  `private.document_retention_class()` derives that class rather than being
  told it: `financial` (7 years) when the document is attached to an EVENT
  that carries financial entries, `operational` (2 years) otherwise — which
  is the only reachable meaning of "the parent record is financial", because
  `document_links.entity_type` is allowlisted to six CRM entities and
  `financial_entry` is not one of them. It counts SOFT-DELETED links and
  soft-deleted financial entries too: misreading a class as financial costs
  five years of storage, misreading it as operational destroys a record five
  years early. `documents.bytes_purged_at` is the new column, and it is the
  difference between "we deleted this file because we are no longer allowed
  to keep it" and "this file is missing and we do not know why".
  **One claim in the original Q52 wording was NOT re-confirmed and should
  not be repeated:** "deleted documents still count toward storage". The
  health snapshot's storage figures filter on `deleted_at is null`, so a
  soft-deleted document was already outside the number the operator reads.
  What was true, and is what this fixes, is that the BYTES were still stored.
- **Q110 — stale rate-limit counters. CLOSED.** Swept seven days after the
  window closes; the longest live window is 24 hours, so seven days is a
  week of slack past the longest thing that could still be counting.
  `FOR UPDATE SKIP LOCKED`, because a counter is written by every request in
  the product and a sweep must never make one wait.
- **Q117 — incident alerts. CLOSED, with the rule proposed here because
  nothing had ever been written.** A RESOLVED alert and its `details` JSON
  (which carries subject ids) go one year after resolution — the same period
  as the audit rows they are evidence alongside. **An OPEN alert is never
  purged at any age**, and that is the half that matters: an unresolved alert
  is an outstanding operational problem, and deleting it because it is old
  would delete the reason nobody has looked at it yet. The clock therefore
  runs from `resolved_at` and not from `created_at`.
- **Q120 — feedback and its screenshots. CLOSED.** The row goes at two years,
  and the object goes FIRST: the row sweep refuses a row whose screenshot is
  still in the bucket, because deleting it there would leave an untracked
  image of somebody's screen that only the orphan sweep would find, a day
  later.
- **Q166 — a job stuck `running`. CLOSED, and it is not a deletion.**
  Anything `running` for more than an hour is marked `failed` with a recorded
  reason. The row survives and now says what happened; what is released is
  the one-live-job partial unique index, which was permanently locking a
  person out of a statutory right because of a transient fault at exactly the
  wrong moment. The erasure sentence says NOTHING WAS DELETED and means it:
  the whole erasure is one transaction, so an interrupted one rolled back.
- **Q175 — failed erasure jobs. CLOSED at 90 days**, as Task 5 recommended.
  A SUCCEEDED job is kept FOR EVER and is deliberately not on the schedule:
  both its user columns are already null, so it is pseudonymous, and it is
  the evidence that a statutory deletion was performed.
- **Q88/Q92/Q102 — the 60-day workspace purge. CLOSED**, by calling
  `private.erase_organisation()` — the first caller that primitive has ever
  had. Reinstatement needs no special case at all:
  `private.organisation_lifecycle_sync()` clears `retention_expires_at` the
  moment `deleted_at` is cleared, so a reinstated workspace has no deadline
  for the sweep to find. The rule is "while it is closed", not "59 days yes,
  60 days no". Closing an already-suspended workspace restarts the clock, by
  the same trigger.
- **Q126 — the storage-client census. CLOSED AND BUILT**, in
  `tests/unit/security/storage-client-census.test.ts`, because this task is
  its SIXTH importer and the first whose reach is deletion across every
  bucket. It found two things on its first two runs: the real importer list
  is SEVEN files and not the five the inventory implied
  (`lib/feedback/actions.ts` and `lib/feedback/screenshot.ts` are two, not
  one), and its own table-access detector flagged `lib/crm/documents.ts` and
  `lib/feedback/actions.ts` — the product's correct
  `storage.storage.from(...)` shape — for want of a lookbehind.
- **Q135 — what "archived" means. CLOSED as the recommended default.** The
  audit-log viewer defaults to the last 30 days and SAYS SO on the page: a
  silent default makes "the log does not go back that far" and "we are only
  showing you a month" look identical, and only the second is fixed by typing
  a date. The rows stay in Postgres; the delete happens at a year. There is
  no cold store and `/legal/data-retention` v5 says so in those words.
- **Q179 — the unsanctioned account deletion. CLOSED**, with the reach
  measured rather than feared: the refusal fires ONLY where the old code
  would have stranded something (the subject is the last active Owner of a
  live, non-empty workspace), so every other `delete from auth.users` in the
  repository is unaffected. The marker is a `PGC_USERSET` GUC, so a direct
  database session can still set it — Q123's admitted limit, restated: this
  turns an accident into a refusal, it does not stop somebody with a shell
  who has decided to do it.

**And what is owed after it.**

- **Soft-deleted CRM rows are on NO clock of their own (Q180).** Every
  contact, company, artist, agency, venue, event, task, meeting, note and
  financial entry a workspace soft-deletes stays until the WORKSPACE is
  purged. `CLAUDE.md`'s "soft-delete operational records ... subject to the
  retention policy" arguably asks for more than that. This task deliberately
  did not build it — a job that silently began hard-deleting customers' own
  records two years on wants a founder's signature first — and every such
  table is classified `retained_with_workspace` in
  `private.retention_subjects()` so the question is visible in the roll
  rather than absent from it.
- **Nothing emails anybody about a retention run** (Q45, for the ninth
  feature). A run that has been refusing its sanity ceiling every hour for a
  month is visible on `/super/health` and nowhere else. **NO LONGER TRUE since
  Task 6's fix round 1** (Q182, `20261004004000`): a refused or failed LIVE run
  files a `retention_run_refused` incident alert, which the existing digest
  emails to the operator. See the fix-round ledger below.
- **A fourth bearer secret and Vault pair are owed at deploy**
  (`SECURITY.md` § 15), and the consequence of forgetting this one is QUIET
  rather than loud: the job simply never runs, `/super/health` shows no runs
  at all, and data past its retention period is kept.
- **The retention periods are still a working default pending counsel**
  (Q133). What this task bought is that the answer is one migration.

### Task 6 fix round 1 — what the review changed, and what is still owed

The review graded the job MAJOR. `SECURITY.md` § 8 ("What the review of the
retention job found") carries the as-built description; this is the ledger.

- **"Nothing emails anybody about a retention run" (above) IS NO LONGER TRUE
  — CLOSED as Q182's recommended default.** A LIVE run that refuses or fails
  files one `retention_run_refused` incident alert per distinct
  (sweep, reason), which the existing digest emails; a later clean run
  resolves it as the system. Not for a switch somebody chose, not for an
  overlap, not for a preview. The customer still hears nothing about
  anything (Q45); this is the OPERATOR's signal.
- **The audit purge's sanity ceiling still cannot drain itself, and that is
  now a stated limit rather than a surprise (m5, Q184).** It judges EVERY row
  past the period while each run deletes at most 500, so a genuine backlog
  (the job switched off for months, or first enabled on an old database)
  refuses every hour for ever. What changed is that it is never silent: the
  alert carries both row counts. **Today the only release is a reviewed
  migration reissuing `private.audit_purge_ceiling()`, restored afterwards.**
  Q184 asks whether to build a no-deploy, time-boxed, audited release on
  `/super/health`; recommended default yes, behind step-up, 24 hours, the
  hard floor and the per-run ceiling untouched.
- **A purged document cannot be restored, and the page does not say so yet.**
  The database refuses it for every writer
  (`documents_purged_implies_deleted`) and `restoreDocumentAction` matches
  nothing, so the person reads the ordinary "nothing to restore" answer.
  `/[orgSlug]/documents/deleted` still OFFERS Restore on a row whose file is
  gone, and shows nothing that distinguishes "deleted under the retention
  policy" from "deleted". Nothing reads `bytes_purged_at` in the application
  at all. Two years away at the earliest; **Q185.**
- **The clock derivation's three stated limits** (`20261004001000`): it
  matches column NAMES in function source, so it over-approximates (two
  false candidates today, each excused with a reason in the roll); it cannot
  see a clock that a TRIGGER computes from another column (one exists,
  `organisations.lifecycle_changed_at`, named by hand); and it asks about
  client roles only — `service_role` holds UPDATE on the job tables' outcome
  columns for the runners, and those guards are their own suites' subject.
- **The retention roll's schema limit** (`20261004005000`, m1): `public` and
  `private`, plus materialized views in both. A table in any OTHER schema is
  not seen. Decided the way Task 5's roll decided it; a schema allowlist was
  rejected because every psql suite creates a results schema and would trip
  it on every developer database.
- **`/legal/data-retention` is at version 6 and still unreviewed.** It now
  says what is NOT deleted (Q183, recommended default, taken) and carries
  three new counsel gaps that are real questions, not placeholders: whether
  financial records must be DELETED at seven years and from what date;
  whether inactive accounts should be deleted at all and with what notice
  (Q180); and whether a customer-facing permanent delete of a single record
  is required before launch — there is none today, short of closing the
  workspace.
- **`tests/unit/legal/seed-matches-catalogue.test.ts` stops at
  `20260925004000`.** Its `currentBodies()` rebuilds "every page's current
  body" from five migrations and has not been extended for the four
  data-retention versions since (v3 Task 4, v4 Task 5, v5 and v6 Task 6) or
  for data-subject-rights v4/v5. So its hosting-and-transfer consistency
  check has not read the CURRENT retention or rights page for three tasks.
  Pre-existing; found while binding v6. `data-retention-v6.test.ts` covers
  v6 on its own. Owed: extend the chain, or replace it with a read of the
  final body per slug.

## Opened by Phase 8 Task 9b fix round 1 part B (I2, I3, minors)

- **m4 ACCEPTED, not fixed: the digest, lockout and Telegram stamps are written on the APP clock.** `lib/email/incident-alerts.ts` and `lib/email/lockout-notification.ts` send `new Date().toISOString()`, and `private.incident_alert_resolution_guard()` returns before it reads a stamp for `service_role` (row security inactive). Forcing `now()` there means reissuing that shared guard (latest `20261014000000`) so it overwrites the three seams for EVERY writer, `postgres` fixtures that back-date `notified_at` included, plus a full 24-suite re-run to find them. The cost is a drift of milliseconds to seconds on a column that is server-only by grant and guard; nothing reads it as evidence of anything but "sent". Fold into the next migration that touches that guard.
- **m6 ACCEPTED, not fixed: the route's PostgREST reads and stamp RPCs carry no timeout.** `createServiceClient()` is shared with the export, erasure and retention runners (`tests/unit/email/service-client-census.test.ts`), whose RPCs legitimately run long, so a blanket `global.fetch` abort would break them. The supported way is a per-caller timeout on a second factory, and it changes the overlap arithmetic (each of the eight deliveries gains a resolver read and a last in-flight stamp, ~+10 s each at a 5 s bound, ~520 s against 600 s) and the clock function's reissued comment. Owed with the next change to that route.
- **I3 residual, stated:** a bare domain in a person's text (`evil.example/login`) is left as typed, and some mail clients autolink it. Removing dots between words would mangle ordinary names. Every `<scheme>://` and `www.` is removed to a fixed point and the final render is checked case-insensitively.
- **I2 residual, stated:** the fair order gives each workspace one slot per round, so a tenant owning 30 or more workspaces could still fill a 30-row batch until the seven-day window closes. A Brevo PERMANENT rejection (a bad address) is still retried for seven days, because `sendEmail()` does not distinguish permanent from transient failures; the fair order stops it monopolising the batch. The DSR and export notice queues carry no `refuse` path: their content is the database's own enums and dates, and a refusal there would be a code defect, not hostile content.

## Opened by Phase 8 Task 9b fix round 2 (N1, N2, N3)

- **N3 ACCEPTED as built, mitigation proposed: any `build()` throw now drops a notice permanently.** `deliverEach` (`lib/email/requester-notifications.ts`) records `content_refused` through `mark_notices_undeliverable` for ANY exception a notice builder throws, not only for a person's hostile text. That includes `slugOrRefuse` on a malformed slug, a date the builder cannot parse, and any future code or configuration bug, a bad deploy included. Before I2 such a row was retried every tick until the code was fixed; now up to 30 rows a tick are marked undeliverable for good and only logged, so a broken release LOSES the connection and task-reminder emails it touches instead of delaying them. **Default as built:** keep the terminal record, because I2's poison-row guarantee depends on it and the loss is bounded by the seven-day notice window anyway. **Proposed mitigation (owed, not built):** record `content_refused` only for a `NoticeContentError` raised while reading a person-authored field (`oneLine` input, the one-link check), give the builders' own invariants (slug, uuid, date, allowlist) a distinct error class that is logged and left UNSTAMPED so the next tick retries it, and alert (the Task 5 Telegram channel) when a tick sees more than a handful of builder throws, since that is the signature of a deploy fault rather than of hostile content.

## Phase 8 Tasks 7-9c — owed at the PR (final review B, F12)

Final review B (`.superpowers/sdd/plan-the-whole-build-synthetic-thompson/phase-8-final-review-B.md`)
found that items owed by Tasks 7, 8, 9a and 9c lived only in `progress.md`
and the task reports. This is the deduplicated list, copied here so the
ledger holds them. The 9b residuals (m4, m6, the bare-domain autolink, the
30-workspace batch, N3) are already above, under "Opened by Phase 8 Task 9b".

- **F-T7-1.** REFUSAL PARITY runs in 50+ s against a 60 s timeout. Split it
  or give it its own timeout, never retries (progress.md, Task 7).
- **Task 7 N1/N2.** Accounts erased before `20261007000000` are not
  revisited, and a concurrent writer can land an id after the 10b scan.
- **F-T8-1.** The 5 s unit-test timeout under load (progress.md, Task 8).
- **Task 8 M2/M3, accepted and carried.** The "guard" mechanism is only "a
  42501 raised by the function", and the destructive-primitive census is
  derived from a name regex (`task-8-rereview.md:79`).
- **Task 1 fix round 2 (`13141f0..7ab1922`) and Task 2 fix round 2
  (`f239ed7..c545f7e`)** were never independently re-reviewed; handed to the
  final review (Reviewer A's scope).
- **Q218.** Six `/[orgSlug]/network/*` pages still say "This workspace is
  suspended" in a closed workspace (`network/{page,links,profiles,profiles/[id],requests,[profileId]}`).
  `linked-identity-section.tsx` and `support-access/page.tsx` were not checked.
- **Q189. CLOSED (`20261031000000`).** An Owner's or Admin's edit of
  `organisations` is audited as `organisation.updated`; the census has no
  `unaudited` table left.
- **9c re-review 2 n1-n3.** The active-Owner check takes no membership lock,
  the suspended-ownerless branch of N2 is untested, and
  `acknowledged_no_backup` is derived rather than taken from the parameter
  (`task-9c-rereview2.md`).
- **9c m7.** The app guards in `closeMyWorkspaceAction` and the
  `/super/closures` actions were not mutation-tested
  (`task-9c-review.md:130`); the integration test covers the RPC.
- **9a 17c.** The integration layer of the reason-check mutant was not run
  (`task-9a-report.md:183`), and the m-test at `task-9a-rereview.md:90` was
  not mutation-tested.
- **9b gap.** `/super/health` shows no per-channel delivery status, and the
  `/super` hub shows no open-alert count (`task-9b-report.md:20`).
- **`private` is blind to the export and audit censuses** (9b residual).
- **Deploy-time items.** Four runner bearer secrets and Vault pairs, the
  Brevo env, the Telegram env, region `eu-west-1`, the IONOS host region
  (PENDING) and the real malware scanner (Q42) — all in `SECURITY.md` § 15;
  none is configured by the repo.
- **The permission-matrix total at the tip** (F5). Last measured 596 at Task
  9c job 3a; re-measure on the next reset with `vitest run
  tests/integration/security/phase7-permission-matrix.test.ts` and append it
  to `CLAUDE.md` § Testing gates and `SECURITY.md`.
- **CI is still a subset.** Q169 (heavy jobs on PRs and main for a month) is
  ruled but not built; unscheduled, a Phase 10 candidate (Phase 9 excluded it
  and the `infra-parallel-stacks` merge by spec; no decision has been taken).
- **Final fix rounds.** A clean full psql/HTTP runner pass at 241 migrations
  (round 2's run was red only on the HTTP twin's own `t`/`true` expectation
  strings, corrected after the run), and `documents.spec.ts` after round 1's
  scan-verdict change (not run: free RAM below the floor).
- **F1 — a new Subprocessors version is owed.** The Brevo row now names the
  Phase 8 notification emails in both `docs/sub-processors.md` and
  `lib/legal/sub-processors.ts`, and `/legal/subprocessors` renders the
  module, so the page's table changes as soon as the code ships. No dated
  version was published: the body text itself does not change, and a v4
  would move the version pins in `rls_phase8_legal.sql` (LF2) and
  `run-rls-tests.sh` (the `lg_same` check), which needs a database to verify.
  Publish v4 (through `/super/legal` or a migration in the
  `20261008000000` pattern, with those two pins moved) and have counsel check
  that the Privacy Notice covers these emails.
- **F13 — a scope contradiction, flagged only.** `CLAUDE.md` § Scope
  discipline lists "public profiles and connection requests" as Not MVP,
  while the Decisions log ("Network discovery: request-to-connect") and
  Phase 6 shipped connection requests. Suggested wording: "public
  (logged-out) profiles". Left for the founder (DECISIONS-QUEUE Q230).
- **F14 — `/super/closures` shows member names (founder awareness).**
  `CLAUDE.md` § Superuser dashboard says the dashboard shows "only aggregate
  metadata"; the reassign picker lists a closed workspace's member names and
  roles (Q215, audited as `organisation.closure_candidates_viewed`, Q223).
  That is a second deliberate exception beside feedback screenshots, and §
  Superuser dashboard does not name it yet (DECISIONS-QUEUE Q231).

## Phase 9 Task 3 (integrations in the privacy lifecycle) -- owed

- **A sync run stuck `running` is on no retention clock.** The `integration_sync_run` class (90 days) keys on `finished_at`, and the schema ties `status = 'running'` to `finished_at is null`. So a run a crashed connector never closed lives until its connection or workspace goes. This is harmless while no provider is live. Before the first connector (Q232), add a reaper in the `stuck_job` shape (mark it `failed` with a closed `error_code` after N hours) or a clock on `started_at`.
- **`supabase/tests/network_leakage_phase6.sql` is not re-runnable on one database.** This breaks the "every psql suite passes twice on one DB" rule (Phase 8 lesson 11). A second run on the same database records 218 assertions with 8 state-dependent reds: LA4, LA5b, LB4, LB4b, LC0c, LW7d, LZ1 and LZ1b. They read fixture state that the runner's later HTTP sections change (GAMMA's connection requests, `network_links`, published profiles, `document_versions`). This predates Phase 9. Phase 9's only change to the suite is IN9, a stateless catalogue query that passes on both runs. Fix it by making the suite build and tear down its own GAMMA fixtures, or by pinning the counts relative to a snapshot taken at the start of the suite.

## Phase 9 Task 5 (docs, mutations, gates) -- owed

- **The `service_role` integration RPCs ignore the workspace lifecycle and the tier.** `store_integration_token`, `read_integration_token` and `record_integration_sync_run` check neither a suspended or closed workspace nor a downgrade to Free, because no caller exists. The first connector must enforce both (or decide, with the founder, that a sync may continue on a Free workspace, and say so). `SECURITY.md` section 2.
- **An Admin can create a person-scoped connection for another member** (`connect_integration` with `p_owner_user_id`). Harmless while no provider is live. Per Q236 (default (c): a separate self-connect path for any active member that forces `owner_user_id = auth.uid()`, workspace-scoped connects staying with `manage_integrations`; option (b), restricting the one RPC to the caller, would leave only Owners and Admins able to hold a person-scoped connection; founder to confirm) the RPC is tightened when the first connector ships; binding the OAuth callback's token to the consenting person stays as an additional connector-time check, not the decided remedy.
- **The Phase 9 spec (`docs/superpowers/specs/2026-10-09-integrations-schema-design.md`) overstates two things** (final review m1). It is a founder-approved process document and is left as written; `SECURITY.md` is the record of truth. (1) "`read_integration_token` is the one decrypting path": `service_role` can read Vault directly by Supabase default (`SECURITY.md` section 15). (2) "A suspended or owner-closed workspace refuses connects and token writes": connects are refused, but token writes are not (the `service_role` RPCs ignore lifecycle and tier, first bullet above).
- **Closed (final review m5):** IX5's `>= 3` is now an exact comparison against a count of A's sync runs read as postgres (deterministic, so no reason to leave it loose).
- **Server-side integration audit rows carry the tombstone actor and appear in the tenant audit viewer.** Documented in `SECURITY.md` section 7. A distinct "system" actor would be a schema change to `audit_events`; not done here.
- **Closed:** `tests/unit/legal/storage-census.test.ts` "no scanned file imports code from a place the scan skips" now has its own 30 s timeout (F-T8-1). It is a CPU-bound walk; a retry was never the answer.

## Q228 (closure backups in parts, branch `q228-closure-backup-parts`) -- owed

- **The legal text "The archive is a zip" is now inexact for a multi-part closure backup.** The Data Processing Addendum's deletion-and-return paragraph (`supabase/migrations/20260927008000_legal_pages_describe_export.sql:67`) says a workspace export is "a zip holding one machine-readable JSON file for each kind of record". An ordinary export still is; a closure backup over the per-archive ceilings is now several zips, each with its own manifest, which together are the whole backup, and a large table is split into slices across them. It is counsel's text to change (through `/super/legal`, never a migration that edits published wording); engineering changes nothing.
- **Two residual bounds on "any size" (plan Spec correction 8).** The per-part ceilings are the only ceilings except: (1) one row whose JSON alone exceeds an empty part (with the 64 KiB manifest reserve, a row of roughly 40 MiB), and (2) an index manifest that exceeds an empty part (more than about 40 MiB of part list, i.e. an enormous number of parts, since every part's slices are listed). Either fails the job with a named reason ("a row of public.<table> is larger than one part of the backup can hold" / "the index of this backup is larger than one part of the backup can hold") rather than looping on empty parts. Refusal-tested: `tests/integration/export/closure-parts.test.ts` C9 and the `placeIndex` unit tests in `tests/unit/export/parts-contract.test.ts`. Neither is reachable at realistic sizes; a fix would be splitting a single row's JSON (a format change) or a multi-file index.
- **A failed closure backup still cannot be re-queued** (Q228 (c), unchanged). Q228 as changed by the founder kept this: the answers to a failed backup are the Owner's Contact us link and the superuser's audited "Delete without a backup". A size ceiling no longer fails a closure backup, so the failures left are a stuck claim (the reaper), an unreadable document, a residual bound above, or an infrastructure error.
- **The closure copy promises `/account/exports`, which lists no closure backup (Q239).** `app/(app)/[orgSlug]/settings/export/page.tsx` tells the Owner a deleted workspace's backup "stays downloadable from your account's exports", but `/account/exports` lists only `kind = 'account'` jobs. Default (Q239): keep the copy and list a requester's closure backups (with their parts) on `/account/exports` in a later branch. Until then the backup is reachable from the workspace's own settings page while the Owner's membership resolves (Task 4 checked by code reading that it does for a `deleted` workspace; not yet walked in a browser).
- **The Contact us gate's `!org.isImpersonated` half is untested.** `closure-backup-parts.spec.ts` proves the Owner sees Contact us and a Manager does not; no test impersonates. An impersonating superuser resolves as the Owner under RLS, so that half is the one the page gate actually adds. Add an impersonated-session case (the Phase 7 impersonation fixtures) when the spec is next touched.
- **`lib/supabase/admin.ts` has no importer census** (`lib/supabase/service.ts` has one, `tests/unit/email/service-client-census.test.ts`, which is what kills mutant T7). A T7 variant that read the part row through the admin client would be caught by neither census nor e2e unless the job lookup moved too (then the audit RPC's own ownership check refuses it with a 500, measured as T7-wide in Task 4). Give `admin.ts` the same "and nothing else" census.
- **One unexplained 404 on a legitimate part-2 download.** In Task 4 the first run after a cold Docker restart (cbp9) got 404 instead of 302 for the Owner's part 2; four instrumented runs and every later run passed. If it recurs, instrument `issueExportDownloadUrl`'s 404 branches (job read, `archiveIsDownloadable`, part read, `exists()`) as Task 4 did; do not retry it in config.
- **`exports.spec.ts` and `workspace-closure.spec.ts` leave two `exports` objects per run with no job row** (pre-existing, not Q228's): their teardown deletes job rows, not archives. The 1-day orphan sweep takes them; the e2e teardown should delete the objects too.
- **Most psql suites are not re-runnable on one database, measured (pre-existing, none touched by this branch).** The rule is "every psql suite passes twice in a row on one database"; `run-rls-tests.sh` itself refuses a second run (its preflight), so Q228 Task 5 replayed every `run_suite` call after a clean full run on the same database (`schema_invariants`, `rls_foundation` and `rls_phase2_crm` skipped: they build the shared fixtures by design). 15 of the 25 were clean on the second run, including every suite this branch touched or depends on most (`rls_q228_closure_backup_parts` 114/0, `rls_phase8_workspace_closure` 181/0, `rls_phase8_closure_backup` 26/0, `rls_phase8_retention` 329/0). The 10 that were not, none changed by this branch:
  - `rls_phase3_events`, `rls_phase4_operations`, `rls_phase5_finance`, `rls_phase6_network`: abort on a duplicate primary key (fixed fixture uuids), recording 0 assertions;
  - `network_leakage_phase6`: the 8 reds already recorded under Phase 9 Task 3 above;
  - `rls_phase7_lifecycle` LA1, `rls_phase7_overrides` OB5/OH1/OI4/OI11, `rls_phase8_erasure` EE49/ER5/EZ5, `rls_phase8_permissions` DV0c/DV11/DV14: global audit-row or `document_versions` counts that state written by later suites or the HTTP block disturbs;
  - `rls_phase8_exports` XD7/XD8/XZ4: it counts, and at the end deletes, every `export_job.requested`/`export_job.downloaded` audit row in the database, and `rls_phase8_workspace_closure` (run after it) leaves 10 and 1 of them per run (measured: 10/1/586 -> 20/2/642 around one closure-suite run; the Q228 suite moves the audit log by 0 rows). This branch's only exports-suite changes are the stateless XG7, XG15 and XG15b.

  Fix suite by suite: random fixture ids, counts taken relative to a snapshot at the start of the suite, and deletes scoped to the suite's own rows rather than global.
- **The permission matrix's "no download was audited by any of that" is order-dependent** (pre-existing since Task 1 of this branch, not a regression): it is red only when run straight after the psql runner, because `rls_phase8_exports.sql` XD1's own download audit row is never removed. On a freshly reset database it passes. Fix by having XD1 remove its row, or the matrix count relative to a snapshot.
