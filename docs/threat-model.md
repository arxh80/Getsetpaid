# Threat model

PRD § 10.8 asks for a threat model of every major flow: authentication,
multi-tenancy, network sharing, files, exports, finance, email and admin.
`SECURITY.md` § 1 makes it an acceptance criterion. This is it, one STRIDE
table per flow (Spoofing, Tampering, Repudiation, Information disclosure,
Denial of service, Elevation of privilege).

Each row names the threat, the control that answers it, and the test that
proves the control. A row whose control is missing or partial says so and
points at the residual in `SECURITY.md` § 10 or the open gap in
`docs/launch-gates.md`. `tests/unit/security/threat-model-references.test.ts`
fails if a flow section goes missing or a test this document cites is deleted
or moved.

Written 2026-10-20 (Phase 10 Task 2, G19). The OWASP pass's findings
(F1-F10) are in `.superpowers/sdd/2026-10-16-launch-hardening/task-2-findings.md`.

**The one assumption every table rests on:** the anon key and a user's session
token reach PostgREST and GoTrue directly, without the Next.js app
(`SECURITY.md` § 4). So a control counts only if it holds in the database or in
GoTrue. An app-only control is listed as "app layer" and its direct-API gap is
named.

## 1. Authentication

Sign-up, sign-in (password, magic link, Google), MFA, sessions, step-up,
invites.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| S | Account pre-hijack: a squatter registers a victim's address before an invitation reaches it (G11) | Confirmations on; the invite step refuses an unconfirmed sign-up; `accept_invite()` refuses an unconfirmed account; an address's first proof replaces any password chosen in another browser | `tests/e2e/invite-pre-hijack.spec.ts`, `tests/e2e/first-proof-password.spec.ts`, `tests/unit/auth/first-proof.test.ts`, `supabase/tests/rls_foundation.sql` (J11-J12), `tests/unit/security/auth-config.test.ts` | Hosted templates are a founder action (`SECURITY.md` § 15, Q247) |
| S | Password brute force | Per-account lockout (5 failures per 15 min) twice over: GoTrue's password-verification hook, and the app's own budget, 5 attempts counted atomically BEFORE GoTrue and cleared by a success (`public.meter_password_sign_in`, G4 fallback; the sixth attempt never reaches GoTrue, with the wrong-password message, for addresses with and without an account); GoTrue's per-IP limit (30 per 5 min; but every call comes from the app server, so on the hosted project that is per SERVER IP, a shared bucket, until the client IP is forwarded: G10, Q275) | `supabase/tests/rls_phase7_rate_limits.sql` (§ RH, § RE), `tests/integration/security/login-account-budget.test.ts`, `tests/unit/security/auth-config.test.ts` (per-IP values, G10) | The hook is not on the hosted plan until F8; a password grant sent straight to GoTrue skips the app's budget, so without F8 that path is bounded per IP only. The live per-IP check is a hosted `SECURITY.md` § 15 step |
| S | Password-recovery flood or takeover attempts against one account | GoTrue's per-account mail timer, `max_frequency = 20m` (at most 3 recovery mails per hour, G3); the magic-link and sign-up forms answer that throttle like success, so it reveals no account | `tests/integration/security/recovery-frequency.test.ts`, `tests/unit/security/auth-config.test.ts`, `tests/unit/auth/mail-throttle-oracle.test.ts` | The same timer delays an emailed sign-in link by up to 20 minutes after any recovery or link mail, including one a stranger requested (Q260) |
| S | A stolen Owner/Admin/Finance password | MFA required for those roles, enforced in the database: `has_permission()` is false below aal2 | `supabase/tests/rls_foundation.sql` (§ K), `tests/integration/mfa/aal-enforcement.test.ts`, `tests/integration/mfa/mfa-lifecycle.test.ts` | Foundation reads (profiles, memberships) stay readable at aal1 (`SECURITY.md` § 10, "MFA covers writes ...") |
| T | Cross-site request forgery: another site posts a Server Action with the visitor's cookies (G12) | Next refuses a Server Action whose Origin differs from Host, with no `serverActions.allowedOrigins`; auth cookies SameSite=Lax; `/api/*` routes need a bearer secret | `tests/e2e/csrf.spec.ts`, `tests/unit/security/next-config.test.ts`, `tests/e2e/super-permissions.spec.ts` | GET download routes write an audit row and redirect to a signed URL, so a top-level cross-site link can make a signed-in visitor download a file they are already allowed to read, and log it; no cross-origin read is possible |
| T | Open redirect through `?next=` after sign-in, or at `/auth/callback` (F5) | `safeNextPath()` keeps same-origin paths only, checked before and after URL parsing | `tests/unit/auth/redirects.test.ts` | none |
| I | Session tokens read off the wire or by script | Auth cookies `Secure` in production (F6), SameSite=Lax; CSP with per-request nonce | `tests/unit/security/auth-cookie-secure.test.ts`, `tests/unit/legal/storage-census.test.ts`, `tests/unit/security/headers.test.ts`, `tests/e2e/csrf.spec.ts` | The tokens are JS-readable by `@supabase/ssr` design, so XSS is session theft and the CSP is the control (directives pinned since G17 closed); `style-src 'unsafe-inline'` stays (`lib/security/headers.ts`) |
| I | A stale or borrowed session lives on | 30-minute inactivity and 12-hour absolute limits in GoTrue; sign-out revokes the refresh token server-side; a planted auth cookie is refused and replaced at sign-in | `tests/integration/session/session-limits.test.ts`, `tests/unit/auth/idle-timeout.test.ts`, `tests/integration/session/fixation-and-revocation.test.ts`, `tests/e2e/session-fixation.spec.ts` | An access token already issued lives until `jwt_expiry` (900s) after sign-out; only refresh is revoked |
| E | A stolen token changes the password, or swaps the MFA factor, straight through GoTrue, skipping step-up (F3) | Step-up for the app's password form (app layer); GoTrue emails the holder on every password change and every factor added or removed | `tests/unit/auth/step-up.test.ts`, `tests/integration/session/security-notifications.test.ts` | No GoTrue-side gate in the pinned toolchain (`SECURITY.md` § 4, § 10) |
| E | Step-up skipped for a privileged action by calling its RPC over PostgREST | Step-up checked in the app, then enforced in the database: each gated RPC spends a single-use, 5-minute token only the server can mint (`20261108001000`, G13 closed) | `supabase/tests/rls_phase10_step_up.sql`, `tests/unit/security/step-up-token-callers.test.ts`, `tests/unit/auth/step-up-gate.test.ts` | A token is bound to the user, not the session, and one minted before a later app-side refusal lives out its 5 minutes (`SECURITY.md` § 4, Q256) |
| R | A sign-in or security change nobody can trace | GoTrue's own audit log; lockouts raise an incident alert | `supabase/tests/rls_phase7_rate_limits.sql` | none |
| D | Anyone exhausts the project-wide auth email budget (F7) | GoTrue `email_sent` per hour | `tests/unit/security/auth-config.test.ts` | Not per user; no captcha (`SECURITY.md` § 10) |
| S | Login CSRF: a link to `/auth/callback` with the attacker's own magic-link token signs the visitor into the attacker's account (F8) | Token single-use, one-hour expiry | none | Accepted (`SECURITY.md` § 10) |

## 2. Multi-tenancy

Organisations, memberships, roles, entitlements, RLS on every tenant table.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| I | Tenant breakout: one workspace reads another's rows | RLS on every tenant table, membership checked in the database from `auth.uid()` | `supabase/tests/rls_foundation.sql`, `supabase/tests/rls_phase2_crm.sql`, `tests/integration/rls/rls.test.ts`, `tests/e2e/tenant-breakout.spec.ts` | Suites not in CI (G1) |
| I | Enumeration: a refused record looks different from a missing one | Streamed not-found parity for record refusals | `tests/e2e/tenant-breakout.spec.ts`, `tests/e2e/phase8-refusal-parity.spec.ts` | none |
| T | A child row claims one tenant and points at another's parent | Tenant-scoped composite foreign keys | `supabase/tests/rls_phase2_crm.sql`, `supabase/tests/schema_invariants.sql` | none |
| E | An Admin makes themselves an Owner, or removes an Owner (F2) | Only an active Owner may write a membership row whose role is owner (`20261106000000`, Q248) | `supabase/tests/rls_foundation.sql` (§ O) | none |
| E | A member grants themselves platform superuser, or mints an active membership | Write policies refuse `platform_superuser` and any status but `invited` | `supabase/tests/rls_foundation.sql` (§ C, § D) | none |
| E | A role reaches an RPC or relation it should not | Permission matrix: every exposed function and relation, nine principals | `tests/integration/security/phase7-permission-matrix.test.ts` | none |
| E | A Free or Starter workspace writes past its tier | Entitlement term on every write policy, effective tier resolved in the database | `tests/integration/entitlements/tiers-match-db.test.ts`, `tests/e2e/finance.spec.ts` | none |
| R | A tenant write nobody can attribute | Audit triggers on CRM and membership writes, actor from the session | `tests/integration/admin/crm-audit-coverage-census.test.ts`, `supabase/tests/rls_phase7_crm_audit.sql` | none |
| D | Unbounded list reads | One list chokepoint with a page ceiling and keyset cursors | `tests/integration/list/` | Eight unbounded reads outside it (G5-G8) |

## 3. Network sharing

Published profiles, directory, connection requests, private-record links.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| I | Reading `connections`-level fields, or a publisher's private ids, without an accepted connection (F1) | The base table answers only its own workspace; the two views are the only foreign read path | `supabase/tests/network_leakage_phase6.sql` (LB6, LB13), `supabase/tests/rls_phase6_network.sql`, `tests/e2e/network-leakage.spec.ts` | Hosted view owner must bypass RLS (`SECURITY.md` § 15) |
| I | A private record (notes, finance, documents, ratings) unlocked by an accepted request | Acceptance changes only which published fields resolve; no policy on any tenant table reads connections | `supabase/tests/network_leakage_phase6.sql` | none |
| I | A publisher learns who linked their profile | `network_links` readable only by the linking workspace | `supabase/tests/rls_phase6_network.sql` | none |
| D | Directory scraping | 30 reads/min per user at the list chokepoint | `tests/integration/security/rate-limit-network-discovery.test.ts` | Direct PostgREST reads of the views are unmetered (G2) |
| D | Connection-request spam after a decline (Q79) | 10 requests/hour per organisation, at the insert | `tests/integration/security/connection-request-budget.test.ts` | none |
| T | Linking or requesting against a profile the caller cannot see | Write policies use the views' visibility predicate | `supabase/tests/network_leakage_phase6.sql` (LB13) | none |

## 4. Files

Document upload, scan, download; feedback screenshots.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| T | Malware or an executable uploaded | Magic-byte allowlist, size limit, scan before availability, quarantine | `tests/unit/security/file-allowlist.test.ts`, `tests/unit/security/malware-scan.test.ts`, `tests/integration/documents/upload-scan-download.test.ts` | Real ClamAV detection unproven (G15) |
| I | Downloading another tenant's file, or a quarantined one | Server-mediated download: RLS row read, scan status gate (409), audit row, then a short-lived signed URL; Storage itself deny-all to clients | `supabase/tests/file_access_phase4.sql`, `tests/e2e/documents.spec.ts`, `tests/unit/security/storage-client-census.test.ts` | none |
| T | A storage key pointing into another tenant | Key built server-side and pinned by a CHECK on its shape | `supabase/tests/schema_invariants.sql`, `tests/unit/crm/storage-keys.test.ts` | none |
| I | A feedback screenshot shows another org's data to the superuser | Warning before upload; every view audited before a 60-second URL | `supabase/tests/rls_phase7_feedback.sql`, `tests/e2e/feedback.spec.ts` | Deliberate exception (`SECURITY.md` § 10) |
| D | Upload flooding | 10 uploads/hour per user before any byte reaches Storage | `tests/integration/documents/upload-rate-limit.test.ts` | none |

## 5. Exports

Workspace and account exports, closure backups, the export runner.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| I | An export carries rows the requester could not read | The runner reads page by page as the requester (`export_read_page`) | `supabase/tests/rls_phase8_exports.sql`, `tests/integration/export/runner.test.ts` | none |
| I | Someone else downloads an archive | Download only by the requester, audited, signed URL | `supabase/tests/rls_phase8_exports.sql`, `tests/e2e/exports.spec.ts` | none |
| S | A forged call to the runner | Bearer secret of 32+ characters, constant-time compare, 404 whether the secret is wrong or unset | `tests/e2e/super-permissions.spec.ts` | Runner-auth helper consolidation (Task 25) |
| E | A workspace export started without step-up | Step-up in the app; the `export_jobs` insert spends a `workspace_export` token (`20261108001000`, G13 closed) | `supabase/tests/rls_phase10_step_up.sql`, `supabase/tests/rls_phase8_exports.sql` | Same token residuals as § 1 (`SECURITY.md` § 4) |
| D | Export flooding | 5/hour per organisation and per user, at the insert | `supabase/tests/rls_phase8_exports.sql` (§ XW) | none |
| I | A closure backup left incomplete or read by the wrong person | Completeness census; only the closing Owner downloads | `supabase/tests/rls_phase8_closure_backup.sql`, `supabase/tests/rls_q228_closure_backup_parts.sql`, `tests/e2e/closure-backup-parts.spec.ts` | none |

## 6. Finance

Event-level budget and actual lines.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| I | A non-finance role, another tenant, or a Starter workspace reads money | Finance RLS on role and tier; aal2 for Finance | `supabase/tests/rls_phase5_finance.sql`, `tests/e2e/finance.spec.ts` | none |
| T | A line attached to another tenant's event | Tenant-scoped composite FK to the event | `supabase/tests/rls_phase5_finance.sql` | none |
| T | Amounts with float error | Integer minor units and a currency column, GBP only; the summary sums integers | `tests/unit/crm/finance-summary.test.ts` | none |
| R | A changed figure nobody can trace | Audited CRM writes | `supabase/tests/rls_phase8_crm_audit_p3_6.sql` | none |
| E | A downgraded workspace keeps writing finance | Tier term on every finance write; downgrade is read-only, never delete | `supabase/tests/rls_phase5_finance.sql` | none |

## 7. Email

Transactional mail (Brevo), GoTrue auth mail, notification queues.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| T | HTML injection through user text in a notification body | Every interpolated value escaped | `tests/unit/email/templates.test.ts` | none |
| I | Free text, a signed URL or a rejection reason in a requester email | Allowlisted fields only; the export-ready notice links the page, never the file | `tests/unit/email/requester-templates.test.ts`, `tests/integration/email/requester-notifications.test.ts` | none |
| I | The service-role client used beyond its sanctioned callers | Importer census | `tests/unit/email/service-client-census.test.ts` | `lib/supabase/admin.ts` not censused (G27) |
| S | A forged delivery call | Bearer secret, constant-time compare, 404 otherwise | `tests/unit/email/delivery-route.test.ts`, `tests/e2e/super-permissions.spec.ts` | none |
| D | One queue starves the others | Fair queue draining | `tests/integration/email/notice-queue-fairness.test.ts` | none |
| D | Invitation spam from a fresh workspace (F9) | Invites need manage_members at aal2 | `supabase/tests/rls_foundation.sql` | Unmetered (`SECURITY.md` § 10) |

## 8. Admin

The platform superuser: impersonation, lifecycle, overrides, audit log, retention, DSRs.

| STRIDE | Threat | Control | Proved by | Residual |
|---|---|---|---|---|
| E | Silent or unilateral impersonation | Org-admin acceptance, time box, every transition and page audited | `supabase/tests/rls_phase7_impersonation.sql`, `tests/e2e/impersonation.spec.ts` | Direct reads while impersonating are unaudited (G14) |
| E | A non-superuser, or an aal1 superuser, reaches a super surface | Platform permission at aal2 in the database; super routes census | `tests/e2e/super-permissions.spec.ts`, `tests/unit/security/super-page-census.test.ts` | none |
| R | Superuser actions without a trail | Every lifecycle, override and DSR transition writes an audit row with a mandatory reason | `supabase/tests/rls_phase7_lifecycle.sql`, `supabase/tests/rls_phase7_overrides.sql`, `tests/e2e/audit-log.spec.ts` | none |
| T | Audit rows deleted or edited | Append-only from clients; deletion only by the retention job's controlled path | `supabase/tests/rls_foundation.sql` (§ E), `supabase/tests/rls_phase8_retention.sql` | none |
| E | A permanent comp or feature grant | Mandatory expiry, read-time revert | `supabase/tests/rls_phase7_overrides.sql`, `tests/e2e/overrides.spec.ts` | none |
| D | The retention job deletes more than it should | Dry run, purge ceiling, manifest from the database | `supabase/tests/rls_phase8_retention.sql`, `tests/integration/retention/runner.test.ts` | none |
| I | Superuser reads tenant content outside impersonation | Dashboard shows aggregates only | `tests/e2e/platform-health.spec.ts` | Feedback screenshots (flow 4) |
