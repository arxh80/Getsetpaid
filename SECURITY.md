# SECURITY.md

Internal engineering reference **and** pentest/audit prep document for GetSetPaid. Consolidates security decisions already made across `CLAUDE.md` and the PRD (`getsetpaid_crm_prd.docx` §10, §18) into one place, plus defines rate limits, incident response and vulnerability disclosure that didn't exist anywhere yet.

This is not the public-facing Trust Centre page (PRD §12) — it is written for engineers and external security testers, not customers. Nothing here is a substitute for the pre-launch independent penetration test (PRD §10.8) or legal/privacy counsel review (see `CLAUDE.md` § Legal and regulatory compliance).

## 1. Principles

- No feature is production-ready until threat modelling, access-control tests and OWASP-aligned tests pass — security is an acceptance criterion, not hardening applied after the fact.
- Least privilege everywhere: roles, database roles, service accounts, superuser access.
- Private by default: tenant data never crosses into the network/public surface without an explicit, tested, opt-in policy.

## 2. Tenancy and Row Level Security

- RLS is enabled on every tenant-owned table before the application can reach it. Separate policies per operation (SELECT/INSERT/UPDATE/DELETE) where useful.
- Access is derived from the authenticated session and organisation membership, checked **in the database** — never from a client-supplied organisation ID.
- Network/public tables (`network_profiles`, `network_links`) have their own read policies, entirely separate from tenant-private tables. Private tables are never joined into a public discovery path without an explicit, tested policy.
- Finance and audit tables carry additional, more restrictive policies than general CRM data.
- `SECURITY DEFINER` functions are used only where necessary, with `search_path` locked and `EXECUTE` restricted; every one is reviewed individually.
- Service-role/secret keys bypass RLS entirely and must never reach the browser.

## 3. Input handling

- All queries are parameterised or built with a trusted query builder — no string-concatenated SQL, anywhere.
- Search/filter/sort inputs map to an allowlist of column names and operators; free-form input never becomes a column/operator name.
- Rich text is sanitised against stored and reflected XSS. URLs are validated against an allowlist of protocols (`javascript:` and `data:` rejected). `dangerouslySetInnerHTML` is avoided; where unavoidable, it requires security review.
- A strong Content Security Policy is shipped with the Next.js app.

## 4. Authentication and session security

- Identity: Supabase Auth. Email/password and magic-link/OTP at MVP; **Google SSO ships at MVP**, Microsoft SSO is post-MVP.
- Session limits: **30-minute inactivity timeout, 12-hour absolute session lifetime.**
- MFA is **required** for Platform Superuser, Organisation Owner, Admin and Finance roles. Optional (not enforced) for all other roles at MVP.
- MFA is **enforced at every sign-in, not just at enrollment**. A privileged user with a verified TOTP factor who signs in at `aal1` is challenged for a code before reaching the app — an enrolled-but-never-challenged factor satisfies the requirement in name only. Founder decision, 2026-08-27.
- **MFA recovery (lost authenticator) has no self-service path at MVP.** Because the challenge is enforced, a privileged user who loses their TOTP device cannot sign in at all. There are no backup codes and no admin reset UI. The only recovery today is a manual operator action: delete that user's row from `auth.mfa_factors` in the Supabase dashboard (SQL editor, filtered by `user_id`) after verifying the requester out-of-band, which drops them back to the enrollment gate on next sign-in. **This is a deliberate MVP gap, not an oversight** — self-service recovery (backup codes at enrollment, plus a superuser-initiated, audited reset) belongs to Phase 7 (Admin/Security) alongside the rest of the superuser dashboard. Until then: the manual deletion must be treated as a high-risk admin action — verify identity out-of-band before performing it, since it is a complete bypass of the second factor.
- **MFA is enforced in the database, not only in the UI.** `public.has_permission()` and `private.has_platform_permission()` return false for an MFA-required role on a session that has not reached `aal2` (`supabase/migrations/20260827210000_mfa_aal_permission_gate.sql`), so every write policy in the schema inherits the requirement. The app-layer gate (`lib/auth/mfa-gate.ts`, plus `assertMfaSatisfied()` on the privileged Server Actions) gives a readable refusal and stops side effects outside the database; it is not the enforcement. The anon key ships in the browser bundle by design, so anyone holding a session token can call PostgREST directly and bypass the entire Next.js app — the database is the only chokepoint on that path.

### Known limitation: MFA gates privileged WRITES, and — since Phase 2 — CRM READS

**Narrowed on 2026-08-28 (Phase 2, Task 2). The CRM tables are now `aal2`-gated for reads as well; Foundation's tables are not.** Read the whole section: the half that remains open is still the half a pentester will find.

**What changed.** Every Phase 2 CRM policy — all twelve tables, reads included — is built on `private.permitted_organisations()`, which restates `public.has_permission()`'s body including the `aal2` clause. So an Owner, Admin or Finance user on an `aal1` session now reads **zero** contacts, companies, agencies, artists, venues, rooms, links, representations, fee history, custom field definitions, custom field values and merge records. Measured over real HTTP with a real password-grant token plus the public anon key, i.e. the exact stolen-password request this section is about (`supabase/tests/run-rls-tests.sh`, "Phase 2 CRM at the API surface"), and in psql (`rls_phase2_crm.sql` § J).

**Why that is not the lockout described below.** The enrolment path needs `profiles`, `organisations` and `organisation_memberships`. It needs no CRM row. So an un-enrolled Owner still signs in, still loads the app, still reaches the enrolment screen — asserted as a lockout guard at both layers — and simply sees an empty CRM until they present a factor.

**What is still open.** A stolen `standard_user`, `booker`, `manager`, `venue_manager` or `marketing` password still reads that user's CRM rows at `aal1`, because MFA is **optional** for those roles at MVP and there is no factor to present. And Foundation's own read policies are unchanged, for the reason in the next paragraph. So the section title's original claim still holds for most of the product; it no longer holds for the largest tenant-data surface in it.

**"MFA gates CRM reads" reads stronger than it is, so state the residue explicitly.** A stolen `aal1` Owner password still yields **the organisation's entire user directory** — measured over HTTP: `profiles?select=*` returns 200 with every colleague's name and email, `organisation_memberships` returns 200 with the full role map, and only the CRM tables return zero rows. That is the enrolment-path exemption working as designed, not a second defect, but it is what an attacker actually gets and it should not be discovered during a pentest.

**Verified end to end, not assumed.** With a real TOTP factor rather than a hand-made claim set: an `aal1` password session reads `profiles`/`organisations`/`organisation_memberships`, `POST /auth/v1/factors` enrols, challenge-and-verify moves the same session to `aal2`, the CRM then reads and writes normally — and the *original* `aal1` token still returns zero rows on every CRM table. **The one thing Tasks 3-7 must not do is put a CRM query into the app shell, the MFA gate components, or `lib/auth`.** The moment a CRM read appears above `MfaEnrollGate` in `app/(app)/layout.tsx`, the un-enrolled privileged user stops being able to reach the enrolment screen and this stops being safe.

**A stolen password for a role where MFA is optional yields read access to that user's data at `aal1`.** This is a deliberate, understood boundary rather than an open defect, and it is written down here so it is found by review rather than rediscovered by a pentester.

The `aal2` requirement is attached to *permissions*, so it bites on writes. It is deliberately **not** attached to Foundation's read policies — `organisation_memberships_select_own` / `_select_same_organisation`, `profiles_select_own` / `_select_shared_organisation` and `organisations_select_member` all resolve to `auth.uid()` or `private.is_active_member()` and never call `has_permission()`. That is not an oversight: **gating those reads is precisely the lockout that would stop an un-enrolled user reaching the enrolment screen at all.** A privileged user who has never enrolled has to be able to load the app far enough to enrol, and there is no other way in. The CRM tables escape that argument only because nothing on the enrolment path reads them.

Two `SECURITY DEFINER` functions are also outside the gate, because they must be. Both are PostgREST-routable, and for both the MFA guard is app-layer only:

- `public.create_organisation()` — measured: an `aal1` session gets `200`. It cannot consult `has_permission()`, because a brand-new user holds no membership anywhere and the organisation they are creating is what makes them an Owner.
- `public.accept_invite()` — measured: a stolen-password admin invitee at `aal1` gets `204` and the membership becomes an active admin.

**Why this is not privilege escalation.** That newly-active admin's `has_permission()` is still `false` at `aal1`, so no privileged write is reachable: they cannot invite, cannot change roles, cannot rename or soft-delete the org, cannot touch entitlements or read the audit log. What the attacker gains is **read access to that org's CRM data**, which is exactly what a stolen password already granted before MFA existed.

**Why closing it is not straightforward.** Any fix has to distinguish "a session that has not presented a factor because it is on its way to enrol" from "a session that has not presented a factor because it never will", and those are the same session until the user acts. Candidate approaches, none free:

- Gate reads on `aal2` **except** the narrow set the enrolment screen needs. Workable, but the allowlist becomes a security-critical dependency of the UI: any new query on the enrolment path silently locks every privileged user out, invisibly to build, lint and type-check.
- Redirect rather than content-swap in `app/(app)/layout.tsx`. Improves the app path only and does nothing for a direct PostgREST call, which is the path that matters.
- Force the MFA challenge at the GoTrue level so no `aal1` session is ever issued to a privileged user. The cleanest answer, and not available: assurance level is per-session and Supabase issues `aal1` on password sign-in regardless of enrolled factors (measured, `tests/integration/mfa/mfa-lifecycle.test.ts`).

Revisit alongside Phase 7's superuser dashboard, where the first genuinely read-sensitive surface (cross-tenant audit log, impersonation) lands and the trade-off changes. Until then, the compensating controls are the ones in this section: the 30-minute inactivity timeout, the 12-hour session timebox, and the fact that every privileged *write* is refused.

- Step-up re-authentication (re-enter credentials/MFA) is required before: changing security settings (MFA, password, email), large data exports, deleting organisation data, and any high-risk admin/superuser function — including impersonation.
- Step-up prefers MFA re-verification over password re-entry: a password re-entry returns an `aal1` session (downgrading an MFA user) and mints a new session row (restarting the 12-hour absolute clock), so it is used only where no verified factor exists. A user with neither a verified factor nor a password identity (Google SSO only, no MFA) currently cannot satisfy step-up at all and is failed closed — closing that properly needs GoTrue's `reauthenticate()` email-nonce flow, tracked for Phase 7.
- Active-session listing with remote revocation is available to every user.
- Superuser impersonation is break-glass only: the superuser requests it, the target org's admin must accept, the session is time-boxed, and the whole flow is audited (actor, org, reason, start/end). No silent or unilateral impersonation.
- **Superuser dashboard** (single hardcoded superuser account at MVP): never exposes tenant record content directly — only aggregate metadata (seat count, storage, record counts). Org suspend/delete is soft-delete only, requires step-up re-auth, and notifies the org admin. Billing overrides require step-up re-auth, a mandatory audited reason, org-admin notification, and are time-boxed with auto-revert. Per-org feature overrides require a mandatory expiry date — no open-ended grants. Full spec in `CLAUDE.md` § Superuser dashboard.
- **In-app feedback screenshots are the one deliberate exception** to "no direct tenant-data access outside impersonation" — a screenshot can incidentally capture another org's on-screen data. The submit UI warns the user before upload, and every superuser view of a feedback screenshot is itself an audited action. See `CLAUDE.md` § In-app feedback and § 10 (Known risk areas) below.

## 5. Rate limiting and abuse prevention

Standard defaults — tune during implementation, but these are the numbers to build against:

| Endpoint category | Limit |
|---|---|
| Login | 5 attempts / 15 min, per IP **and** per account |
| Password recovery / verification | 3 / hour, per account |
| Search | 60 requests / min, per user |
| Exports | 5 / hour, per organisation |
| Network discovery | 30 requests / min, per user |
| In-app feedback submission | 10 / hour, per user |

- Every unbounded list/API endpoint is paginated (cursor/keyset for activity feeds); server-side page-size ceilings, never a client-defined unlimited limit.
- Exports are async and bounded — no synchronous unbounded export endpoint.

## 6. File security

- Private Supabase Storage buckets only. Short-lived signed URLs issued after authorisation.
- **Malware-scan every upload at MVP** (e.g. ClamAV or a scanning API); quarantined files are not openable until cleared.
- Accept only a **strict allowlist of file types** (documents, images, PDFs) — not just MIME/extension checks. No executables, no macro-enabled Office formats.
- Filenames are sanitised; user-supplied paths are never used as storage keys.
- Every upload, view/download, share and delete action is logged.

## 7. Audit logging

- Every high-value action records: actor, org, timestamp, action, target, correlation ID, before/after values.
- Append-only from the application. Superuser access audits itself. Passwords, tokens and keys are never logged.
- Retention: hot/queryable for 30 days, archived (cold storage) for up to 1 year total, then purged. Deletion/alteration of audit records outside that lifecycle is restricted to a narrowly controlled platform security process.

### CRM writes: what is audited today, and what is not (Phase 2, fix round 1)

**Audited in the database, by trigger, so a direct PostgREST call cannot avoid it:** the two hard `DELETE` paths Phase 2 opened (`contact_companies`, `custom_field_values`) and every `merges` insert (`20260828141000`). A trigger rather than application code, for the same reason the `updated_at` trigger exists: `grant … to authenticated` plus the anon key that ships in the browser makes `DELETE /rest/v1/contact_companies?id=eq…` reachable without touching the Next.js app, so an application-side audit records only the deletions someone remembered to route through it.

**Not audited yet:** every CRM `INSERT` and `UPDATE`. Deliberate and routed to Phase 7 alongside the audit log viewer — an update on a soft-delete-everything schema leaves the row in place, so what is lost is a previous *value*, and capturing that well needs a before/after diff design, a retention answer for the diffs, and something to read them with. A hard delete has no such recovery: if it is not captured when it happens it is not capturable at all, which is why the split falls there.

**The audit payload is an allowlist of identifiers, never user-entered content.** `private.audit_crm_payload()` projects each audited row down to its identifiers and structure and drops `custom_field_values.value` and `merges.field_resolution`. `audit_events` is readable by exactly one principal — the platform superuser — and `CLAUDE.md` § Superuser dashboard keeps tenant record content off that surface, describing the in-app feedback screenshot as *the one* deliberate exception. Dumping deleted rows into `before` would have quietly created a second one. **The cost:** this audit answers "who deleted what, when" and does **not** support restore-from-audit. If restore is wanted it needs a founder decision about superuser access to tenant content, or a tenant-scoped undo table rather than `audit_events`.

**Sessionless writers emit no audit row.** The trigger returns early when `auth.uid()` is null, because `private.log_audit_event()` raises `28000` on a null actor and an unconditional trigger would abort `DELETE FROM organisations` (which cascades into both audited tables with no session). What that excludes is migrations, seeds, DBA repair and the cascades they start — not any client path, since `service_role` holds no grant on these tables.

## 8. Data retention and residency

- Soft-delete operational records rather than hard deletion, subject to retention policy.
- Working defaults (pending legal sign-off — see `CLAUDE.md` § Legal and regulatory compliance): **7 years** for financial records, **2 years** for inactive-account data (also applied to in-app feedback submissions — see `CLAUDE.md` § In-app feedback), **30 days hot / 1 year archived** for audit logs.
- GDPR data subject requests (export/erasure): **30-day** target, matching the ICO statutory maximum.
- **Data residency: UK/EU Supabase region only** — no US-region hosting for customer data.
- Currency: **GBP only at MVP**; schema (`financial_entries` etc.) stores a currency column and minor units so multi-currency UI can be added later without a migration.

## 9. Non-functional security-adjacent targets

- Availability SLO: **99.9%**, excluding planned maintenance.
- Backup targets: **RPO 24h / RTO 4h** for the database, with tested restore procedures.

## 10. Known risk areas (for pentest/audit context)

Pulled from PRD §18. A tester or reviewer should focus here first — this is where a mistake has the highest blast radius.

| Risk | Why it matters | Where the mitigation lives |
|---|---|---|
| Network privacy leakage | Shared identities between `network_profiles` and tenant tables can accidentally expose private data — the single highest-risk boundary in the system. | §2 (RLS, separate tables), `CLAUDE.md` § "The private/network split" |
| Role/subscription complexity | The permission matrix (platform policy ∩ entitlement ∩ role ∩ record scope ∩ exception) is easy to get subtly wrong. | Centralised entitlement/policy evaluation; test every role×tenant×network combination — see Testing gates below |
| File security | Contracts, riders and IDs are high-impact if exposed. | §6 |
| User-generated ratings | Public ratings could create legal/reputational exposure. | Ratings are permanently private in v1 (`CLAUDE.md` decisions log) |
| Financial scope creep | Finance drifting toward full accounting software expands the attack surface unnecessarily. | Finance stays at event/booking level (budget & actuals only) at MVP |
| Integration dependencies | Ticketing/email providers add third-party trust boundaries. | Deferred past MVP; adapters + link-first design when built |
| Legal/compliance drift | UK privacy guidance changes over time. | Scheduled legal review, versioned legal pages |
| Feedback screenshot leakage | A feedback screenshot can incidentally show another org's on-screen data, reaching the superuser outside the impersonation flow. | Pre-upload warning + mandatory audit on every superuser view (`CLAUDE.md` § In-app feedback) |
| MFA covers writes, and CRM reads, but not Foundation reads | **Narrowed in Phase 2, not closed.** The twelve CRM tables are now `aal2`-gated for reads too, so a stolen Owner/Admin/Finance password reads no CRM data (measured over HTTP). Still open: MFA is *optional* for manager/booker/venue_manager/marketing/standard_user/read_only at MVP, so a stolen password for one of those still reads that user's CRM rows; Foundation's `profiles` / `organisations` / `organisation_memberships` reads are ungated for every role; and `create_organisation()` / `accept_invite()` are `SECURITY DEFINER` and outside the database gate entirely. | §4, "Known limitation: MFA gates privileged WRITES, and — since Phase 2 — CRM READS" — read it before testing this path |
| Child rows naming a parent in another tenant | A child table that carries its own `organisation_id` **and** a plain single-column FK to its parent lets a row claim one tenant while pointing at another's record. Proven end to end in Phase 2: a user inserted a `venue_rooms` row into a venue they could not even see, and the victim's own venue page rendered it. RLS does not catch this — the attacker's row passes their own org's `WITH CHECK`. | Tenant-scoped **composite** FKs, `(parent_id, organisation_id) → parent (id, organisation_id)` — `20260828001132`. Regression tests: `supabase/tests/schema_invariants.sql` § A. **Every new child table needs the composite form**; a plain FK is the defect. **The polymorphic half, which no foreign key can reach, is now closed at the policy layer.** `custom_field_values.entity_id` and `merges.winner_id`/`loser_id` are polymorphic (`entity_type` selects the table) and the *constraint* layer still accepts a uuid in any tenant — that has not changed and cannot. What closes it is `private.entity_is_visible()` / `private.entity_is_manageable()` (`20260828120500`), the per-`entity_type` `EXISTS` dispatch that resolves the id against the physical table named by `entity_type` and compares that row's `organisation_id` to the row's own. Both policies additionally lead with a hoistable organisation test, so a row in another tenant never reaches the dispatch. Regression tests: `supabase/tests/rls_phase2_crm.sql` § E (cross-tenant entity, wrong `entity_type`, dangling uuid, repointing an existing value, and both `merges` variants), plus an HTTP probe in `run-rls-tests.sh`. **Two things a pentester should still aim at here:** (1) the dispatch is the *only* control, so any writer that bypasses RLS — `postgres`, `service_role`, a future `SECURITY DEFINER` function — can still write a cross-tenant `entity_id`; (2) Phase 3 must add an `'event'` branch to **both** helpers at the same time it adds `'event'` to the three `entity_type` CHECK allowlists, or event custom-field values fail closed and someone will be tempted to widen the policy instead. |
| Subscription entitlement is built but deliberately INERT | `CLAUDE.md` § Permissions makes entitlement one of five intersecting terms and requires it server-side. Before Phase 2's fix round it was enforced nowhere — reproduced over HTTP: three Free-tier users POSTed artists, contacts and venues and got `201` each. It is now on all 25 CRM write policies via `private.crm_write_organisations()` — **but that function's `s.organisation_id is null` branch means an organisation with no subscription row is not gated, and `create_organisation()` creates no such row, so today it gates nothing.** Without that branch the gate would deny every CRM write in the product. A pentester should read this as "the machinery is wired and switched off", not as a control. **Status gating mirrors `lib/entitlements/policy.ts` exactly** (founder decision, 2026-08-28): `active` writes; `past_due` keeps the plan's entitlements for a 3-day grace window measured from `current_period_end`; `cancelled` and anything else fall back to Free at once. It is an allowlist of writing statuses, so a fourth status added later arrives denied. | `20260828140000` + `20260828150000`. Phase 7 removes the escape branch and backfills in one migration. `rls_phase2_crm.sql` § N and the "Subscription entitlement at the API surface" HTTP block drive it directly by inserting a real Free-tier row — they are the only things that will notice if the gate is broken while it is inert. The `3` exists in TypeScript and in SQL, bound by `tests/integration/entitlements/past-due-grace-matches-db.test.ts`. |
| A suspended (soft-deleted) organisation | **SUSPENSION IS READ-ONLY, NOT A LOCKOUT — this row was reversed by a founder decision and the previous text is now wrong in both directions.** History: until Phase 2's fix round, `organisations.deleted_at` was invisible to the permission engine, so a suspended tenant kept full CRM read **and** write (reproduced). Fix round 1 (`20260828140000`) closed *everything*, so a suspended customer saw an empty application. `DECISIONS-QUEUE.md` **Q6, answered 2026-08-28, overruled that**: suspension stops work without hiding a customer's own records from them — reads stay open, every write closes. Enforced by `public.permissions.survives_suspension` (`20260828210000`), a catalogue column joined by **both** `public.has_permission()` and `private.permitted_organisations()`, rather than by a permission-key literal in two function bodies. Today exactly one key is `true`: `view_crm`. **`survives_suspension` DEFAULTS TO FALSE**, so a permission added by a later phase arrives closed; opening one is a deliberate act with a diff. `public.role_permissions.permission_key` is now FK-bound to that catalogue, so a grant naming an uncatalogued key is rejected at write time. **The write half is closed twice over — but that was only true of the CRM tables until `20260828220000`, and this row said otherwise.** The 25 CRM write policies name `private.crm_write_organisations()`, which keeps its own *unconditional* `deleted_at` clause — measured: with the permission clause removed from both function bodies, CRM writes still refuse, changing mechanism from `ok(0)` to `denied(42501)`. The **four Foundation write policies** (`organisation_memberships` INSERT/UPDATE/DELETE, `organisations` UPDATE) consulted `has_permission()` **and nothing else**, so `manage_organisation.survives_suspension = false` was the *only* thing enforcing consequence P7. The Task 3a review proved it: one wrong `UPDATE public.permissions` and an aal2 Owner **un-suspended their own organisation**, and the same flip on `manage_members` let one **invite a new admin into a suspended organisation**. `20260828220000` adds the missing second gate — an unconditional `deleted_at is null` in `organisations_update_manage_organisation`'s `USING`, and `private.organisation_is_live()` in the three membership policies — so the claim is now true of every organisation-scoped write policy in the product. It is asserted by *disabling the first gate*: `rls_phase2_crm.sql` P11–P11d flip both catalogue booleans to `true` and prove the Owner still cannot un-suspend, rename, invite, promote or remove; P11e checks the term is still in all four policies; M1g still notices the flip itself. `private.is_active_member()` is unchanged, so members still read the organisation row, their memberships and the subscription row — which is what keeps the workspace switcher and the read-only state reachable at all. **Consequence, unchanged and intended:** `manage_organisation` is a write, so an organisation's own Owner cannot clear `deleted_at`. Reinstatement is a superuser action Phase 7 must ship alongside the suspend button. **What a pentester should aim at:** the read is now genuinely open for members of a suspended tenant, so the interesting target is whether it widened for a NON-member — it did not (§ P9-P9f), because the membership join is a separate term. **Known gap, not a database one:** `getCurrentOrg()` (`lib/auth/index.ts`) still filters `deleted_at`, so the read-only state is currently unreachable from the browser; routed in `FOLLOW-UPS.md`. | `20260828210000` (supersedes the suspension half of `20260828140000`) + `20260828220000` (the second gate on the four Foundation write policies); `rls_phase2_crm.sql` § P (88 assertions, including P11–P11e, which measure the second gate with the first one switched off) and § M1b/M1c–M1h |
| A record-scoped user is handed identifiers outside their scope | **Corrected assessment — the earlier note was wrong in the reassuring direction.** `contact_companies` is scoped by the contact and `artist_representations` by the artist (`DECISIONS-QUEUE` Q5 / Q3a), so a Standard User is handed the **primary key** of every company linked to a contact they own and of every agency and contact named by a representation on an artist they own — including rows entirely outside their record scope. The earlier text claimed this "requires guessing a v4 uuid and reveals nothing but existence"; nothing has to be guessed, the SELECT policy hands the ids over, and Q3a's "display wart, not a disclosure" is also wrong. **Bounded:** no attributes leak — a PostgREST embed of `companies(*)` renders `null` and `companies!inner(*)` renders `[]`. **The write half is real:** a Standard User can create and delete links to companies they cannot see, and those links surface on the company's page for full-scope users. The product decision stands (closing the read half means the `AND` Q5 rejected); the write half belongs in Task 4's form, offering only companies the caller can read. | Corrected on the policies themselves (`comment on policy`, `20260828140500`), in `FOLLOW-UPS.md`, and here |
| Tables created outside migrations arrive granted to `anon` | The `ALTER DEFAULT PRIVILEGES` baseline is scoped to the `postgres` role. `supabase_admin` has its own default ACL for `public` granting `anon`/`authenticated`/`service_role` full `arwdDxtm`, and `postgres` can neither assume that role nor alter its defaults (both measured). A `public` table created by `supabase_admin` is therefore writable by anonymous API callers. | Procedural: create tables through migrations only. `20260827232507` covers everything `postgres` creates; `schema_invariants.sql` D6/D7 assert it holds. Periodic `relacl` audit is a Phase 10 item in `FOLLOW-UPS.md`. |

Tenant-breakout and network-leakage tests matter more than anything else in this list — they should exist before a feature ships, not be added after.

## 11. Testing gates

Per `CLAUDE.md` § Testing gates and PRD §16, before a release:

- RLS integration tests across roles, tenants and network visibility.
- API tests for validation, parameterisation, pagination and rate limiting.
- Security tests: XSS, SQL injection, IDOR/BOLA, CSRF, session fixation/hijacking, insecure file access, privilege escalation, tenant breakout.
- Accessibility: automated tooling plus keyboard/screen-reader spot checks.
- Dependency, secret and license scanning in CI.
- Manual review of every privileged function and every use of a service-role key.
- Pre-production backup restore test.
- Independent penetration test before general availability.

### Skills that run these gates

Pinned in `skills-lock.json`, vendored to `.agents/skills/` (roster and design-side skills in `DESIGN.md` § "Build-time design tooling"):

| Gate | Skill |
|---|---|
| RLS policy design and Postgres correctness | `supabase`, `supabase-postgres-best-practices` (official Supabase) |
| RLS bypass audit — the tenant-breakout gate | `supabase-audit-rls` |
| XSS / SQLi / IDOR / CSRF / authz review | `owasp-security-check` |
| RLS integration + API tests | `javascript-testing-patterns` |
| Golden-path and tenant-breakout E2E | `e2e-testing-patterns` (Playwright) |
| Automated WCAG 2.2 AA audit | `wcag-audit-patterns` |
| Screen-reader spot checks | `screen-reader-testing` |

**`supabase-audit-rls` is a live pentest tool. Rules for using it:**

1. **Never against production.** Local Supabase or a seeded staging project only.
2. **Anon key only** — never the service-role key; the point is to attack from the client's position.
3. It writes `.sb-pentest-context.json` and `.sb-pentest-audit.log` into the working directory. Both are gitignored: findings and keys never get committed.
4. Findings are triaged into this file's § 10 (Known risk areas), not left in the log.
5. It supplements the written RLS integration tests — it does not replace them. A policy is verified by a test that runs in CI, every time.

## 12. Incident response

Current stage (single founder, pre-launch): no formal on-call rotation yet.

- **Security contact:** the founder is the sole point of contact at this stage. *(TODO before launch: set up a dedicated security contact channel — see §13 — rather than a personal inbox.)*
- **Severity tiers:**
  - **Sev1** — active breach, confirmed data exposure, or a live exploit: response target **1 hour**.
  - **Sev2** — exploitable vulnerability, no evidence of exploitation: response target **24 hours**.
  - **Sev3** — low-risk finding, hardening opportunity: addressed **next sprint**.
- **Regulatory obligation:** notifiable UK GDPR breaches must be reported to the ICO without undue delay and, where feasible, within **72 hours** — this clock starts independent of the internal severity tiers above.
- A full written runbook (roles, communication plan, customer notification templates, post-incident review process) is still to be drafted — flag as open work before handling real customer data.
- **Basic trigger-based alerting ships at MVP** via the superuser dashboard: email/SMS on specific events (e.g. repeated failed logins across an org, a malware-scan hit). This is not a full alerting/observability platform — just enough to catch the incidents in the severity table above before a customer reports them.

## 13. Vulnerability disclosure

At MVP, external researchers report through the **general support channel** — there is no dedicated `security@` address or `security.txt` yet. This is a deliberately minimal starting point; revisit once there's a real user base to protect (a dedicated inbox and `security.txt` are cheap to add later and should not block launch).

## 14. Open security decisions

Carried over from `CLAUDE.md` § Open decisions — these need founder/legal input, not an engineering default:

- Exact retention periods per record type (legal/privacy counsel sign-off required).
- Whether/when to stand up a dedicated vulnerability disclosure channel and incident response runbook in full.
- First ticketing API partner (affects integration-specific threat modelling when that phase starts).
- EU Art 27 representative appointment (unconfirmed) — see `CLAUDE.md` § Legal and regulatory compliance.
- DPIA, ROPA and ICO controller registration — all outstanding pre-launch legal tasks, see `CLAUDE.md` § Legal and regulatory compliance.
- Analytics/tracking vendor and payment processor selection — both undecided, and both change the compliance surface (PECR cookie consent; PCI DSS scope) once chosen.

## 15. Pre-launch security checklist (config that does not ship itself)

`supabase/config.toml` governs the **local CLI stack only**. Nothing in this repo pushes it to a hosted Supabase project, so every value below must be set by hand in the hosted project's dashboard before launch, or the control it represents does not exist in the environment that matters:

- `jwt_expiry = 900` — bounds how long an already-issued access token keeps working after its underlying session has been invalidated server-side. Left at the 3600s default, that window is an hour.
- `[auth.sessions] timebox = "12h"` and `inactivity_timeout = "30m"` — these are what actually enforce the session limits in § 4; the app-side idle tracker is a proactive UX layer on top, not the enforcement.
- `[auth.mfa.totp] enroll_enabled` / `verify_enabled = true` — without these the MFA gate has nothing to enroll or challenge against.
- `minimum_password_length = 10` — must match `MIN_PASSWORD_LENGTH` in `lib/forms.ts`, or the app's validation is bypassable by calling GoTrue directly.

### The platform superuser grant

`public.platform_admins` is the platform-superuser allowlist. It has RLS enabled with **zero policies and zero client grants**, so no client role — not even a leaked service-role key — can write to it. Rows are added by migration or DBA action only, and it seeds **empty** on purpose.

That is the correct shape for the table and a launch blocker for the product, because three separately-correct decisions compose into a dead end while it stays empty:

- `audit_events`' only SELECT policy is `has_platform_permission('view_audit_log')`. **With an empty allowlist the audit trail is write-only** — it is being recorded correctly and cannot be read by anyone, through any path the application offers.
- `organisation_subscriptions`' write policies are superuser-only and `create_organisation()` writes no subscription row, so **every organisation resolves to Free with `crmWrites: false`, permanently**, with no manual override available to anybody.
- The Platform-Superuser branch of the MFA gate and `public.is_platform_admin()` are dead code until a row exists.

`supabase/migrations/20260827210500_seed_platform_superuser.sql` grants it to the founder. Two things about it need checking after deploy, which is why it is on this list rather than assumed done:

1. **It looks the user up by email, and is a no-op if that account does not exist yet.** No Supabase auth user id existed when it was written, so it could not hardcode a UUID. If the migration is applied before the founder has signed up, the allowlist stays empty and the migration must be re-run afterwards. It is idempotent (`on conflict do nothing`), so re-running is safe.
2. **Verify the row actually landed**, rather than assuming the migration did it:
   ```sql
   select u.email from public.platform_admins pa join auth.users u on u.id = pa.user_id;
   ```
   An empty result means the product is in the dead-end state described above.

Granting or revoking further superusers is documented in that migration's header. Note that allowlist membership is necessary but **not sufficient**: per § 4 and `20260827210000_mfa_aal_permission_gate.sql`, every platform permission also requires an `aal2` session, so the founder must enrol TOTP before any superuser-gated policy will pass.

### Response security headers

Set in code, not config, so they ship with the app rather than needing a hosted-dashboard step — listed here so a launch review can confirm them rather than assume them. `lib/security/headers.ts` is the single definition; `next.config.ts` applies the static ones and `proxy.ts` applies the nonce-bearing CSP.

Two of them are **deliberately conditional on `NEXT_PUBLIC_SITE_URL` being `https:`**, and therefore are NOT present in local development:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `upgrade-insecure-requests` in the CSP

So confirm on the deployed environment, by reading actual response headers (`curl -sSI https://<host>/login`), that both appear. If `NEXT_PUBLIC_SITE_URL` is misconfigured to `http://` in production, the app will work and will silently ship without HSTS.
