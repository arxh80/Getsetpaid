# Task 1 report: the launch-gate inventory

**Status: DONE_WITH_CONCERNS.** Base `af69ee4`, branch `launch-hardening`. Work
ran 2026-10-16 to 2026-10-17, across one session-limit reset.

## What I did

1. **Wrote the census script.** `scripts/launch-gate-census.mjs` uses the
   brief's code verbatim. I ran it into `census-1.json`. Its counts match the
   controller's smoke test exactly: 87 routes (47 exact, 5 by tail, 35 none),
   32 list candidates, 31 keys (1 untested), and 191 definers (107 unnamed).
   Committed and pushed as `8ecbf31`.
2. **Read every candidate by hand.** That is every route (not only the 35
   "none"), all 32 list reads and all 107 unnamed definers. The definers were
   checked against the live catalogue: trigger-ness, EXECUTE for
   `authenticated`/`anon`/`service_role`/`supabase_auth_admin`, and
   `proconfig`. I read the 15 `.from(<variable>)` sites and the set-returning
   RPCs the census cannot see. The six real rate-limit categories that § 5
   names only in prose were checked separately. The dispositions follow at
   the end of this report.
3. **Read the gate evidence.**
   - Every `SECURITY.md` section the brief names (§ 2, 4, 5, 6, 10, 11, 12,
     13, 15), and `CLAUDE.md` § Current state and § Testing gates.
   - `FOLLOW-UPS.md` § Phase 10 and every other "Gate: Phase 10" entry.
   - The decisions queue for Q169, Q171, Q172 and the 2026-09-30 rulings.
   - PRD § 10.5, 10.8, 14, 16 and 17 (`scripts/read-prd.py`).
   - `ci.yml`, `config.toml` and the e2e axe sites.
4. **Measured a few things cheaply.**
   - The per-category rate-limit test map.
   - `search_path` on all 189 live definers.
   - Trigram indexes.
   - Production licences, with `pnpm licenses list --prod --json`.
   - Every reader of the service-role key.
   - The importers of `lib/supabase/admin.ts`.
   - The 4 PostgREST-grammar interpolation sites.
   - The 8 plpgsql dynamic-`EXECUTE` functions.
   - Zero real `dangerouslySetInnerHTML` uses.
5. **Wrote `docs/launch-gates.md`.**
   - 11 gate rows: the eight in § 11, performance, backup restore in
     production, and § 15 as a FOUNDER ACTION row.
   - "Gaps, graded" with 31 gaps.
   - "Founder actions" F1-F12, each with a lead time.
6. **Ran the self-check.** `grep -c "^| G[0-9]" docs/launch-gates.md` returns
   31, the same as the number of gaps here. Every OPEN or PARTIAL row names at
   least one `G<n>`. I also checked that every table row has a consistent cell
   count.

I did not run any heavy gate: no `db reset`, no psql runner, no integration
tests and no e2e. The numbers I cite as measured on 2026-10-16 are the
ledger's, from `ce1fda1`.

## Gate status

| Gate | Status |
|---|---|
| 1. RLS integration | PARTIAL (green locally, not in CI: G1) |
| 2. API: validation, parameterisation, pagination, rate limiting | PARTIAL |
| 3. Security tests | PARTIAL (CSRF has zero evidence) |
| 4. Accessibility | PARTIAL |
| 5. Dependency, secret and licence scanning | PARTIAL |
| 6. Privileged functions and service-role key | PARTIAL |
| 7. Pre-production backup restore | OPEN |
| 8. Penetration test | FOUNDER ACTION |
| 9. Performance | PARTIAL |
| 10. Production backup restore | FOUNDER ACTION |
| 11. § 15 hosted configuration | FOUNDER ACTION |

No gate is MET outright.

## Gap list summary (31)

| Severity | Count | Gaps |
|---|---|---|
| Critical | 1 | G11: account pre-hijacking into a tenant. Inferred, not reproduced. |
| High | 12 | G1 heavy CI unmerged (Q169); G2 direct-REST directory unmetered (Q107); G3 password-recovery limit unenforced (Q109); G4 login-lockout hook refused on the hosted plan (402); G10 GoTrue per-IP login limit untested (regraded in fix round 1); G12 CSRF untested; G13 step-up is app-layer only (Q171); G14 impersonation direct reads unaudited; G15 real ClamAV unproven; G16 session fixation/revocation untested (regraded in fix round 1); G28 no backup-restore drill; G30 Storage outside database backups |
| Medium | 14 | G5, G6 unbounded side reads (silent truncation at `max_rows` 1000); G7 no unbounded-read census; G17 CSP/headers; G18 raw-HTML sinks; G19 no threat model; G21 42 unscanned routes; G22 screen-reader pass; G23 licences (compliance, not security); G24 SAST/DAST; G25 definer `search_path` census; G26 definer register; G27 admin client and service-key readers; G29 performance evidence |
| Low | 4 | G8 members truncation; G9 grammar-interpolation census; G20 export false 404; G31 § 15 omissions |

The likely Part B clusters, from the plan's expected list, are:

- **Unbounded reads:** G5-G7.
- **Rate limits:** G2-G4 and G10. The rate-limit boundary cluster the plan
  expected is mostly already met: every real category has a test, and most
  test at n and n+1.
- **Axe route census:** G21.
- **Index-backed reads:** G29.
- **Backup-restore drill:** G28.

The evidence adds four clusters the plan did not expect:

- **The server-held request header:** G2 and G14 share one mechanism.
- **Step-up tokens:** G13.
- **Auth configuration and email confirmation:** G3, G4, G10, G11.
- **Merging `infra-parallel-stacks`:** G1.

## The rate-limit categories, checked one by one

| Category (`rate_limit_policies`) | Boundary evidence |
|---|---|
| `search` 60/min | `rls_phase7_rate_limits.sql` § RS (61 calls, refusal + alert); the app wiring in `tests/unit/list/fetch-list-page.test.ts`, `tests/unit/security/rate-limit.test.ts` |
| `network_discovery` 30/min | `tests/integration/security/rate-limit-network-discovery.test.ts`: allows 30, refuses the 31st, window recovery; the direct-REST residual is G2 |
| `network_connection_request` 10/h org | `tests/integration/security/connection-request-budget.test.ts`: 10, then the 11th refused over raw PostgREST |
| `feedback` 10/h | `rls_phase7_feedback.sql` § FM; `tests/integration/security/feedback-budget.test.ts` (11th refused) |
| `uploads` 10/h | `tests/integration/documents/upload-rate-limit.test.ts` (11th refused, no row or object) |
| `exports` 5/h org, `account_export` 5/h | `rls_phase8_exports.sql` § XW, XW14-XW17 |
| `consent_grant` 10/h | `rls_phase8_consents.sql` § CM |
| `data_subject_request` 10/24h | `rls_phase8_data_subject_requests.sql` |
| `account_erasure` 3/24h | `rls_phase8_erasure.sql` |
| `login_account` 5/15min | `rls_phase7_rate_limits.sql` § RH (the hook itself); production availability is G4 |
| `password_recovery` 3/h | the value only; no enforcement point (G3) |

## Files changed

- `scripts/launch-gate-census.mjs`: new, verbatim from the brief. Commit
  `8ecbf31`.
- `.superpowers/sdd/2026-10-16-launch-hardening/census-1.json`: new,
  force-added. Commit `8ecbf31`.
- `docs/launch-gates.md`: new.
- `.superpowers/sdd/2026-10-16-launch-hardening/task-1-report.md`: new, this
  file, force-added.

There are no product-code changes, and I did not touch the ledger
`progress.md`, as instructed.

## Concerns

1. **The shared local database was not at this branch's schema.** It held 248
   applied migrations: main plus PR #33's `20261102000000`. This branch's
   three Q228 migrations (`20261101000000`, `20261101001000`,
   `20261101002000`) were missing, so another session had reset it for #33.
   My catalogue reads therefore describe that schema. I accounted for the
   definers the three Q228 files create by reading their text:
   - `export_job_parts_guard`, a trigger revoked from every role;
   - `closure_backup_owed`, revoked from every role;
   - `audit_export_download(uuid, integer)`, `authenticated`, named in the
     matrix;
   - `retention_object_manifest`, `service_role`;
   - redefinitions of existing ones.

   Every one sets `search_path = ''`. None changes a disposition. A
   re-measure after a reset on this branch would make the figure exact (189
   live definers there versus 191 in the migration census).
2. **G11 (Critical) is inferred, not demonstrated.** It rests on facts read
   from source:
   - `config.toml`'s `enable_confirmations = false`;
   - the invite flow binding to an existing account by email;
   - `accept_invite` never checking email ownership;
   - since fix round 1, `lib/org/actions.ts:258-261`'s own record that an
     invite to an existing *unconfirmed* user answers 200 with the same id.

   That last fact means turning confirmations ON does not close it. The real
   owner's invite click confirms the squatter-created account with the
   squatter's password intact. Task 3 should reproduce both paths before Part
   B fixes them.
3. **G4: production may have no per-account login lockout.** The 402 from PR
   #32's Preview check ("HOOK_PASSWORD_VERIFICATION_ATTEMPT cannot be
   configured for this organization") means § 5's ENFORCED login row is true
   only locally on the current hosted plan. This is a cost decision for the
   founder.
4. **G1: the founder ruling is unimplemented.** The founder ruled on
   2026-09-30 to "merge `infra-parallel-stacks` at the start of Phase 9". It
   never merged, so every tenant-boundary suite still runs only on a
   developer machine. The branch is about four weeks behind and will need
   conflict work.
5. **The census script was kept verbatim, as the brief required, with known
   quirks:**
   - it labels the root route `/page.tsx`;
   - "exact" over-reports when a `/new` literal fills a `[id]` segment, or a
     spec navigates without scanning;
   - the list regex stops at a `;` inside a comment and misses
     `.maybeSingle<T>(`;
   - the key regex reads any backticked identifier in § 5 as a limiter key;
   - the definer regex reads `create function` only, so it misses
     `alter function ... security invoker`.

   G7, G21 and G26 each propose the AST- or catalogue-based test that should
   replace the relevant half.
6. **Commit shape.** The brief's Step 5 is one commit. The controller's
   mid-task message asked for the census script first, so there are two
   commits: `8ecbf31`, then the document and this report.

## Founder questions (for the controller to number from Q244)

1. **G11: email confirmation and invite verification.** *Default: yes to all
   of these:*
   - "Confirm email" ON in production, and `config.toml` moved to
     `enable_confirmations = true`;
   - invite verification forces a new password and revokes every other
     session for that user (this is what closes the confirmations-ON path);
   - the `created: true` branch of `resolveOrInviteAuthUser` refuses to bind
     a pre-existing, never-confirmed account.

   No test uses `signUp`, and the e2e fixtures create confirmed users through
   the Admin API.
2. **G4: the login lockout on the hosted plan.** The hosted organisation
   refuses `HOOK_PASSWORD_VERIFICATION_ATTEMPT` (402). Should the plan be
   upgraded, or should the product launch with an app-side per-account meter,
   leaving a direct-GoTrue residual? *Default: upgrade before launch.* The
   app-side meter in `signInAction` (keyed on a hash of the normalised email)
   is the fallback if the cost is refused.
3. **G3: the password-recovery limit.** *Default: set the hosted and local
   `[auth.email] max_frequency` to `20m`, which is at most 3 recovery mails
   per hour per account, enforced by GoTrue with no hook.* Measure the effect
   on magic link (the lockout escape hatch) first. If magic link suffers,
   restate § 5 to GoTrue's per-IP limits instead.
4. **G14: impersonation direct reads.** *Default: close it with G2's
   server-held request header.* `private.impersonated_organisations()` would
   grant only to requests the app server signs, so every impersonated read
   passes `getCurrentOrg()`'s audit. pgaudit and an RPC-only read surface are
   rejected as heavier.
5. **G5: what "unlimited custom fields" means on Pro.** *Default: no creation
   ceiling. Reads are bounded at 500 definitions per entity type, with a
   visible "more fields than this page shows" notice.*
6. **G24: SAST and DAST, and their cost.** *Default:*
   - Semgrep CE (free) as SAST in the `scan` job;
   - an OWASP ZAP baseline as DAST in G1's e2e job;
   - CodeQL only if the repository goes public or GitHub Advanced Security is
     bought.
7. **G30: a Storage backup.** *Default:*
   - a nightly copy of the three private buckets to UK/EU object storage under
     the IONOS DPA, with 30-day retention and encryption at rest;
   - a bucket sample restored in the production drill (F2).

   Whether to buy Supabase's PITR add-on (RPO below 24h) is a separate cost
   decision. *Default: daily backups meet RPO 24h, so no PITR at launch.*
8. **G22: the screen-reader pass.** Who runs it, and by when? *Default: the
   founder, with NVDA on Windows, before general availability, using the
   `task-8-report.md` § 3 script as extended.*

The founder actions F1-F12 in `docs/launch-gates.md` are for Task C1 to queue,
as the plan says. They are not listed here as questions.

## Every candidate's disposition

### Routes (87): every one, read by hand

| Route | Census | Disposition |
|---|---|---|
| `/account/data-requests` | none | covered: data-requests.spec.ts (reached by the footer link) |
| `/account/erase` | exact | covered: accessibility.spec.ts SIGNED_IN_PAGES |
| `/account/exports` | exact | covered: exports.spec.ts |
| `/account/privacy` | none | covered: consent.spec.ts (reached by the footer link; the census cannot see a click) |
| `/invites` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: feedback.spec.ts names "/invites" as a planted route string, with no scan |
| `/onboarding` | by tail | **confirmed gap (G21)**: census 'by tail' is a false hit: the string appears only in a comment |
| `/super/audit-log` | exact | covered: accessibility.spec.ts + audit-log.spec.ts |
| `/super/billing` | exact | covered: overrides.spec.ts |
| `/super/closures` | exact | covered: super-closures.spec.ts |
| `/super/data-requests` | exact | covered: data-requests.spec.ts |
| `/super/feedback` | exact | covered: feedback.spec.ts |
| `/super/health` | exact | covered: platform-health.spec.ts (2) |
| `/super/impersonation` | exact | covered: impersonation.spec.ts |
| `/super/legal` | exact | covered: legal.spec.ts (list + draft open) |
| `/super/organisations` | exact | covered: organisation-lifecycle.spec.ts |
| `/super` | exact | covered: super-closures.spec.ts (landing scan) |
| `/super/[...unknown]` | exact | false positive, not a UI route: calls notFound(), which renders app/(app)/not-found.tsx, the in-app 404 that accessibility.spec.ts scans |
| `/[orgSlug]/agencies/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/agencies/new` | none | **confirmed gap (G21)** |
| `/[orgSlug]/agencies` | none | **confirmed gap (G21)** |
| `/[orgSlug]/agencies/[agencyId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/agencies/[agencyId]` | none | **confirmed gap (G21)** |
| `/[orgSlug]/artists/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/artists/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/artists` | by tail | **confirmed gap (G21)**: census 'by tail' is a false hit: `/artists/new` contains the tail |
| `/[orgSlug]/artists/[artistId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/artists/[artistId]` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: `/artists/new` fills the [artistId] segment |
| `/[orgSlug]/companies/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/companies/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/companies` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/companies/[companyId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/companies/[companyId]` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: `/companies/new` fills the segment |
| `/[orgSlug]/contacts/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/contacts/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/contacts` | exact | covered: SIGNED_IN_PAGES + pinned-rail scan + workspace-closure.spec.ts |
| `/[orgSlug]/contacts/[contactId]/edit` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: audit-log.spec.ts navigates here but scans /super/audit-log |
| `/[orgSlug]/contacts/[contactId]` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/documents/deleted` | exact | covered: SIGNED_IN_PAGES + documents.spec.ts (purged state) |
| `/[orgSlug]/documents` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/duplicates` | none | **confirmed gap (G21)** |
| `/[orgSlug]/duplicates/resolved` | none | **confirmed gap (G21)** |
| `/[orgSlug]/duplicates/[candidateId]` | none | **confirmed gap (G21)** |
| `/[orgSlug]/events/deleted` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/events/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/events` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/events/[eventId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/events/[eventId]` | exact | covered: SIGNED_IN_PAGES + finance-panel scan |
| `/[orgSlug]/meetings/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/meetings/new` | none | **confirmed gap (G21)** |
| `/[orgSlug]/meetings` | none | **confirmed gap (G21)** |
| `/[orgSlug]/meetings/[meetingId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/meetings/[meetingId]` | none | **confirmed gap (G21)** |
| `/[orgSlug]/members` | none | **confirmed gap (G21)** |
| `/[orgSlug]/merges` | none | **confirmed gap (G21)** |
| `/[orgSlug]/network/links` | none | **confirmed gap (G21)** |
| `/[orgSlug]/network` | exact | covered: accessibility.spec.ts (directory) |
| `/[orgSlug]/network/profiles` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/network/profiles/[profileId]` | by tail | covered: accessibility.spec.ts (editor, reached by a click) |
| `/[orgSlug]/network/requests` | exact | covered: accessibility.spec.ts |
| `/[orgSlug]/network/[profileId]` | exact | covered: accessibility.spec.ts (foreign viewer) |
| `/[orgSlug]/notes/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/notes/new` | none | **confirmed gap (G21)** |
| `/[orgSlug]/notes` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/notes/[noteId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/notes/[noteId]` | by tail | **confirmed gap (G21)**: census 'by tail' is a false hit: the notes list path contains the tail |
| `/[orgSlug]` | exact | covered: keyboard.spec.ts (palette open) + feedback.spec.ts (dialog open); whole document scanned |
| `/[orgSlug]/settings/custom-fields` | exact | covered: accessibility.spec.ts (editable, Owner) |
| `/[orgSlug]/settings/export` | exact | covered: workspace-closure.spec.ts + closure-backup-parts.spec.ts |
| `/[orgSlug]/support-access` | exact | covered: impersonation.spec.ts |
| `/[orgSlug]/tasks/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/tasks/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/tasks` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/tasks/[taskId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/tasks/[taskId]` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/venues/deleted` | none | **confirmed gap (G21)** |
| `/[orgSlug]/venues/new` | exact | covered: SIGNED_IN_PAGES |
| `/[orgSlug]/venues` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: feedback.spec.ts names it as a planted route string |
| `/[orgSlug]/venues/[venueId]/edit` | none | **confirmed gap (G21)** |
| `/[orgSlug]/venues/[venueId]` | exact | **confirmed gap (G21)**: census 'exact' is a false hit: `/venues/new` fills the segment |
| `/login` | exact | covered: accessibility.spec.ts (signed-out login scan) |
| `/magic-link` | none | **confirmed gap (G21)** |
| `/magic-link/sent` | none | **confirmed gap (G21)** |
| `/signup/check-email` | none | **confirmed gap (G21)** |
| `/signup` | none | **confirmed gap (G21)** |
| `/legal` | exact | covered: legal.spec.ts |
| `/legal/[slug]` | exact | covered: legal.spec.ts (4 pages at 320px) |
| `/page.tsx` | by tail | false positive, not a UI route: app/page.tsx is the root `/` (the census mislabels it): a server redirect that renders no UI |

Totals: 43 covered, 2 not UI, 42 confirmed gaps.

### Candidate unbounded list reads (32): every one, read by hand

| # | Read | Table | Disposition |
|---|---|---|---|
| 1 | `lib/admin/audit-log.ts:349` | audit_events | false positive: `.limit(pageSize + 1)` added in a later statement (keyset pager) |
| 2 | `lib/admin/health.ts:542` | incident_alerts | false positive: `.limit(pageSize + 1)` added in a later statement (keyset pager) |
| 3 | `lib/admin/health.ts:620` | organisations | false positive: `.in("id", orgIds)` over one bounded page's organisation ids |
| 4 | `lib/admin/overrides-list.ts:74` | organisations | false positive: `.in()` over ids from a list capped at OVERRIDE_LIST_LIMIT (50) |
| 5 | `lib/auth/index.ts:186` | organisation_memberships | false positive: the caller's own memberships (filtered to the signed-in user); naturally bounded per person and index-backed |
| 6 | `lib/auth/mfa-gate.ts:204` | organisation_memberships | false positive: the caller's own active memberships, with the same bound |
| 7 | `lib/crm/custom-field-queries.ts:109` | custom_field_definitions | **confirmed gap (G5)**: every definition of one entity type, including soft-deleted ones (`includeRemoved`); Pro has no limit |
| 8 | `lib/crm/custom-field-queries.ts:157` | custom_field_definitions | **confirmed gap (G5)**: every live definition in the org, read only to count it |
| 9 | `lib/crm/custom-field-queries.ts:215` | custom_field_values | **confirmed gap (G5)**: one entity's values, bounded by unique (field_id, entity_id) times the unbounded definition count |
| 10 | `lib/crm/custom-field-queries.ts:298` | custom_field_values | **confirmed gap (G5)**: a page of entities' values, the page size times the unbounded definition count |
| 11 | `lib/crm/dedup.ts:542` | custom_field_values | **confirmed gap (G5)**: two entities' values, times the definition count |
| 12 | `lib/crm/dedup.ts:548` | custom_field_definitions | **confirmed gap (G5)**: every live definition of one entity type |
| 13 | `lib/crm/queries.ts:323` | contact_companies | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 14 | `lib/crm/queries.ts:355` | contact_companies | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 15 | `lib/crm/queries.ts:903` | artist_representations | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 16 | `lib/crm/queries.ts:946` | artist_representations | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 17 | `lib/crm/queries.ts:1006` | venue_rooms | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 18 | `lib/crm/queries.ts:1090` | venues | false positive: `.in()` over one page's venue ids (at most MAX_PAGE_SIZE 50, as its header states) |
| 19 | `lib/crm/queries.ts:1571` | event_lineup | false positive: `.limit(LINK_PANEL_LIMIT)` after a comment containing `;` |
| 20 | `lib/crm/queries.ts:1606` | artists | false positive: `.in()` over ids from the removed lineup rows (limit 100) plus one page |
| 21 | `lib/crm/queries.ts:1798` | event_lineup | false positive: `.limit(ARTIST_EVENTS_ID_CAP)` after a comment containing `;` |
| 22 | `lib/crm/queries.ts:2444` | profiles | false positive: `.in()` over one page's uploader ids |
| 23 | `lib/dsr/queue.ts:172` | data_subject_requests | false positive: `.limit(pageSize + 1)` in a later statement (keyset pager) |
| 24 | `lib/feedback/list.ts:221` | feedback | false positive: `.limit(pageSize + 1)` in a later statement (keyset pager) |
| 25 | `lib/feedback/list.ts:270` | organisations | false positive: `.in()` over one page's organisation ids |
| 26 | `lib/legal/published.ts:57` | legal_documents | false positive: `.maybeSingle<Row>()`, which the regex misses because of the type argument |
| 27 | `lib/network/discovery.ts:233` | network_connected_profiles | false positive: `.in()` over one page's profile ids (callers: the requests list and the network links page) |
| 28 | `lib/network/discovery.ts:254` | network_directory | false positive: the same, the second half of the batched lookup |
| 29 | `lib/network/entities.ts:75` | network_profiles | **confirmed gap (G6)**: every live profile of one kind in the org; it feeds `loadLinkOptions`, whose limit grows with it |
| 30 | `lib/network/entities.ts:272` | network_profiles | **confirmed gap (G6)**: every published profile of the org (the Send-from choice) |
| 31 | `app/(app)/[orgSlug]/members/page.tsx:192` | organisation_memberships | false positive: `.limit(200)` after a comment containing `;` (a flat cap; see G8) |
| 32 | `app/(app)/[orgSlug]/members/page.tsx:238` | profiles | false positive: `.in()` over at most 200 member ids |

Outside the census's reach, read by hand as well: the 15 `.from(<variable>)` sites (`lib/crm/finance-queries.ts:197`, `lib/crm/queries.ts:454/1260/2186/2215/2272/2516`, `lib/crm/actions.ts:297`, `lib/crm/dedup.ts:537`, `lib/crm/link-actions.ts:92/151`, `lib/network/entities.ts:310`, `lib/list/query.ts:593/623/644/677`) are all bounded by `.limit`, `.maybeSingle`, an id equality or one page's ids. The set-returning RPCs the app calls each take a `p_limit`, read one job's or one page's rows, or read the caller's own memberships.

### Rate-limit keys (31 backticked identifiers in SECURITY.md § 5)

| Key | Test files | Disposition |
|---|---|---|
| `account_erasure` | 4 | a real `rate_limit_policies` category, tested |
| `account_export` | 3 | a real `rate_limit_policies` category, tested |
| `exports` | 41 | a real `rate_limit_policies` category, tested |
| `repeated_login_failures` | 1 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `pg_cron` | 3 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `service_role` | 51 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `sign_in_sign_ups` | 0 | **confirmed gap (G10)**: GoTrue's per-IP limit, a `config.toml` value that no test pins and § 15 does not list |
| `hint` | 62 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `export_organisation_data` | 6 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `network_directory` | 16 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `documents` | 80 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `feedback` | 54 | a real `rate_limit_policies` category, tested |
| `manage_network_connections` | 8 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `rate_limit_tripped` | 21 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `rate_limit_policies` | 21 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `authenticated` | 69 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `pg_depend` | 5 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `display_name` | 23 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `exists` | 183 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `dsr_deadline_approaching` | 1 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `dsr_overdue` | 2 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `notified_at` | 17 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `select` | 178 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `update` | 122 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `account_notified_at` | 5 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `pg_net` | 4 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `organisation_id` | 119 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `resolved_by` | 9 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |
| `search` | 107 | a real `rate_limit_policies` category, tested |
| `network_discovery` | 7 | a real `rate_limit_policies` category, tested |
| `grant` | 84 | false positive: not a limiter key (a column, role, extension, alert type or SQL word) |

§ 5 names six further real categories in prose rather than backticks: `consent_grant`, `data_subject_request`, `login_account`, `network_connection_request`, `password_recovery` and `uploads`. Each was checked separately (see the per-category table in this report). `password_recovery` has only its value assertion, because it has no enforcement point (G3).

### Definers named by neither the matrix nor a census (107): every one, read by hand against the live catalogue

None of them is a surface a client can reach, so all are false positives on that count. G25 and G26 are the coverage gaps that remain.

**41 trigger functions.** These cannot be called except as triggers: `private.handle_new_user()`, `private.audit_crm_row()`, `private.enforce_custom_field_limit()`, `private.clear_event_room_before_venue_delete()`, `private.record_event_status_change()`, `private.guard_document_scan_status()`, `private.network_request_status_transition_guard()`, `private.fill_connection_request_recipient()`, `private.document_quarantine_alert()`, `private.meter_connection_request()`, `private.audit_incident_alert_resolution()`, `private.feedback_before_insert()`, `private.audit_feedback_submission()`, `private.audit_feedback_status_change()`, `private.feedback_quarantine_alert()`, `private.consents_before_insert()`, `private.consents_guard()`, `private.audit_consent_event()`, `private.organisations_slug_not_reserved()`, `private.data_subject_requests_before_insert()`, `private.data_subject_requests_before_update()`, `private.data_subject_request_notes_guard()`, `private.audit_dsr_submitted()`, `private.audit_dsr_transition()`, `private.audit_dsr_note()`, `private.dsr_routing_needs_handover_note()`, `private.dsr_resolve_alerts_on_close()`, `private.export_jobs_before_update()`, `private.audit_export_job_requested()`, `private.tombstone_is_nobody()`, `private.tombstone_is_not_a_login()`, `private.erasure_jobs_before_insert()`, `private.erasure_jobs_before_update()`, `private.audit_erasure_job_requested()`, `private.membership_keeps_an_owner()`, `private.retention_run_raises_alert()`, `private.notification_stamp_guard()`, `private.notification_delivery_guard()`, `private.integration_connections_guard()`, `private.integration_connections_follow_membership()`, `private.audit_organisation_update()`.

**30 granted to no client role, not even `service_role`.** They are reached only from inside other definers: `private.log_audit_event(p_action text, p_target_type text, p_organisation_id uuid, p_target_id uuid, p_correlation_id uuid, p_before jsonb, p_after jsonb)`, `private.duplicate_probe(p_organisation_id uuid, p_entity_type text, p_entity_id uuid, p_scoped boolean)`, `private.record_rate_limit_event(p_category text, p_subject_scope text, p_subject_id uuid, p_organisation_id uuid)`, `private.is_impersonating()`, `private.impersonated_route_session(p_route text)`, `private.export_read_page_as_requester(p_sql text, p_subject uuid, p_after text, p_limit integer)`, `private.sweep_custom_field_values(p_organisation_id uuid, p_entity_type text, p_entity_id uuid)`, `private.organisation_is_empty(p_organisation_id uuid)`, `private.account_last_owner_workspaces(p_user_id uuid)`, `private.account_erasure_blockers(p_user_id uuid)`, `private.assert_account_is_erasable(p_user_id uuid)`, `private.fkless_identifier_columns()`, `private.unclassified_fkless_identifiers()`, `private.assert_fkless_identifier_roll()`, `private.account_lock_workspaces(p_user_id uuid)`, `private.constraint_function_reachability()`, `private.sweep_rate_limit_counters(p_dry boolean, p_limit integer)`, `private.sweep_feedback(p_dry boolean, p_limit integer)`, `private.sweep_incident_alerts(p_dry boolean, p_limit integer)`, `private.sweep_erasure_jobs(p_dry boolean, p_limit integer)`, `private.reap_stuck_jobs(p_dry boolean, p_limit integer)`, `private.sweep_document_bytes(p_dry boolean, p_limit integer)`, `private.sweep_expired_workspaces(p_dry boolean, p_limit integer)`, `private.retention_refusal()`, `private.retention_sweep_is_due()`, `private.audit_ceiling_release_active()`, `private.closure_decision_recipients(p_organisation_id uuid)`, `private.closure_backup_owed(p_organisation_id uuid)`, `private.revoke_integration_row(p_connection_id uuid, p_actor uuid, p_reason text)`, `private.sweep_integration_records(p_dry boolean, p_limit integer)`.

**34 in `private` with `authenticated` EXECUTE.** PostgREST does not expose them (`[api] schemas = public, graphql_public`, asserted by the matrix). They hold EXECUTE because RLS policies and SECURITY INVOKER public RPCs call them as the caller. That they stay unreachable depends on the hosted exposed-schemas setting (G31), and nothing forces a new one to be reviewed (G26): `private.is_active_member(p_org_id uuid)`, `private.shares_active_organisation(p_user_id uuid)`, `private.membership_update_is_permitted(p_id uuid, p_organisation_id uuid, p_user_id uuid, p_status text, p_joined_at timestamp with time zone)`, `private.permitted_organisations(p_permission text)`, `private.full_scope_organisations()`, `private.entity_is_visible(p_entity_type text, p_entity_id uuid, p_org_id uuid)`, `private.entity_is_manageable(p_entity_type text, p_entity_id uuid, p_org_id uuid)`, `private.entity_org_unchanged(p_entity_type text, p_id uuid, p_org_id uuid)`, `private.crm_write_organisations()`, `private.organisation_is_live(p_org_id uuid)`, `private.custom_field_limit(p_org_id uuid)`, `private.custom_field_slot_available(p_org_id uuid, p_entity_type text)`, `private.entity_is_live(p_entity_type text, p_entity_id uuid, p_org_id uuid)`, `private.custom_field_definition_type_unchanged(p_id uuid, p_entity_type text)`, `private.duplicate_matches(p_organisation_id uuid, p_entity_type text, p_entity_id uuid)`, `private.record_merge(p_organisation_id uuid, p_entity_type text, p_winner_id uuid, p_loser_id uuid, p_winner_owner uuid, p_loser_owner uuid, p_field_resolution jsonb, p_audit_summary jsonb)`, `private.finance_module_organisations()`, `private.network_publish_organisations()`, `private.impersonation_time_box()`, `private.impersonated_organisations(p_permission text)`, `private.impersonation_counterparty_organisations()`, `private.lifecycle_transition_in_progress()`, `private.log_organisation_lifecycle_event(p_organisation_id uuid, p_action text, p_correlation_id uuid, p_before jsonb, p_reason text)`, `private.organisation_network_presence_active(p_org_id uuid)`, `private.organisation_id_for_slug(p_slug text)`, `private.active_billing_override(p_org_id uuid)`, `private.active_feature_override(p_org_id uuid, p_flag_key text)`, `private.effective_organisation_plan(p_org_id uuid)`, `private.log_override_event(p_action text, p_target_type text, p_organisation_id uuid, p_target_id uuid, p_after jsonb)`, `private.is_impersonating_route(p_route text)`, `private.document_retention_class(p_document_id uuid)`, `private.closure_backup_read_admits(p_organisation_id uuid)`, `private.lifecycle_lock(p_organisation_id uuid)`, `private.lifecycle_has_active_owner(p_organisation_id uuid)`.

**2 other:**

- `public.hook_password_verification_attempt(event jsonb)`: executable by `supabase_auth_admin` only (GoTrue's hook); tested by `rls_phase7_rate_limits.sql` § RH
- `private.integration_role_held`: not a definer in the live catalogue; `20261030002000` ran `alter function ... security invoker`, and the census reads create statements only

## Fix round 1 (2026-10-17, from the task review)

### The three Important findings

1. **G10 and G16 regraded to High,** to match G12's rule: a promised or
   gate-named control with no test anywhere is High.
   - **G16:** session fixation sits in the same § 11 gate-3 line as CSRF, and
     `session-limits.test.ts` tests a different control (timeouts).
   - **G10:** § 5 promises the per-IP login row as "ENFORCED, AT A DIFFERENT
     NUMBER" and no test names `sign_in_sign_ups`. If G4 ends with no hook on
     the hosted plan, this is production's only login brute-force bound.
     G10's test now also drives the 31st sign-in to a 429, and carries a
     mutant.

   The tally is now 1 Critical, 12 High, 14 Medium and 4 Low (31). It is
   updated in this report's summary table. `docs/launch-gates.md` carries no
   separate tally.
2. **G11 rewritten as two paths.**
   - **Path 1:** confirmations OFF, the 422 `email_exists` fallback.
   - **Path 2:** confirmations ON. `inviteUserByEmail` on an existing
     unconfirmed user returns 200 with the same id (`lib/org/actions.ts:258-261`),
     so the squatter is bound in the `created: true` branch (`:280-282`). The
     victim's invite click confirms the squatter-created account with the
     squatter's password intact.

   The remediation now has four parts:
   - confirmations ON;
   - a forced new password at invite verification, with every other session
     revoked (this is what closes path 2);
   - a refuse-to-bind check placed in the `created: true` branch;
   - the `accept_invite` NULL check, demoted to "path 1 only, not
     sufficient".

   The proposed test is the reviewer's case: the squatter signs up with P1
   (confirmations ON), the workspace invites the address, the victim follows
   the Inbucket link and sets P2, and a sign-in with P1 must fail. It comes
   with a unit test of the `created: true` branch and a mutant (no forced
   password, so P1 succeeds and the test goes red). Founder question 1's
   default and concern 2 are updated to match.
3. **Gate 4's row now says the census route verdict is not evidence** until
   G21's declared-route census replaces it. It names the three defects: a
   literal fills a dynamic segment, a route merely named in an axe spec counts
   as scanned, and the root becomes `/page.tsx`. It says the 43/42 figures
   come from reading every route by hand. The script stays verbatim.

### The Minor items

- **The rate-limit summary is corrected.** Of the 31 keys, 6 are real
  categories, 1 is the GoTrue per-IP key and 24 are false positives. § 5 names
  6 more categories in prose, and all 12 categories are tested.
- **G26's count is corrected** to 30 with no client grant, plus the hook and
  `integration_role_held`, which reconciles to 107.
- **G5 and G6 now name the real failure mode:** `[api] max_rows = 1000` means
  silent truncation (for G6, the picker re-offers published records).
  `max_rows` is added to G31's § 15 list.
- **G1 now quotes Q169's trial wording:** "for a month (option a)", recommended
  "until the first month's actual minutes are known, then revisit with the
  real number". The remediation now records the first month's minutes.
- **The gate 9 citation is fixed** to `schema_invariants.sql` D3 (`:721`).
- **G23 states its reasoning for Medium:** a licence check is a compliance
  control, not a security one, and the other two gate 5 scans are green.
- **Gates 3 and 4 now carry exact re-measure commands.** Gate 3 gives the
  reset and runner, the vitest integration and unit files, and the Playwright
  specs. Gate 4 gives the grep, the 16 axe specs in two Playwright groups, and
  `contrast.py`. Gate 4 also states that route coverage has no command until
  G21.

The self-check passes after the round: `grep -c "^| G[0-9]"
docs/launch-gates.md` returns 31, every OPEN or PARTIAL row names a `G<n>`,
and every table row has a consistent cell count (4, 5 or 6).
