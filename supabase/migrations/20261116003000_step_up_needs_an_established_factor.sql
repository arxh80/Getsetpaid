-- ===========================================================================
-- STEP-UP NEEDS AN ESTABLISHED FACTOR (audit 2026-11-16)
-- ===========================================================================
-- lib/auth/step-up.ts accepts any MFA event in the last five minutes as a
-- fresh credential. Enrolling a NEW factor and verifying it produces exactly
-- that event, so a stolen signed-in session could enrol its own factor and
-- pass step-up for every gated purpose (exports, erasure, closure, invoice and
-- Stripe settings, superuser functions) without the password or the real
-- factor.
--
-- Measured on GoTrue v2.196 (local stack, 2026-11-16): auth.sessions.factor_id
-- names the factor that last verified the session; verifying a second factor
-- restamps the session's totp amr entry; unenrolling that factor deletes the
-- amr row, nulls factor_id and drops the session to aal1, while the JWT
-- already issued keeps the fresh entry until it expires. So the JWT alone
-- cannot decide this, and the mint -- the one place every gated purpose
-- passes -- now does: when the newest amr entry is not a password, the
-- session's factor must exist, be verified and predate the session.
--
-- Effect on an honest user: after enrolling a factor, step-up by that factor
-- is refused for the rest of that session; a password re-auth (a new session)
-- or the next sign-in clears it.
--
-- Body is 20261108001000's plus that one check. Grants unchanged.
-- ===========================================================================

create or replace function public.mint_step_up_token(p_purpose text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_method text;
begin
  -- THE SERVER, AND ONLY THE SERVER (coordinator decision 2). Without this,
  -- a browser holding the session mints and then calls, and the token proves
  -- nothing. The flag is api_hooks.pre_request()'s, per request.
  if not private.request_is_from_server() then
    raise exception 'mint_step_up_token: only the app''s server can record a step-up'
      using errcode = '42501', hint = 'step_up_mint_needs_the_server';
  end if;
  if v_uid is null then
    raise exception 'mint_step_up_token: sign in first'
      using errcode = '42501', hint = 'step_up_mint_needs_a_session';
  end if;

  -- Audit 2026-11-16: a factor enrolled DURING this session is not step-up.
  -- A stolen session could enrol a new factor, verify it, and present that as
  -- a fresh credential. When the newest amr entry is not a password, the
  -- session's verifying factor (auth.sessions.factor_id) must predate the
  -- session. Unenrolling it clears factor_id, so that trick is refused too.
  -- No timestamped amr in the claims: nothing to judge here; the app's own
  -- check (lib/auth/step-up.ts) has already refused that case.
  select e->>'method' into v_method
    from pg_catalog.jsonb_array_elements(
           case when pg_catalog.jsonb_typeof((select auth.jwt())->'amr') = 'array'
                then (select auth.jwt())->'amr' else '[]'::jsonb end) e
   where pg_catalog.jsonb_typeof(e) = 'object'
     and pg_catalog.jsonb_typeof(e->'timestamp') = 'number'
   order by (e->>'timestamp')::numeric desc, (e->>'method' = 'password')
   limit 1;
  if v_method is not null and v_method <> 'password' and not exists (
       select 1
         from auth.sessions s
         join auth.mfa_factors f on f.id = s.factor_id
        where s.id::text = (select auth.jwt())->>'session_id'
          and s.user_id = v_uid
          and f.status = 'verified'
          and f.created_at < s.created_at) then
    raise exception 'mint_step_up_token: a factor enrolled in this session is not step-up'
      using errcode = '42501', hint = 'step_up_needs_an_established_factor';
  end if;

  -- Housekeeping: the table holds five minutes of rows, never more.
  delete from private.step_up_tokens t where t.expires_at <= pg_catalog.now();

  -- An unknown purpose is refused by the table's purpose CHECK (23514). The
  -- constraint is not named here: a unit test finds the live list by its name.
  insert into private.step_up_tokens (user_id, purpose, created_at, expires_at)
  values (v_uid, p_purpose, pg_catalog.now(), pg_catalog.now() + interval '5 minutes');
end;
$$;

comment on function public.mint_step_up_token(text) is
  'Phase 10 Task 6 (G13): records that the app''s server saw a fresh step-up for the caller, for one purpose. Refuses 42501 step_up_mint_needs_the_server unless the request carries the server mark (private.request_is_from_server()). Called by lib/auth/step-up-gate.ts mintStepUpToken() right after checkStepUp() passes. Since 20261116003000 it also refuses 42501 step_up_needs_an_established_factor when the newest amr entry is not a password and the session''s verifying factor (auth.sessions.factor_id) is missing, unverified or was enrolled during the session.';
