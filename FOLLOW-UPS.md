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
- **NOTHING IN THE PRODUCT ENFORCES `SECURITY.md` § 5, AND SEARCH IS THE
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
  like. **Needs an owner and a phase before deployment** -- it is cross-cutting
  infrastructure, not Core CRM, which is why Task 8 did not build it.
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
  All three are disabled BY NAME and only on this page in
  `tests/e2e/accessibility.spec.ts` (`NESTED_MAIN`), with a control that fails
  if the page ever stops being red -- so the exclusion cannot outlive the fix.
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
  `GETSETPAID_ALLOW_HOSTED=1` is set (so Vercel, where `.env.local` is absent,
  is unaffected). `tests/integration/rls/support/env.ts` already contains the
  loopback assertion to reuse.

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
  far.** `getCurrentOrg()` (`lib/auth/index.ts:184`) filters
  `.is("deleted_at", null)`, so a suspended slug resolves to `null` and every
  route under it renders the tenant-isolation 404 — indistinguishable from
  another tenant's slug. Meanwhile `getActiveMemberships()` filters on `status`
  only, so the switcher still **lists** the workspace and sends the user
  straight into that 404.

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

- **`private.custom_field_limit()` has the SAME escape, and it dies in the same
  migration.** Task 5 (`20260829010500`) mirrors
  `private.crm_write_organisations()` clause for clause, including reading "no
  subscription row" as **unlimited** rather than as Free. That is not a
  copy-paste convenience: Free's `custom_field_limit` is `0`, so reading a
  missing row as Free would give every organisation in the product zero custom
  fields on every entity type and ship the feature dead. The TypeScript half
  (`customFieldLimit()` in `lib/crm/custom-fields.ts`) carries the same branch,
  and `tests/integration/crm/custom-field-limit-matches-db.test.ts` binds the
  two. When the escape below is removed, remove it in **three** places — that
  function, this one, and the TypeScript mirror — in the same change.
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
  button.** **CORRECTED IN TASK 3a FIX ROUND 1 — the first sentence used to say
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
