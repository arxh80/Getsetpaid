-- MFA for every organisation role (audit 2026-11-09, finding 1; founder ruling
-- 2026-11-10).
--
-- The hosted plan (Pro) refuses HOOK_PASSWORD_VERIFICATION_ATTEMPT, so a
-- password grant sent straight to GoTrue is bounded per IP only (F8). A guessed
-- password still yields only an aal1 session, and has_permission() and the CRM
-- policy helpers already refuse an MFA-required role below aal2. Making every
-- role MFA-required turns a guessed password into a session that can read or
-- write nothing in any workspace.
--
-- `true`, not a list of the nine roles: a role added later is gated by default
-- (fail closed) instead of silently exempt. Still IMMUTABLE and table-free, for
-- the reasons 20260827210000 gives. lib/auth/mfa-gate.ts's MFA_REQUIRED_ROLES
-- mirrors it, and tests/integration/mfa/roles-match-db.test.ts holds the two
-- equal over the role catalogue.
create or replace function private.role_requires_mfa(p_role text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select true;
$$;

comment on function private.role_requires_mfa(text) is
  'True for every organisation role: CLAUDE.md § Session security requires MFA for all of them since 2026-11-10 (audit 2026-11-09, finding 1). Kept as a function so every gate that reads it is unchanged. Mirrors MFA_REQUIRED_ROLES in lib/auth/mfa-gate.ts.';
