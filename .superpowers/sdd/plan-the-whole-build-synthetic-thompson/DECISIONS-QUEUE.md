# DECISIONS-QUEUE — Phase 8 (Legal/Privacy)

Standing instruction (2026-08-30): proceed on the recommended default, queue
the question, never block. Founder answers when back. Numbering continues
from Phase 7 (whose queue, Q89–Q127, lives in the admin-phase worktree).

**Blanket caveat for this phase:** every piece of legal COPY this phase
writes is an engineering draft from PRD §12, not legal advice, and every
retention PERIOD is a working default. Both need sign-off from qualified UK
legal/privacy counsel before launch (CLAUDE.md § Legal and regulatory
compliance). The engineering makes that review cheap; it does not replace it.

- **Q128 — how are the legal pages "CMS-editable"?** No CMS exists.
  **Recommended default (proceeding):** a versioned `legal_documents`
  store in Postgres — one row per (slug, version), immutable once
  published, with the current published version per slug served
  publicly — edited by the platform superuser from `/super`, step-up
  gated and audited. That gives counsel a no-deploy edit path, gives
  every consent a real `policy_version` to point at, and keeps the
  history PRD §18 asks for. Each version carries a counsel-review marker;
  until it is set the public page says plainly that it is a draft pending
  legal review. The alternative (a hosted headless CMS) adds a
  sub-processor and a second system of record for no MVP gain.
  **SHIPPED AS RECOMMENDED (Task 1, 2026-09-16)** — `public.legal_documents`
  (`20260922000000`, seed `20260922001000`, `set_updated_at` `20260922002000`):
  one row per (slug, version), draft → published → superseded; a published or
  superseded version immutable for EVERY role (BEFORE trigger, `postgres`
  included); anon/authenticated read the current published version only,
  through a row policy plus an eight-column grant; four guarded, audited
  superuser RPCs plus a guarded operator read; `/super/legal` edits it with
  step-up on publish and on recording a review; all fifteen pages seeded as
  UNREVIEWED drafts, so every public page shows the draft notice.

- **Q129 — does a cookie banner ship?** **Recommended default
  (proceeding):** no. Every piece of browser storage the app sets today is
  strictly necessary (Supabase auth cookies, `gsp_current_org`, the
  idle-timeout localStorage key, `gsp:sidebar-pinned`), which PECR exempts,
  and no analytics vendor is chosen. Ship the Cookie Policy page listing
  exactly those four, plus a census test that fails the moment a new
  cookie or storage key appears that is not on the declared list — so
  adding analytics forces the banner decision rather than slipping past it.

- **Q130 — how is a user account erased when seven foreign keys block the
  delete?** **Recommended default (proceeding):** a single platform-owned
  **tombstone** identity ("erased user"). Erasure rewrites every
  no-`ON DELETE` reference (`audit_events.actor_user_id`,
  `merges.merged_by`, `merge_candidates.resolved_by`,
  `impersonation_sessions.{superuser_user_id, admin_accepted_by,
  declined_by}`, the two overrides tables' `granted_by`/`revoked_by`,
  `incident_alerts.resolved_by`) to the tombstone, then deletes the
  `auth.users` row so the remaining cascades and set-nulls run. Audit rows
  are therefore **pseudonymised, not deleted** — they keep what happened
  and lose who did it. **Counsel to confirm** that this satisfies erasure
  given the audit retention basis (legitimate interest / legal
  obligation), and whether the audit row itself should also be deleted
  where no retention basis applies.

- **Q131 — may a user erase an account that is the last Owner of a
  workspace?** **Recommended default (proceeding):** no — refused, with a
  sentence saying to transfer ownership or close the workspace first.
  Silently leaving an ownerless workspace strands every other member's
  data with no one able to manage it.

- **Q132 — whose DSR is it?** GetSetPaid is the **controller** of account
  data (the login, profile, memberships, feedback, audit trail) but a
  **processor** for CRM records a customer organisation holds *about* a
  person (a contact, an artist). **Recommended default (proceeding):**
  the DSR flow fulfils account-level requests; for requests about CRM
  records it says plainly that the customer organisation is the
  controller, and the operator can route it to that organisation's
  Owner. The Data Subject Rights page states the split. **Counsel to
  confirm** the controller/processor characterisation and the DPA
  wording that supports it.

- **Q133 — retention periods for the GC job.** **Recommended default
  (proceeding):** the working defaults already in CLAUDE.md — financial
  records 7 years; inactive-account data and feedback 2 years; audit log
  30 days hot then archived to 1 year total, then purged; a suspended or
  closed workspace 60 days (Q88); documents follow their parent record's
  class. All live in ONE declared place in the database so counsel's
  answer is a single migration. **Counsel sign-off required before
  launch.**

- **Q134 — must CRM write auditing for the Phase 3–6 tables (Q122) land
  before launch?** **Recommended default (proceeding):** yes, in this
  phase (Task 7). Without it a raw `PATCH /rest/v1/events` leaves no
  trace, which is a gap a pentest will find and an incident review would
  need.

- **Q135 — "archived" audit rows.** The retention rule says hot for 30
  days, archived up to 1 year, then purged, but no cold store exists.
  **Recommended default (proceeding):** at MVP "archived" means the rows
  stay in Postgres but drop out of the viewer's default range, and the
  purge deletes at 1 year. A real cold-storage export is a post-launch
  infrastructure task. Stated honestly in SECURITY.md § 7 rather than
  implied.

- **Q136 — is the reviewing counsel's NAME public?** Each version records who
  reviewed it (`counsel_reviewer`, free text typed by the operator).
  **Shipped default:** no — it is outside the anon/authenticated column grant
  (Q103: a column on a publicly readable row IS public unless the grant
  excludes it), never copied into an audit row, and the public page says only
  "Reviewed by legal counsel". **Founder/counsel to confirm** whether the firm
  should be named publicly (some firms require it not to be).

- **Q137 — may the founder's own inbox be printed on public pages?**
  `SUPPORT_CONTACT_EMAIL` is the single support/security contact (SECURITY.md
  § 13, Q119(1): the founder's inbox), and the Contact and Vulnerability
  Disclosure pages render it (as the brief requires, from configuration,
  never committed). **Shipped default:** render it when set. **Recommended
  before launch:** point the variable at a role address on the product domain
  (support@ / privacy@) so a personal address is not published and harvested;
  the pages change with the environment value and no redeploy of text.

- **Q138 — can a recorded counsel review be withdrawn?** **Shipped default:**
  no — once recorded it is frozen with the version (the guard refuses a change
  or a withdrawal). A review recorded in error is corrected by publishing a new
  version, which starts unreviewed and brings the notice back. A draft's review
  is cleared automatically when its text changes. **Founder to confirm** that
  "publish a new version" is an acceptable correction path.

- **Q139 — the bracketed gaps on the public drafts.** The seed deliberately
  shows "[Counsel to confirm: …]" text on the public pages rather than
  inventing wording: the company's legal name, registered number and address
  (Privacy, Terms, Contact); warranty/liability and governing law (Terms);
  audit rights, the subprocessor-change notice period and the Article 28
  wording (DPA); the safe-harbour commitment (Vulnerability Disclosure); the
  backup retention period (Data Retention); the accessibility enforcement
  wording for a B2B service; the controller/processor characterisation (Data
  Subject Rights, Q132). **Founder + counsel action**; each is a draft edit at
  /super/legal, no deploy.

- **Q140 — what does "effective date" mean for a version?** **Shipped
  default:** an operator-set date shown under the title; the seed uses the day
  the migration runs; a new draft defaults to today (London); nothing forces
  it to be on or after the publish date. **Counsel to confirm** whether a
  future-dated version should publish only on its effective date (a scheduled
  publish would be new machinery, not built).

- **Q141 — a draft cannot be discarded.** There is no delete path for a draft
  (no grant, no RPC); an unwanted draft is edited back or published. At most
  one draft per document exists, so this costs nothing but tidiness.
  **Shipped default:** no discard. Add a guarded `discard_legal_document_draft`
  only if the founder wants one.


- **Q142 — the application host is not in the subprocessor register.** (Task 1
  fix round 1, review M1.) The Next.js servers see every request (session
  cookies, IP addresses, page content), and FOLLOW-UPS.md implies Vercel, but
  no deployment target is recorded here and nothing in the register names one.
  **Shipped default:** no vendor added (a vendor joins the register in the
  change that first sends it personal data); Privacy v2, DPA v2 and Security v2
  carry a "[Counsel to confirm]" gap naming the unlisted host and the
  US-incorporated Supabase, Inc. with no signed DPA. **Founder to confirm** the
  host (and region), then add it to `docs/sub-processors.md` and
  `lib/legal/sub-processors.ts` in one change and publish new versions of the
  three pages through /super/legal.

- **Q143 — should the Security page's "(deployment setting)" markers be a
  publish-time precondition instead?** (Task 1 fix round 1, review I2.)
  **Shipped default:** the page marks every control that depends on hosted
  configuration and says it does not itself prove they are on; SECURITY.md
  § 15 stays a manual pre-launch checklist. Alternative: once § 15 is verified
  on production, publish a version without the markers (and add the checklist
  as a step before publishing the Security page).

- **Q144 — may `{{support_email}}` appear mid-sentence?** (Task 1 fix round 1,
  review M3.) The fix brief said "a placeholder valid only as a standalone
  block"; every seeded page uses the contact placeholder inline, so the
  shipped rule is: the two TABLE placeholders stand alone on their line, and
  `{{support_email}}` may be inline but never inside bold or a link (the only
  shapes that rendered the raw token). The bold rule is conservative (a
  placeholder between two `**` pairs on one line is refused even when it would
  render). **Shipped default:** as described; confirm or ask for the stricter
  reading.

- **Q145 — when does "hosted in a UK/EU region" lose its "(deployment
  setting)" marker?** (Task 1 fix round 2, re-review M1.) The Privacy Notice
  (v3), DPA (v3), Security page (v2) and the Subprocessors table now all mark
  the region the same way, because the region is chosen when the hosted
  project is created and nothing in this repository checks it (`SECURITY.md`
  § 15, "Project region"). **Shipped default:** keep the marker on every page
  until the founder has verified the production project's region; then
  publish new versions of the four pages (and edit
  `lib/legal/sub-processors.ts` with `docs/sub-processors.md`) stating it
  plainly. Alternative: counsel may prefer the region stated as a commitment
  ("we host ... in a UK/EU region") rather than as a checked fact, in which
  case the marker can go with a wording change instead.

- **Q146 — may the Brevo row keep "no additional transfer safeguards are
  needed"?** (Task 1 fix round 2, found while making the transfer wording
  consistent.) The Supabase row now leaves its transfer position to counsel,
  but the Brevo row still states a legal conclusion: France is covered by the
  UK's adequacy regulations, so no IDTA/SCCs are needed for the transfer
  itself. That rests on a real adequacy regulation rather than on an
  unverified fact, so it was left as written. **Shipped default:** keep it;
  counsel to confirm the wording at review, alongside the unsigned Brevo DPA.

- **Q147 — does a new version of the Marketing page require re-consent?**
  (Task 2.) A consent row records the version it was given against, and a
  grant can only be recorded against the version currently published.
  **Shipped default:** an existing grant stays valid when a later version is
  published (`public.consent_is_granted()` reads only the newest event;
  asserted in `rls_phase8_consents.sql` CC9 and the integration test). Forcing
  re-consent on every edit would silently switch everyone off for a typo fix.
  Alternative: a per-version "material change" flag that invalidates earlier
  grants -- a new column on the immutable `legal_documents` store and a rule in
  the check; worth it only once marketing email actually exists.

- **Q148 — what happens to a user's consent history on erasure?** (Task 2,
  for Task 5.) **CORRECTED in Task 2 fix round 1 (review M8):** the entry
  used to say "deleting the auth account deletes the ledger". That cannot
  happen today for anyone who has consented: every consent event writes an
  `audit_events` row, and `audit_events.actor_user_id` references
  `auth.users` with no ON DELETE action, so the account delete is refused
  (23503) before the cascade is reached (psql CD3a; CD4 reaches the cascade
  only by deleting the audit rows by hand first). What IS true: `consents.user_id`
  is ON DELETE CASCADE, and the guard lets that cascade through -- and, since
  `20260923002000`, only that cascade (it checks the account is really gone).
  **So this is Task 5's decision, not a shipped behaviour:** Task 5 decides how
  an account is removed at all (Q130's tombstone for the audit rows), and in
  the same change whether the consent rows go with the account (the cascade)
  or are kept, re-pointed at the tombstone, as evidence of past lawful basis.
  Counsel to decide whether consent evidence must outlive the account.
  **Working default for Task 5:** cascade (delete), unless counsel says keep.

- **Q149 — no IP address or user agent in consent records.** (Task 2.)
  **Shipped default:** neither is stored; `technical_context` holds only the
  identifier of the wording shown (CHECK-bounded). The session already
  identifies the subject and the server clock says when. If counsel wants
  either, it needs a stated retention period and a migration.

- **Q150 — how long are consent records kept after an account closes?**
  (Task 2.) Marketing preferences v2 carries this as a "[Counsel to confirm]"
  gap. **Working default:** kept while the account exists (then Q148).

- **Q151 — `/account` is a top-level route beside workspace slugs.** (Task 2.)
  Like `/invites`, `/onboarding`, `/super` and `/legal` before it, nothing
  stops a workspace from choosing the slug `account`, whose pages would then
  be shadowed by the static route. Pre-existing class, one more member.
  **Recommended default:** a reserved-slug list enforced in
  `create_organisation` (and a check that no live workspace holds one) in a
  later hardening task. Not done here.
  **DONE in Task 2 fix round 1 (review M7)**, because the review showed
  `legal` was not theoretical: a workspace called `legal` could be created and
  never opened. `20260923005000` reserves the ten static top-level segments
  (account, api, auth, invites, legal, login, magic-link, onboarding, signup,
  super) with a trigger on every insert and every slug change;
  `tests/unit/org/reserved-slugs.test.ts` derives the segments from `app/` so
  a new top-level route must be reserved in the same change. Existing rows:
  Q154.

- **Q152 — the consent grant budget.** (Task 2.) `consent_grant`: 10 grants
  per hour per user, enforced at the insert; **withdrawals are never
  metered** (withdrawal must never be harder than granting; the alternation
  rule bounds the ledger at 2x grants anyway). A proposed number, like Q112.
  **Shipped default:** as described; confirm or change the number.

- **Q153 — the browser census runs against `next dev`, not a production
  build.** (Task 2.) Its first run found `__next_debug_channel`, an IndexedDB
  database Next's development client opens; it is excused by name, guarded by
  a check that no production runtime mentions it. The converse is the real
  limit: storage that only a PRODUCTION build (or the hosting provider) sets
  is never observed by this suite, because `pnpm build` is forbidden in this
  worktree. **Recommended default:** when CI gains a running stack, run
  `storage-census.spec.ts` against `next start` too, and before launch run it
  once against the deployed site (a host-injected analytics toggle is exactly
  what it would catch).

- **Q154 — a production workspace that already holds a reserved slug.**
  (Task 2 fix round 1, review M7.) `20260923005000` refuses a reserved slug on
  INSERT and on any UPDATE that changes the slug, but leaves existing rows
  alone (an update that keeps the slug is never refused), and reports how many
  exist as a NOTICE in the migration log. None exist locally; production
  cannot be seen from here. Such a workspace is already broken in the way the
  review measured (for `legal`, its pages are unreachable; for the others, at
  least its home page is). **Since fix round 2 (`20260923006000`, review N2)
  the same rule covers a slug outside the grammar** (`..`, `''`, `_next`,
  upper case, whitespace, non-ASCII): refused on every insert and slug change,
  left alone on a row that already holds one, counted in a second NOTICE.
  **Recommended default:** before launch, run
  `select id, slug from public.organisations where
  private.workspace_slug_key(slug) in (select slug from
  private.reserved_workspace_slugs()) or slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or
  length(slug) not between 2 and 63` on the hosted project -- the key is the
  one the trigger and the migration NOTICEs use (NFKC, trimmed, lower-cased;
  review N7: the first version of this query compared the raw slug
  case-sensitively while the NOTICE lower-cased it); for each row,
  contact the Owner and rename it (an Owner can move it off the reserved slug
  today; the operator can as `postgres`), then record the rename. Do NOT
  rename silently -- the slug is the workspace's address and people have it
  bookmarked.

- **Q155 — should the CSP keep `'strict-dynamic'`?** (Task 2 fix round 1,
  review M6.) `script-src 'self' 'nonce-…' 'strict-dynamic'` names no
  third-party host, but under `'strict-dynamic'` any script the page already
  trusts may insert a script from any host (and a first-party cookie such a
  script writes is governed by no directive). The test and the docs no longer
  claim "scripts only from this origin". The alternative is a host allowlist
  without `'strict-dynamic'`, which needs every Next chunk to carry the nonce
  or be allowed by `'self'` -- Next's bootstrap loads chunks programmatically
  and emits no per-chunk nonce, which is why `'strict-dynamic'` was chosen
  (`lib/security/headers.ts`). **Shipped default:** keep `'strict-dynamic'`
  (removing it risks breaking every page for a defence the source census
  already provides against our own code); revisit when an analytics vendor is
  chosen, since that change edits the CSP anyway (SECURITY.md § 8), and
  measure then whether `'self'` without `'strict-dynamic'` serves every chunk
  of a production build.

- **Q156 — the one header write whose name is a variable.** (Task 2 fix round
  2, review N1.) The storage census now flags any header written under a name
  that is not a constant, because such a name can be `Set-Cookie`. The real
  tree has exactly one: `lib/supabase/middleware.ts`'s loop copying the
  Cache-Control/Expires/Pragma headers Supabase hands back alongside a
  Set-Cookie (`for (const [key, value] of Object.entries(headers))
  response.headers.set(key, value)`). It is DECLARED as a cookie-write site
  there, which is honest — that loop really can write any header the library
  returns, and the library is what writes the session cookies anyway. The
  alternative is to make the loop name its own allowlist (Cache-Control,
  Expires, Pragma) and refuse anything else, which would turn the declaration
  from "this loop is trusted" into "this loop can only write these three".
  **Recommended default:** leave it declared and keep the census flagging it;
  the cookies Supabase writes here are the ones the inventory already covers,
  and an allowlist in the middleware would silently drop a header the library
  starts sending. Revisit if @supabase/ssr ever returns a header we do not
  expect — the census will not say, because the site is declared.

- **Q157 — the two numbers Task 3 proposes, and one it does not.** (Task 3.)
  Three separate asks, all shipped on a recommended default and all cheap to
  change:
  1. **The submission budget: 10 requests per 24 hours per user.** Enforced at
     the insert (`private.data_subject_requests_before_insert()`), withdrawals
     metered nowhere. Six rights x two scopes = twelve conceivable distinct
     honest requests, and nobody makes twelve in a day; ten covers filing
     several rights, mistyping one and re-filing it, and changing one's mind.
     The refusal names the seconds until the window lifts, and
     `/legal/data-subject-rights` gives the email address as the route that is
     **never** metered — so the limit can never be the reason a statutory
     request goes unmade. A proposed number, like Q112. **Confirm or change.**
  2. **The early warning fires 7 days before the deadline.** A full working
     week: long enough to do the work, long enough to go back to the requester
     and get an answer, long enough that a long weekend does not eat the
     margin. Shorter arrives too late to act on; much longer fires while the
     request is still ordinary work and trains the reader to ignore it.
     **Confirm or change.**
  3. **Nothing emails the requester when their request moves** — Q45 for the
     sixth feature. `/account/data-requests` is the whole notification: a
     person who asks for a copy of their data and hears nothing for 29 days
     experiences silence, and the 30-day answer arrives as an email only
     because the operator writes one by hand. This is the one place where "no
     notification subsystem at MVP" has a legal edge to it rather than a
     product one, because the ICO's expectation is that the controller
     responds, not that the subject checks a page. **Recommended:** send a
     confirmation on submission and one on the closing transition, through the
     existing Brevo sender, when a later task touches it. Not built here.

- **Q158 — should erasure keep the request register, anonymised?** (Task 3,
  for Task 5 — the sibling of Q148 for consents.) `data_subject_requests.user_id`
  is `ON DELETE CASCADE` and the delete guard permits only that cascade, so
  today an erased account's own requests would go with it. But the request and
  its outcome are the evidence that a statutory deadline was met, and erasing
  the request that asked for the erasure is the one deletion most likely to be
  asked about later. **Working default for Task 5:** cascade (delete), matching
  Q148, unless counsel says keep — in which case the rows are re-pointed at
  Q130's tombstone and the `user_email` snapshot is cleared, which is a
  migration and a decision, not a default.

  **CHANGED 2026-09-19, and already implemented (Task 3 fix round 1).** The
  working default is now **keep the register row, anonymised**, and the
  schema was changed to match: `data_subject_requests.user_id` has NO
  `ON DELETE` action (`20260925000000` § 2) and nothing may delete a register
  row at all (`20260925001000`). The reason is not sentiment about evidence —
  it is that the cascade made the erasure half of the fulfilment constraint
  unsatisfiable (review finding I5b). Under cascade, an erasure job that has
  "actually run" has deleted the `auth.users` row, which took the request with
  it, so there is no row left to mark `fulfilled`; marking it fulfilled BEFORE
  the job runs makes the seam a statement about the future. Task 5 re-points
  the row at Q130's tombstone, clears `user_email`, `detail` and
  `rejection_reason`, and only then deletes the account —
  `20260925001000`'s header lists exactly what it must re-issue to be able to.
  **Counsel still confirms**; this is a working default, not an answer.

- **Q159 — should a DSR deadline alert be able to go quiet while the request
  is still open?** (Task 3 review, I3/M1.) **Answered on the recommended
  default and implemented** (`20260925002000`), because an open request going
  silently unalerted is a statutory failure and the cost of being wrong the
  other way is one email a week. As shipped: uniqueness among UNRESOLVED
  alerts only; a still-open overdue request is re-raised 7 days
  (`private.dsr_alert_reraise_days()`) after its last alert was resolved, so
  Resolve is a week's snooze rather than a dismissal; closing a request
  auto-resolves its open alerts, attributed to the SYSTEM through a new
  `incident_alerts.auto_resolved_reason` column rather than to the person who
  closed it. Touches Q117 ("triage, not volume") and does not contradict it:
  at most one alert per open overdue request per week. **Confirm or change the
  7 days.**

- **Q160 — what does "routed" have to mean before the requester is told we
  passed their request on?** (Task 3 review, I7.) **Answered on the
  recommended default and implemented**, database half in `20260925000000` and
  UI half in this round: (a) the operator's form says in words that nothing is
  sent and that they must email the workspace's Owner themselves, shows the
  resolved workspace NAME for confirmation before anything is written, and
  requires a handover note — enforced for every writer by a deferred
  constraint trigger, not only by the form; (b) the requester is told WHICH
  business and that "we have asked", never that it was delivered; (c)
  re-routing is allowed and audited (`data_subject_request.rerouted`), so a
  mistyped slug is correctable. **Recorded for the day this changes:** the
  moment routing notifies a workspace in-product, it becomes a disclosure of a
  named person's privacy request to a third party chosen by a typed slug, and
  it goes behind step-up with the name-confirmation step kept.

- **Q161 — should a request that arrives by email get a register row?** (Task
  3 fix round 1, M5.) Every write path into `public.data_subject_requests`
  stamps the requester from the session and takes no user argument — which is
  what makes a request unforgeable, and also means the operator cannot file
  one for somebody else. So a request from a person with no account (the route
  `/legal/data-subject-rights` invites, and the one that is never rate
  limited) exists only in the support mailbox: no computed `due_by`, no
  `dsr_deadline_approaching`, no `dsr_overdue`, nothing on
  `/super/data-requests`. The obligation is identical for both routes; the
  machinery that watches the clock covers one. **Recommended default:** leave
  it as it is for Task 3 and decide in Task 6 or later between (i) a register
  row whose subject is a VERIFIED email address with no account — a new
  nullable `user_id` plus a `subject_email`, which weakens "a row is always
  somebody's session" and needs its own attribution story; or (ii) an intake
  that creates an account for the person, which is the strongest verification
  and the worst experience for someone exercising a right to be forgotten.
  **Do not close it by letting an operator name a requester.**

- **Q162 — should resolving an incident alert be allowed to name its own
  resolution time?** (Task 3 fix round 2, re-review finding R1.
  **IMPLEMENTED AS THE RECOMMENDED DEFAULT — say if it should be otherwise.**)
  Q159's 7-day re-raise decides on `incident_alerts.resolved_at`;
  `authenticated` held a column-level UPDATE on that column and nothing pinned
  its value, and `lib/admin/health-actions.ts` filled it from `new Date()` in
  the operator's browser. So the clock the re-raise measures was the resolving
  machine's, and a resolution dated into the future was a permanent snooze —
  measured, the original finding I3's end state verbatim (`open / 75 days
  overdue / 0 unresolved alerts`). **Shipped answer: no.**
  `private.incident_alert_resolution_guard()` now overwrites a client
  resolution's `resolved_at` with `now()` (`20260926000000`), the way every
  other stamp in this task is the database's; the action stops sending the
  column; § DD20a–DD20e assert it, with a denominator proving the column
  itself still takes a year-2999 value from a session the guard exempts, and
  the mutation that removes the pin turns two of them red. It changes nothing
  an honest operator experiences. The alternative — refusing a future date
  instead of correcting it — was rejected because it turns a clock-skewed
  laptop into a failed resolve.

- **Q163 — should the routing confirmation be a server-minted token?** (Task 3
  fix round 2, re-review finding R3. **IMPLEMENTED AS THE RECOMMENDED
  DEFAULT.**) Q160a asked for a confirmation step before a request is routed
  to a workspace. It shipped as `confirmedSlug === organisationSlug` compared
  within ONE POST, so a single crafted submission routed with the workspace
  name never rendered to anybody — an interlock against the form and not
  against a submission — and it bound the TYPED SLUG rather than the resolved
  organisation id, so a slug reassigned between the two presses would route to
  a workspace whose name was never shown (which is the property the unit
  test's own comment claimed). **Shipped answer: yes.** The first press mints
  an HMAC token over `(requestId, organisation.id, name)` and the second is
  accepted only if the token verifies AND still resolves to the same
  organisation id, so the two presses are genuinely two requests and the
  binding is to the workspace, not to the string. The caller must already be
  the platform superuser either way, so this is a safety interlock rather than
  an authorisation boundary.

- **Q164 — the two numbers Task 4 proposes.** (Task 4.) Both shipped on a
  recommended default and both cheap to change:
  1. **A new `account_export` budget: 5 exports per hour per user.** The
     `exports` category already existed at 5/hour per ORGANISATION and is the
     workspace export's budget; an account export belongs to no workspace, so
     metering it against one would be the caller-supplied attribution Phase 7
     Task 5's finding I1 closed. Five is the same number for the same reason —
     an export is cheap to ask for and expensive to build, one live job per
     person already bounds the work, and nobody honestly needs a sixth copy of
     their own account data within an hour. Enforced at the insert, so a
     scripted PostgREST `POST` is bound identically. A proposed number, like
     Q112. **Confirm or change.**
  2. **An archive is downloadable for 7 days.** Long enough to survive a
     weekend and a forgotten tab; short enough that the densest personal data
     this product ever produces is not sitting in a bucket for a month. It is
     READ-TIME expiry — the download refuses past it with nothing scheduled —
     and the BYTES are removed by Task 6's retention job, which is stated on
     `/legal/data-retention` v3 rather than implied. **Confirm or change.**

- **Q165 — should a workspace export be downloadable by any Owner/Admin, or
  only by the person who asked for it?** (Task 4. **SHIPPED AS: the requester
  alone**, for both kinds.) The reasoning is not privacy between colleagues,
  it is that an archive is a snapshot taken under ONE person's access rights
  at ONE moment: `public.export_read_page()` reads as the requester, so an
  Owner's copy and a record-scoped Admin's copy of the same workspace are
  genuinely different files. Handing the first to the second would hand them
  rows their own session cannot see. A second Admin starts their own job, out
  of the same budget. **The deliberate consequence:** there is no cross-member
  read of `public.export_jobs` at all, so nobody can see that a colleague
  exported the workspace except through the audit log — which is the surface
  designed for it. If a customer ever asks for a shared workspace archive, the
  answer is a differently-authorised export (built with an explicit, stated
  basis), not a relaxed SELECT policy on this one. **Confirm or change.**

- **Q166 — should a job stuck in `running` be reaped, and by what?** (Task 4,
  for Task 6.) The runner marks its own failures, but if the WRITE of that
  failure also fails the row stays `running`, the one-live-job partial unique
  index refuses the subject's next request, and they read "an export is
  already being prepared" for ever. It is loud rather than silent (the page
  says it, the server log says it) and it needs a database blip at exactly the
  wrong moment, so it is not urgent — but it is a permanent lockout of a
  statutory right from a transient fault. **Recommended default for Task 6:**
  one line in the retention sweep — anything `running` with `started_at` more
  than an hour ago becomes `failed` with a recorded reason. Not built here,
  because a reaper that lives anywhere but the one scheduled job would be a
  second scheduler.

---

- **Q167 — should an account export contain the operator's break-glass
  `reason` and the superuser's identity?** (Task 4 review, finding M2.
  **IMPLEMENTED AS THE RECOMMENDED DEFAULT: no.**) `impersonation_sessions`
  shipped `elevated` with no projection, so `select *` handed a person who
  accepted or declined support access the operator's free-text justification
  and `superuser_user_id`. Row scoping was correct throughout, and a CURRENT
  workspace admin can already read the whole row through RLS — so the only
  reach this added was for somebody who has LEFT the workspace, which is the
  exact case the row is elevated for. `20260928001000` projects it to the
  eleven columns describing the requester's own decision, matching the
  treatment `feedback`'s support-access attribution columns already get, and
  makes "elevated implies a projection" a rule of
  `private.export_catalogue_is_sound()` rather than prose in three files.
  **The counter-argument is real and is one line to adopt:** a person may be
  entitled to know WHY their workspace was accessed. If the founder prefers
  that, put `reason` back in the projection and say so in the catalogue's own
  reason, rather than leaving the projection absent by default — which is what
  produced this finding. **Confirm or change.**

- **Q170 — should the census's "in neither derivation" roll live in the
  DATABASE rather than in a test?** (Task 4 fix round 1, from review finding
  I2.) The completeness census derives its denominator from a foreign-key
  walk, and that walk cannot see a tenant-scoped table with no foreign key —
  `rate_limit_counters.subject_id` is a user id or an organisation id chosen
  by `subject_scope`, with no constraint on it. The fix pins the six such
  tables, with a reason each, in `completeness-census.test.ts`
  (`NEITHER_DERIVATION`), because a table with no foreign key cannot be added
  to `private.export_catalogue()` without the both-directions assertions
  reporting it as `extra`. **So the export's completeness statement now has
  two homes: the catalogue for everything the walk can see, and a TypeScript
  literal for the six it cannot** — which is exactly the "one fact, two
  homes" shape M9 was raised about. The alternative is a third disposition in
  the catalogue (`unseen`, with no scope column and no key column) and a
  census that subtracts it. **Recommended default: leave it in the test.** The
  roll is six names that change once a phase at most, the reasons are
  engineering judgements rather than product statements, and a third
  disposition would have to be understood by `export_catalogue_is_sound()`,
  `export_plan()` and the runner, none of which has any use for it.
  **Confirm or change.**

- **Q171 — should step-up be a server-minted token the DATABASE can check?**
  (Task 4 review, finding M6; recorded in `SECURITY.md` § 4.) Step-up is an
  application-layer control everywhere it exists — publishing a legal version,
  recording counsel's review, the three lifecycle RPCs, the four override
  RPCs, requesting and starting impersonation, rejecting a data subject
  request, and starting a workspace export — because "was a credential
  presented in the last five minutes" is a fact about a JWT that no database
  rule can see. Where the write path carries a client grant
  (`public.export_jobs` has one), a scripted PostgREST call skips it; MFA, the
  permission and the honest `requested_aal` stamp all still apply, so the
  residual is "a privileged action that should have asked for a fresh
  credential did not". The real closure is Q163's shape generalised: a
  short-lived, single-use, HMAC'd token minted after a successful step-up and
  verified in the database. **Recommended default: not now, and not per
  feature** — a per-feature fix leaves the other eight gates as they are and
  makes the exception look like the rule. It belongs to launch hardening,
  beside Q107's PostgREST metering gap, which is the same shape of residual.
  **Confirm or change.**

## FOUNDER ANSWERS — 2026-09-21

- **Q142 — the application host: ANSWERED PARTLY.** The founder says it is
  **not Vercel** ("something else — I'll name it") but has **not yet named
  the vendor or region**. So the register still cannot be completed, and
  the "[Counsel to confirm]" gap on Privacy v2 / DPA / Security stays
  exactly as it is — which is the honest state, not a defect. **Still
  owed from the founder: vendor name + region.** When it arrives it is one
  change: `docs/sub-processors.md` + `lib/legal/sub-processors.ts`, then
  republish the three pages through /super/legal. Until then **no vendor
  may be guessed into the register.**

- **Q139 (company identity) — ANSWERED: NOT INCORPORATED YET.** There is no
  registered name, company number or registered office, so the Privacy,
  Terms and Contact placeholders **cannot be filled as written** — the
  pages ask for a company that does not exist. This is now a **counsel
  question, not a typing job**, and it is bigger than the placeholder:
  - Who is the **data controller** if there is no company? A sole trader
    is a controller in their own name, with their own liability, and the
    ICO registration (CLAUDE.md § Legal, "blocks launch if missed") is in
    that name too.
  - A sole trader's **registered address is their home address** unless a
    service address is used. Publishing it on a public page is the same
    class of problem as Q137's inbox, and worse to undo.
  - The **DPA** is signed by a legal person. Customers will ask who.
  - **Recommended default (proceeding):** leave the bracketed gaps exactly
    as they are. They are visibly unresolved on pages that already carry a
    non-dismissable draft notice, which is truthful. Do NOT substitute a
    trading name, because that would read as a legal identity and is the
    one thing the placeholders exist to avoid asserting.
  - **Before launch the founder must decide with counsel:** incorporate
    first, or launch as a sole trader with a service address and the ICO
    registration in their own name. Nothing in the product can answer this.

- **Q137 — the founder's inbox on public pages: ANSWERED, KEEP FOR NOW.**
  Shipped default stands; `SUPPORT_CONTACT_EMAIL` renders whatever is set.
  **Recorded consequence:** on the day the pages go public that address is
  published on the Contact and Vulnerability Disclosure pages and will be
  scraped, and it is the single support AND security contact
  (SECURITY.md § 13). It is one environment variable with no text change
  and no redeploy, so this is reversible at any moment up to launch —
  which is why accepting it now costs nothing. **Re-raise at the launch
  checklist.**

---

## Q168 — census audit, 2026-09-21

- **Q168 — do the seventeen unguarded psql suites get a pinned assertion
  count before the phase closes, or is the vanishing-assertion risk accepted
  until a later phase?** (Raised by the phase-wide census audit,
  `census-audit.md` §C1 / ranked finding #1. Reconnaissance only — nothing
  was changed.) The runner gates each suite on
  `count(*) … where not pass`, which is a count of RECORDED failures: an
  assertion that raises before its `record()` helper is entered never
  inserts a row, so "0 failing" stays true while the assertion never ran.
  It has already shipped once (DW10, `task-3-report.md`). The guard —
  keeping the output and failing on any `psql:.*ERROR:` line — exists in
  `run-rls-tests.sh` for exactly TWO suites (`:878-895`, `:937-946`); the
  other seventeen, including `rls_phase2_crm.sql` (678 assertions) and
  `network_leakage_phase6.sql` (the private/network split), have nothing.
  No suite anywhere has a pinned expected total, which is the only thing
  that catches the second, rollback-based vanishing shape (DF11–DF13).
  **Recommended default: do the cheap half now, defer the expensive half.**
  Lift the existing guard into one `run_suite()` helper and apply it to all
  nineteen (mechanical, no new numbers to maintain, catches the shape that
  has actually shipped); file the pinned per-suite assertion totals as a
  Phase 9 item, because nineteen hand-maintained numbers is a real ongoing
  cost and every one of them has to be measured against a fresh database
  first. **Confirm or change.**

## Q169 — CI minutes for the three heavy jobs, 2026-09-21

The founder decided that `tests/integration`, the psql/HTTP suite and
Playwright should run in CI (they previously ran only on a developer's
machine — `CLAUDE.md` called that "a deliberate decision nobody has made
yet"). That is now built: `.github/workflows/ci.yml` grows three jobs,
each starting a full local Supabase stack on its own runner. Branch
`infra-parallel-stacks`, unproven until it runs on a real PR.

What needs a founder call is the **bill**, because the decision to run them
did not come with a number attached:

- Estimated ~50 runner-minutes per pull request, against about 5 today.
  Those are extrapolations from local timings, not measurements — the first
  real run should replace them.
- On a **public** repository that is free. On a **private** one it is real
  money, and this repository is private.
- The jobs currently run on `pull_request` **and** on pushes to `main`,
  matching the two existing jobs. Narrowing the heavy three to
  `pull_request` only would cut roughly a third, at the cost of a merge
  commit going unverified.

Options, none taken unilaterally:

  (a) leave as built — all five jobs on PRs and on `main`;
  (b) heavy three on `pull_request` only;
  (c) heavy three on a label or on `workflow_dispatch`, so they are opt-in
      per PR — cheapest, and the one that reintroduces the gap this change
      closed;
  (d) heavy three nightly on `main` plus on PRs touching `supabase/**`,
      `tests/**` or `app/**`.

**Recommended: (a) until the first month's actual minutes are known, then
revisit with the real number.** A gate that is opt-in is not a gate, and the
whole point of the decision was that a green tick should mean the five gates.
**Confirm or change.**

---

## Q172 — the forgotten-`revoke` guard runs on a developer machine only, 2026-09-21

Task 8a closed `census-audit.md` finding 2: a function created in `public`
without the house
`revoke all on function ... from public, anon, authenticated, service_role`
has `proacl IS NULL`, which is Postgres's default of EXECUTE **to PUBLIC** —
and PUBLIC includes `anon`, so PostgREST will call it for an unauthenticated
browser. No ACL-based census can see such a function at all: `aclexplode(NULL)`
returns no rows, so it is matched against nothing and named by nothing. The new
assertion (`no function in public has NO ACL AT ALL`) is now the only thing in
the repository between a forgotten `revoke` and an unauthenticated RPC.

**It lives in `tests/integration/security/phase7-permission-matrix.test.ts`, and
CI does not run `tests/integration`** (CLAUDE.md § CI). So the one guard on the
commonest way that failure ships runs only when a developer runs the local
stack. The schema is clean today (0 with a PUBLIC grant, 0 with a null ACL) —
by convention, now finally asserted, but only where nothing automatic looks.

Options:

  (a) leave it — the assertion exists and the five gates catch it before a
      merge, as they catch every other integration-layer guarantee;
  (b) mirror the two catalogue queries into a **unit**-layer check over the
      migration text: fail when a migration creates a `public` function and
      does not carry a `revoke` for it. Cheap, runs in CI today, and is a
      text check rather than a catalogue one, so it can be fooled;
  (c) adopt Q169's heavy CI jobs, which would run the integration layer and
      make (b) unnecessary.

**Recommended: (c) if Q169 lands, otherwise (b) as well as (a).** The text
check is weaker than the catalogue one and that is fine — it is the one that
runs on every pull request, and the catalogue one still runs before a merge.
**Confirm or change.**

---

- **Q173 — should the CONSENT ledger survive an account erasure, as the data
  subject register now does?** (Task 5, the sibling of Q148/Q158.)
  **Shipped default: NO — consents go with the account, by the ON DELETE
  CASCADE that has always been on `consents.user_id`.** Task 5's brief said to
  give the ledger Q158's keep-anonymised treatment "unless you can show why it
  differs", and it does differ, measurably: `public.consents` is an
  ALTERNATING CHAIN per (user, purpose) — `private.consents_before_insert()`
  refuses a grant on a granted chain and a withdrawal on a withdrawn one, and
  `consents_withdraws_id_key` makes each withdrawal name exactly one grant.
  Re-pointing two erased people's ledgers at ONE shared tombstone interleaves
  two chains into one and produces a history the table's own rules say cannot
  exist (two consecutive grants; two withdrawals of one state). The register
  has no such invariant, which is why it can be kept and this cannot.
  The evidence that is lost: that a person we can no longer contact once
  agreed to marketing email. The evidence that is kept: the audit row for the
  consent event itself, pseudonymised onto the tombstone, which records THAT a
  consent was recorded and when. **Counsel to decide** whether that is enough,
  and if not, whether the answer is a per-person tombstone for this table
  alone (which would be a per-person identifier surviving erasure, and is why
  it was not taken) or a separate append-only consent-evidence store with its
  own retention.

- **Q174 — should an erasure that is still `running` be discoverable by the
  person it is erasing?** (Task 5.) `/account/erase` shows the job while the
  session lasts, and the session stops working the moment the account is
  deleted, so in practice a person sees "Waiting to start" and then nothing.
  A FAILED erasure is the case that matters: they can still sign in, and the
  page does tell them why — but only if they go back and look, because Q45
  means nothing is sent. **Shipped default: the page is the whole
  notification**, consistent with every other feature. **Recommended for the
  day email exists:** a failure notice, and NOT a success notice — the address
  a success would be sent to is one of the things that was deleted.

- **Q175 — how long should a FAILED erasure job be kept?** (Task 5, for Task
  6.) `public.erasure_jobs` has no retention rule. A succeeded account job is
  already pseudonymous (both user columns are null), so it can be kept
  indefinitely as the evidence a deletion happened — and arguably must be. A
  FAILED one still names the person and the reason. **Recommended default for
  Task 6:** keep succeeded rows for ever (they are the proof), and purge a
  failed row 90 days after its account is next successfully erased or after
  the account is deleted by any other route.

- **Q176 — should a workspace be allowed to have no Owner at all?** (Task 5
  review, C2/I1; the reviewer's question, answered here rather than left.)
  **IMPLEMENTED AS THE REVIEWER'S RECOMMENDED DEFAULT, fix round 1:** no. The
  question behind Q131 is now "would this leave the workspace with no active
  Owner", asked in two places — `private.account_last_owner_workspaces()` for
  an erasure, under an advisory lock plus FOR UPDATE on the membership rows
  the guard reads (`private.account_lock_workspaces()`), with a post-delete
  re-assertion; and a new BEFORE UPDATE OR DELETE trigger on
  `public.organisation_memberships`, `private.membership_keeps_an_owner()`,
  for demotion, revocation, removal and the org hop. The one exemption is an
  EMPTY workspace with nobody else in it, which has nothing to strand. **What
  the founder may still want to change:** the guard now blocks a NON-owner
  member's self-erasure too, when they are the last active member of an
  ownerless workspace that still holds records — correct under "do not strand
  a workspace", but it is a person being told they cannot delete their account
  because of somebody else's workspace, and the way out (transfer ownership,
  or close the workspace) needs an Owner they no longer have. The escape
  hatch today is the operator: `/super/organisations` can close the workspace,
  after which the erasure is admitted.

- **Q177 — what an erasure does to the audit PAYLOADS of rows the person was
  the ACTOR on.** (Task 5 review, M1.) `/legal/data-subject-rights` v5 says
  "every entry of yours is re-pointed at a single shared 'erased user'
  identity … and any description of the change is dropped". As shipped, the
  payload was dropped only where the person was the TARGET. **Shipped default,
  fix round 1: the code was made true** — `before`/`after` are now nulled on
  the actor rows too. **The cost, stated rather than implied:** a workspace
  loses the changed-column NAMES of the writes that member made (never their
  content — `private.audit_crm_payload()` has only ever projected ids and
  column names), while the action, the target, the timestamp and the
  correlation thread all stay. **The alternative** is to publish a version 6
  of that page softening the sentence to "the description of changes we made
  ABOUT you is dropped", which keeps the workspace's own record intact and is
  a weaker promise to the data subject; a published version is immutable, so
  that promise could not later be withdrawn. Counsel's call, not
  engineering's — this is the conservative default in the meantime.

- **Q178 -- when a workspace has no Owner and one member left, whose problem
  is it?** (Task 5 re-review, N2.) **THE READABLE HALF IS IMPLEMENTED AS THE
  RE-REVIEWER'S RECOMMENDED DEFAULT, fix round 2:** the guard stands, and the
  refusal branches. A subject who is not an active Owner of the blocking
  workspace now reads that it has no owner, that they cannot make somebody
  else one and that no member can close a workspace, and that support must
  close it -- with its own hint, `workspace_has_no_owner`, so the recorded
  `failure_reason` and the `/account/erase` page say the same thing. **The
  founder half is still open:** should step 8b widen from
  `other_members = 0 and is_empty` to `other_members = 0` for a workspace
  with no active Owner at all, so the last member of an ownerless workspace
  takes it with them? **Recommended default: NO.** That branch DELETES a
  workspace's records rather than stranding them, on the say-so of somebody
  who is not its Owner, and the operator's escape hatch already reaches the
  same outcome with a person deciding. Revisit if the state ever occurs in
  practice -- with the fix-round-1 trigger in place it is reachable only
  through an out-of-band `auth.users` delete (Q179), a `replica`-mode or
  `TRUNCATE` write, or data predating `20261001001000`.

- **Q179 -- should the membership guard's account-cascade exemption require
  the chokepoint's own marker?** (Task 5 re-review, N3.)
  `private.membership_keeps_an_owner()` admits any DELETE whose `auth.users`
  row has already gone. Because `organisation_memberships.user_id` is
  `ON DELETE CASCADE`, only an account deletion can satisfy that branch, so
  it cannot be falsely borrowed -- but it does not tell
  `private.erase_account()`'s deletion (which has asked Q131 under a lock)
  from a direct `delete from auth.users`, which leaves a live workspace with
  `owners 0 / members 1 / crm 1`. No application path reaches it: there is no
  `auth.admin.deleteUser` call site anywhere in `lib/` or `app/`. The real
  exposure is an operator clicking Delete on Supabase Studio's Auth page.
  The fix is a transaction-local GUC that `erase_account()` sets and the
  trigger requires, in the shape of `private.begin_lifecycle_transition()`,
  which turns that click into a REFUSED cascade rather than a stranded
  workspace. **Recommended default: take it, but not in a fix round.** It
  makes every fixture, suite and seed that deletes an `auth.users` row fail
  unless it sets the marker, which is a change with reach across the whole
  test estate and wants its own task -- Task 6, beside the reaper and the
  retention sweep. Until then the risk is documented in `SECURITY.md` section
  8, in the trigger's own comment and in `FOLLOW-UPS.md`, with the recovery
  named (`private.account_last_owner_workspaces()` plus
  `/super/organisations`).

- **Q180 -- should a workspace's OWN soft-deleted CRM rows expire on their
  own?** (Task 6.) `CLAUDE.md` § Non-negotiable rules says "soft-delete
  operational records rather than hard deletion, **subject to the retention
  policy**", and the honest reading is that a contact a workspace deleted in
  2026 should eventually stop existing. **Task 6 deliberately did not build
  that sweep**, and says so in `private.retention_subjects()` rather than
  implying it is covered: every CRM table is classified
  `retained_with_workspace`, meaning the only thing that removes those rows
  is the 60-day workspace purge. **Recommended default: NO, not without a
  signature.** A scheduled job that silently began hard-deleting customers'
  own soft-deleted records two years on is a different kind of decision from
  everything else in this task -- it destroys a CUSTOMER'S data rather than
  the platform's operational residue, it is unrecoverable, and "we deleted
  your contact because you deleted it two years ago" is a support
  conversation the founder should choose to have. If it is taken, the class
  is already declared (`operational`, 2 years) and `financial_entries` would
  take the `financial` one (7 years) rather than the same two, which is the
  first thing a naive version would get wrong.

- **Q181 -- how long should a `public.retention_runs` row be kept?** (Task 6.)
  The run log is classified `never_purged` and grows by one row per run --
  about 8,800 a year at the current hourly cadence, each a few hundred bytes
  of counts. **Recommended default: keep them, and revisit if the number ever
  matters.** A garbage collector that garbage-collects its own record of what
  it deleted is the one thing on the roll that must not exist, and the
  cheapest way to be sure of that is not to give it a clock at all. If one is
  ever wanted, the obvious shape is "keep every run that REFUSED or FAILED
  for ever, and a completed one for a year" -- the refusals are the evidence
  and the quiet successes are the volume.

- **Q182 -- should a retention run that refuses raise an incident alert?**
  (Task 6.) Today a refusal is a column on `public.retention_runs`, rendered
  on `/super/health`, and nothing else -- so "the audit purge has refused its
  sanity ceiling on every run for a month" is visible only to somebody who
  looks. The alerting machinery to change that already exists (the incident
  digest rides the same tick, and `dsr_alert_writer_failed` is the precedent
  for a job alerting on its own failure). **Recommended default: yes, but not
  for every refusal.** The kill switch being off is a state somebody chose
  and would be noise; the audit purge's floor or ceiling refusing, or a sweep
  raising an unexpected SQLSTATE, is a real fault and is exactly what the
  `dsr_alert_writer_failed` shape was built for. It was not taken here
  because it is a new alert type with its own dedup question (once per run,
  at that cadence, is 24 alerts a day for one broken sweep) and that is a
  design decision rather than a line of code.

- **Q182 -- TAKEN AT ITS RECOMMENDED DEFAULT in Task 6 fix round 1 (review
  finding m5).** A LIVE retention run that refuses or fails files ONE
  `retention_run_refused` incident alert per distinct (sweep, reason)
  (`20261004004000`), emailed by the existing digest and resolved by the
  system when a later run completes without repeating it. The dedup question
  that held it back already had an answer in this schema -- a partial unique
  index over the unresolved alerts of one type, the `dsr_alert_writer_failed`
  shape. Not filed for `retention_disabled`, `retention_run_in_progress` or a
  preview. **Still the founder's to reverse**: if an hourly job's faults are
  wanted somewhere other than the incident digest, this is one trigger.

- **Q183 -- should `/legal/data-retention` say plainly that a workspace's own
  soft-deleted CRM records, and "inactive account data", are NOT automatically
  deleted today?** (Task 6 review, I3.) **TAKEN AT THE RECOMMENDED DEFAULT,
  YES, as version 6 (`20261004006000`), unreviewed.** Version 5 removed
  "Automated deletion is still being built" and left "Inactive account data:
  2 years" and "when a period ends, the data is permanently deleted or
  anonymised" standing as live promises; a sentence-by-sentence check found a
  third, "Financial records: 7 years", which read as a deletion date and is
  not one. The page now has a section headed "What is not deleted
  automatically". It is the product's promise, Q180's recommended default is
  NOT to build that sweep, and a page that overclaims deletion is a worse
  failure than one that admits a gap. **What the founder/counsel still has to
  answer is on the page as three counsel gaps**: whether financial records
  must be DELETED at seven years (and from what date), whether inactive
  accounts are deleted at all (Q180), and whether a customer-facing permanent
  delete of a single record is required before launch -- there is none today.

- **Q184 -- should the audit purge's sanity ceiling have a no-deploy release?**
  (Task 6 fix round 1, review finding m5.) The ceiling refuses when more than
  a fifth of the audit log AND more than 1,000 rows are past the period. It
  judges EVERY candidate while each run deletes at most 500, so it **cannot
  drain itself**: a genuine backlog -- the job switched off for months, or
  first enabled on a database already older than a year -- refuses every hour
  for ever. That is the rail doing its job (the same shape also means "the
  clock is wrong"), and since this round it is never silent: the
  `retention_run_refused` alert carries both row counts. But the only release
  today is a reviewed migration reissuing `private.audit_purge_ceiling()`,
  restored afterwards. **Recommended default: YES, build it, small** -- a
  step-up-gated control on `/super/health` that records a reason and lifts
  rail 3 ONLY, for 24 hours, audited like the kill switch; the hard floor and
  the 500-row per-run ceiling stay, so the worst a wrong release can do is
  delete 12,000 rows that were already past a year. Not built here because it
  is a new superuser RPC with its own matrix, e2e and a11y obligations, and
  the review asked for the alert "at minimum". The reviewer's alternative --
  judge the ceiling on `least(candidates, p_limit)` -- was rejected: with a
  500-row cap and a 1,000-row floor it can never fire, which deletes the rail.

- **Q185 -- what should the deleted-documents list say about a document whose
  file the retention job has purged?** (Task 6 fix round 1, C1.) The database
  now refuses to restore one for every writer
  (`documents_purged_implies_deleted`), and `restoreDocumentAction` matches
  nothing, so the person reads the ordinary "nothing to restore" answer. But
  `/[orgSlug]/documents/deleted` still OFFERS Restore on that row and nothing
  in the application reads `bytes_purged_at` at all. **Recommended default:
  show "File deleted under the retention policy on <date>" in place of the
  Restore control.** It cannot occur before a document has been deleted for
  two years, so it is not urgent -- but it is the honest end of Q52, and the
  column exists precisely so the product can say it.

- **Q186 -- when a document's retention class is `financial` at the moment it
  is deleted, should it stay `financial` for the whole seven years regardless
  of what later happens to the event's financial entries -- and,
  symmetrically, should an `operational` document that later gains a
  financial parent be promoted?** (Task 6 scoped re-review, finding I-N1.)
  **TAKEN AT THE RECOMMENDED DEFAULT in fix round 2: FROZEN AT DELETION, IN
  BOTH DIRECTIONS** (`20261005000000`). The period is a promise about a file
  made when its clock started; a tenant should be able neither to shorten it
  by editing an unrelated record (the re-review's reproduction: one finance
  edit took a seven-year document to the two-year period at sweep time) nor
  to be surprised by a later edit lengthening it. The honest route to a
  different period is to restore the document and delete it again, which
  re-freezes what is true then -- both audited writes of the person's own.
  Counsel may prefer "financial once, financial always" even for a LIVE
  document; that is a later, wider question and does not block the freeze.

- **Q187 -- should `/legal/data-retention` say in words that a deleted
  document's period is judged at the moment it was deleted?** (Task 6 fix
  round 2, from Q186.) v6 says "7 years if the document is attached to an
  event that carries financial entries" -- present tense. After the freeze
  that sentence is true in the direction that matters (a tenant cannot
  shorten a period) and imprecise in the other: a document deleted from a
  no-money event whose event later gains money stays at two years, where a
  reader of v6 might expect seven. **Recommended default: fold "judged when
  the document was deleted" into the NEXT published version of the page
  rather than publishing a v7 for one clause** -- a version is not published
  to change nothing, and the legal suite's fixture counts, the unit test and
  the RL binding all move for every publish. If counsel's Q133 answer or
  Q183's three gaps produce a v7 first, this clause rides with it.

- **Q188 -- is a `network_link.*` audit row consistent with Q82?** (Phase 8
  Task 7, Q122.) Q82 made a private-record-to-network-profile link "strictly
  private to the linking organisation -- the profile's publisher is never
  told who linked it", and `rls_phase6_network.sql` § NX4 read that as "no
  audit row, on purpose". Task 7 put the generic audit pair on
  `network_links` (it is a client write like any other, and an unaudited one
  is what Q122 exists to close), which REVERSED that assertion. The row is
  filed under the LINKING organisation, carries identifiers only
  (`network_profile_id`, `private_entity_type`, `private_entity_id`,
  `created_by`, `deleted_at`), and is readable by the platform superuser
  alone -- no member of any tenant, the publisher included, can read
  `audit_events`. So the publisher still learns nothing; what changes is that
  the OPERATOR can see that organisation X linked profile P, which the
  operator could already see by reading `network_links` as `postgres`.
  **Recommended default: keep the audit (shipped).** NX4 now asserts the Q82
  property itself -- every such row is filed under the link's own
  organisation, never the publisher's.

- **Q189 -- should an Owner's own edit of `organisations` (name, slug) be
  audited, and in which shape?** (Phase 8 Task 7, from the derived coverage
  census.) `private.audit_coverage()` found `organisations` client-writable
  on UPDATE (`organisations_update_manage_organisation`) with no audit writer
  -- the one table in the derived denominator still `unaudited`, excused by
  name in `AUDIT_COVERAGE_EXCUSALS`. The lifecycle transitions ARE audited
  (`organisation.suspended / .deleted / .reinstated`, through the
  marker-guarded policy) and `create_organisation()` writes
  `organisation.created`, so attaching the generic pair as-is would write a
  SECOND `organisation.created` per workspace and a `.soft_deleted` /
  `.restored` beside every lifecycle summary row, changing the shape of every
  lifecycle thread the Phase 7 suites pin. **Recommended default: YES, audit
  it, as a dedicated `organisation.updated` trigger on UPDATE only that skips
  a write made inside `private.lifecycle_transition_in_progress()` and never
  fires on INSERT** -- name and slug are workspace identity the operator
  already sees on `/super/organisations`, so their VALUES may be carried
  (unlike tenant record content), and `lifecycle_reason` is never carried.
  Not done in Task 7 because it changes pinned Phase 7 thread shapes and is a
  decision about the audit log's vocabulary rather than an extension of it.

- **Q190 -- the audit purge's per-run ceiling vs the audited write rate.**
  (Phase 8 Task 7, requirement 5.) Task 6's audit purge deletes at most 500
  rows per hourly run -- a ceiling of ~12,000 rows/day. `SECURITY.md` § 7's
  own projection (100 workspaces x 200 audited writes/day = 20,000 rows/day)
  already exceeds that for the Phase 2 tables alone, and Task 7 adds a row per
  Phase 3-6 write (the golden path's event -> lineup -> task -> link ->
  complete -> note stretch went from 0 rows to 6). A steady rate above the
  ceiling is a permanent backlog, which the 1/5 sanity rail then refuses
  (Q184) -- loudly, never silently. **Recommended default: no change now;
  measure the real daily audited write rate on `/super/health` once there
  are customers, and raise `p_limit` (or the cadence) in one migration when
  the 30-day average exceeds half the ceiling (6,000 rows/day).** Not changed
  in Task 7 because the ceiling is one of the purge's five safety rails and a
  change to it is Task 6's review surface, not an audit extension's.

- **Q191 -- `merge_candidate.restored` is in the catalogue and no client can
  write it.** (Phase 8 Task 7 fix round 1, M3.) `merge_candidates` is
  `softDeletable`, so the generic verb set gives it `.restored`; but its one
  UPDATE policy's `WITH CHECK` requires `resolved_by = auth.uid()` and
  `merge_candidates_resolution_complete` requires `deleted_at`, `resolution`
  and `resolved_by` to be null or set together -- so un-dismissing a pair is
  refused (42501, psql PQ4). The verb is written only by a session-attributed
  write that bypasses the policy (PQ5, the shape a future "undo dismiss" RPC
  would have). **Recommended default: keep the catalogue entry** -- the
  generic writer emits it for any such write, removing it would make that
  write's action unknown to the viewer's filter, and the day an undo RPC ships
  it is already audited. No product change; recorded so the catalogue is not
  read as a claim that a client can restore a candidate.

- **Q192 -- the cost of the erasure's audit-payload scan as the log grows.**
  (Phase 8 Task 7 fix round 1, C1.) Steps 6f and 10b of `erase_account()`
  are each a sequential scan of `audit_events` with a text match on
  `before`/`after` -- no index can serve a substring over jsonb text.
  Measured locally: **~0.45 s per scan at 500k rows**, so ~0.9 s per erasure;
  at `SECURITY.md` § 7's projection (20,000 rows/day, one-year retention,
  ~7.3M rows) roughly 6-7 s per scan, inside the erasure's transaction and
  under its per-workspace locks. **Recommended default: no change at MVP**
  (an erasure is rare and runs from the out-of-transaction runner, not a
  request); revisit when the table passes ~2M rows, and the fix then is a
  write-time `audit_events.person_ids uuid[]` column with a GIN index,
  populated by `private.log_audit_event()`, which turns both steps into an
  index lookup -- a schema change to the audit writer, so not taken silently
  here.

## FOUNDER ANSWERS — 2026-09-30

The founder answered every open question from Q89 to Q187. These are rulings, not defaults; cite "founder 2026-09-30".

**Rulings that change or add work.** These are Phase 8 Tasks 9a/9b/9c; see `task-9*-brief.md`.
- **Q142:** the app host is an **IONOS VPS** (IONOS SE). The region is most likely the UK and the server is not bought yet, so mark the region PENDING.
- **Q145:** the production Supabase region is **Ireland (eu-west-1)**.
- **Q157(3)/Q174/Q45:** build **all** notification emails: DSR received/closed, erasure failure, export ready, connection requests and task reminders. They go through the one Brevo sender.
- **Q176/Q178 CHANGED, and this reverses Q104:** an **Owner may close their own workspace**.
  - Closing takes an automatic full backup, emails the superuser and raises a superuser-dashboard item. From that item the founder either reassigns the workspace to a new Owner or deletes it permanently.
  - Members keep read-only access while it is closed.
  - The 60-day purge still applies.
- **Q167 CHANGED:** the account export **includes** the operator's break-glass reason and the superuser's identity.
- **Q184:** build the audit-purge ceiling release. It is step-up gated and lasts **3 days**.
- **Q185:** show "File deleted under the retention policy on <date>" in place of Restore.
- **Q113:** uploads are limited to **10/hour per user**. The **25 MiB** cap stays, enforced at the write.
- **Q111:** incident alerts go by **email, a dashboard notification and a Telegram bot**. Telegram replaces SMS.
  - The bot is `@getsetpaid_bot`. The env vars are `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID`.
  - A message carries the alert type, counts and a `/super/health` link only. It contains no personal data.
- **Q169:** heavy CI jobs run on PRs and on main for a month (option a).
- **Q172:** covered by those heavy jobs (option c).
- **Merge `infra-parallel-stacks` at the start of Phase 9.**

**Kept as shipped or as recommended:** Q180, Q161, Q165, the numbers for Q164/Q157/Q159/Q152, Q171 (Phase 10), Q141, Q138, Q136, Q187, Q147, Q106, Q99 and Q100. For every other open technical question, keep the shipped default.

**Waiting for counsel:** Q130, Q132, Q133, Q139, Q140, Q146, Q148–Q150, Q158, Q173, Q177 and the retention-page gaps.

**Opened after the answers, with defaults:** Q188–Q190 (Task 7), Q191 (`merge_candidate.restored` has no client path; keep the catalogue entry) and Q192 (the erasure payload scan; no change for MVP, and a GIN `person_ids` column at around 2M rows).
