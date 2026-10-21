-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 1: THE TOMBSTONE (Q130).
--
-- Deleting an `auth.users` row is impossible today for almost anybody. Thirteen
-- foreign key constraints point at it with NO ON DELETE ACTION, measured on the
-- live catalogue at 164 migrations:
--
--   audit_events.actor_user_id                  merges.merged_by
--   data_subject_request_notes.author_user_id   merge_candidates.resolved_by
--   data_subject_requests.user_id               incident_alerts.resolved_by
--   impersonation_sessions.superuser_user_id    organisation_billing_overrides.granted_by
--   impersonation_sessions.admin_accepted_by    organisation_billing_overrides.revoked_by
--   impersonation_sessions.declined_by          organisation_feature_overrides.granted_by
--                                               organisation_feature_overrides.revoked_by
--
-- (`phase-8-inventory.md` said "notes.author_user_id" was an eighth. MEASURED
-- FALSE: public.notes has no such column -- its author is `owner_user_id` and
-- that FK is ON DELETE SET NULL. The eighth was
-- data_subject_request_notes.author_user_id, which is a different table. The
-- inventory is corrected by this task.)
--
-- Every one of those columns is EVIDENCE: who resolved an alert, who merged two
-- contacts, who accepted break-glass access to a workspace, who granted a comp.
-- Deleting the rows would destroy the audit trail the product's own security
-- claims rest on. Nulling the columns is not possible either -- five of them are
-- NOT NULL, and a nullable one would make "nobody did this" and "the actor is
-- gone" the same statement.
--
-- SO: one platform-owned identity that every such reference is rewritten to.
-- The row keeps WHAT HAPPENED and loses WHO DID IT, which is what
-- pseudonymisation means. A single tombstone rather than one per erasure,
-- deliberately: a per-person tombstone is a per-person identifier, and a stable
-- per-person identifier that survives erasure is not erasure.
--
-- THE COST, STATED: two erased people's audit rows become indistinguishable
-- from each other. That is the point, and it is also the reason this is a
-- one-way door -- there is no un-erase.
--
-- ===========================================================================
-- WHAT MAKES IT SAFE
-- ===========================================================================
-- It is created HERE, by a migration, not by application code (the brief). And
-- three properties are enforced rather than asserted:
--
--   1. IT CAN NEVER SIGN IN. No password, no confirmed email, no identity row,
--      an address in the RFC 2606 `.invalid` TLD that can never receive mail,
--      and `banned_until` at 'infinity' -- GoTrue refuses a banned user. A
--      trigger on auth.users refuses any UPDATE that would relax any of those.
--   2. IT CAN NEVER BE A MEMBER OF ANYTHING, nor a platform admin. Triggers on
--      public.organisation_memberships and public.platform_admins refuse it.
--      Without this, an erasure that re-pointed a membership (it does not, but
--      a later phase's table might) would hand every erased person's seat to
--      one identity that anybody could then be granted.
--   3. IT CAN NEVER BE DELETED. The same auth.users trigger refuses the DELETE,
--      so an erasure job cannot destroy the anchor every pseudonymised row
--      hangs from -- including, one day, its own.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE ID, AS A FUNCTION RATHER THAN A LITERAL SPRAYED ACROSS THE SCHEMA.
--
--    IMMUTABLE and constant so it can be used in an index predicate or a CHECK
--    later if one is ever wanted, and so a reader has one place to look.
-- ---------------------------------------------------------------------------

create or replace function private.erased_user_id()
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $$ select '00000000-0000-4000-8000-0000e7a5ed00'::uuid $$;

comment on function private.erased_user_id() is
  'The Q130 TOMBSTONE: the single platform-owned identity that every no-ON-DELETE reference to a person is rewritten to when their account is erased. Created by 20260930000000, never by application code. It has no password, no identity row, an unconfirmed address in the RFC 2606 .invalid TLD and banned_until = infinity, so it can never sign in; triggers refuse it a membership, a platform_admins row, any relaxation of those properties, and its own deletion. One tombstone for everybody on purpose -- a per-person tombstone is a per-person identifier, and an identifier that survives erasure is not erasure.';

revoke all on function private.erased_user_id() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE ROW. `on conflict do nothing` so a database that somehow already has
--    it (a restore, a re-run) is not a failed migration.
--
--    The AFTER INSERT trigger private.handle_new_user() gives it a profile;
--    the update below names it, so an operator reading a pseudonymised audit
--    row sees a sentence rather than a blank.
-- ---------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at, confirmation_sent_at,
  banned_until, is_sso_user, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  private.erased_user_id(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'erased-user@platform.getsetpaid.invalid',
  null,        -- no password: there is nothing to present
  null,        -- never confirmed: a magic link cannot complete either
  null,
  'infinity',  -- and banned outright, which GoTrue checks on every grant
  false,
  false,
  '{"provider": "platform", "providers": ["platform"], "platform_tombstone": true}'::jsonb,
  '{"full_name": "Erased user"}'::jsonb,
  pg_catalog.now(),
  pg_catalog.now()
)
on conflict (id) do nothing;

update public.profiles
   set full_name = 'Erased user'
 where id = private.erased_user_id()
   and full_name is distinct from 'Erased user';


-- ---------------------------------------------------------------------------
-- 3. IT CAN NEVER BE A MEMBER, AND NEVER A PLATFORM ADMIN.
--
--    Two triggers rather than a CHECK because a CHECK cannot call a function
--    that reads another table -- and here it could, but a trigger is what the
--    rest of this schema uses for "this row may not say that" and it carries
--    a sentence a person can read.
-- ---------------------------------------------------------------------------

create or replace function private.tombstone_is_nobody()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := case tg_table_name
                 when 'organisation_memberships' then new.user_id
                 when 'platform_admins'          then new.user_id
               end;
begin
  if v_id = private.erased_user_id() then
    raise exception 'the erased-user tombstone is not a person: it cannot hold a % row', tg_table_name
      using errcode = '42501', hint = 'tombstone_is_nobody';
  end if;
  return new;
end;
$$;

comment on function private.tombstone_is_nobody() is
  'BEFORE INSERT OR UPDATE on public.organisation_memberships and public.platform_admins: the Q130 tombstone may never hold either row. Without it, a future table whose erasure re-point walked a membership column would collect every erased person''s seat onto one identity -- and anybody who could be granted that identity would inherit them all. 42501, hint tombstone_is_nobody.';

create trigger organisation_memberships_not_the_tombstone
  before insert or update on public.organisation_memberships
  for each row execute function private.tombstone_is_nobody();

create trigger platform_admins_not_the_tombstone
  before insert or update on public.platform_admins
  for each row execute function private.tombstone_is_nobody();


-- ---------------------------------------------------------------------------
-- 4. IT CAN NEVER SIGN IN, AND NEVER BE DELETED.
--
--    A trigger on auth.users. It fires for every row and returns immediately
--    for every row but one, so the cost on the auth path is a uuid comparison.
--    GoTrue is not touched: the tombstone is not in auth.identities, has no
--    password and is banned, so nothing in GoTrue's own flows ever reaches an
--    UPDATE of it -- this refuses the DBA, the migration and the repair script
--    that would undo any of that.
-- ---------------------------------------------------------------------------

create or replace function private.tombstone_is_not_a_login()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if old.id is distinct from private.erased_user_id() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'the erased-user tombstone cannot be deleted: every pseudonymised audit row hangs from it'
      using errcode = '42501', hint = 'tombstone_is_permanent';
  end if;

  if new.encrypted_password is not null
     or new.email_confirmed_at is not null
     or new.phone_confirmed_at is not null
     or new.banned_until is distinct from old.banned_until
     or new.email is distinct from old.email
     or new.is_sso_user is distinct from old.is_sso_user
     or new.is_anonymous is distinct from old.is_anonymous then
    raise exception 'the erased-user tombstone is not a login and cannot be made into one'
      using errcode = '42501', hint = 'tombstone_is_not_a_login';
  end if;

  return new;
end;
$$;

comment on function private.tombstone_is_not_a_login() is
  'BEFORE UPDATE OR DELETE on auth.users, a no-op for every row but the Q130 tombstone. For that one it refuses the DELETE outright (42501, hint tombstone_is_permanent -- the anchor every pseudonymised row hangs from) and refuses any UPDATE that would give it a password, a confirmed address, a different address, a lifted ban or an SSO/anonymous identity (42501, hint tombstone_is_not_a_login). It is the enforcement behind "can never sign in", which would otherwise be a property of one migration''s INSERT and nothing else.';

create trigger users_tombstone_is_not_a_login
  before update or delete on auth.users
  for each row execute function private.tombstone_is_not_a_login();
