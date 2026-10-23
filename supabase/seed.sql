-- Local dev seed data.
--
-- Intentionally empty.
--
-- Reference/lookup data (roles, role_permissions, subscription_plans) used to
-- live here. It has moved to a migration --
-- migrations/20260826202023_reference_data.sql -- because seed.sql runs on
-- `supabase db reset` only and never on `supabase db push`, so a freshly
-- pushed hosted project would have come up with zero roles and zero
-- permissions and been non-functional. That file explains the reasoning in
-- full.
--
-- What belongs here going forward: genuinely dev-only sample data (fake orgs,
-- demo contacts, throwaway fixtures) that must never reach a real environment.
-- Anything the application reads at runtime to work correctly belongs in a
-- migration instead.
--
-- Note the RLS test suite (supabase/tests/) does NOT rely on this file -- it
-- builds its own fixtures and requires an empty public schema.

-- THE LOCAL SERVER-ONLY REQUEST MARK (Phase 10 Task 5). The digest of the
-- clearly-local value .env.example documents for GETSETPAID_SERVER_REQUEST_SECRET,
-- so `pnpm dev`, the psql runner and the vitest fixtures can read the network
-- directory and use impersonation. Not a secret, and never a hosted value:
-- every other environment inserts its own digest (SECURITY.md § 15).
insert into private.server_request_digest (digest)
values (sha256(convert_to('local-only-server-request-mark-not-a-secret', 'UTF8')));
