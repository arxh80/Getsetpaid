-- ===========================================================================
-- PHASE 10 TASK 6 -- STEP-UP, ENFORCED IN THE DATABASE (G13, High; Task 2 F4)
--
-- Covers 20261108001000_step_up_tokens.sql:
--   public.mint_step_up_token(p_purpose)   the server-marked mint
--   private.consume_step_up(p_purpose)     the single-use, five-minute check
--   every gated RPC, and the export_jobs / erasure_jobs inserts
--
-- THE CLAIM: a step-up-gated write needs a token that only the app's server
-- can mint (Task 5's request mark), for THIS user, for THIS purpose, minted in
-- the last five minutes and never used. A browser holding the session can
-- neither call the write without one nor mint one.
--
-- SECTIONS:
--   SM  the mint: the server mark, a session, the purpose list, the grants
--   SP  per purpose, the token's rules: no token, reuse, expiry, another
--       purpose, another user, and minting without the mark
--   SG  per gated entry point, with arguments that otherwise SUCCEED: no
--       token, another user's, an expired one, a consumed one, another
--       purpose's -- each refused 42501 step_up_required -- and a fresh token
--       succeeds and is spent
--   SC  controls: what is NOT gated still works without a token
--   SN  non-vacuity: the purpose list, the functions that consume, and that
--       every one of them is a target in § SG
--
-- SELF-CONTAINED. Its own users and workspaces; every scenario in SP/SG/SC is
-- rolled back (qp's sentinel pattern), so the persistent state is only the
-- fixtures. Uses step_up_fixture.mint() (the runner installs it) for every
-- real mint, which is public.mint_step_up_token() under the runner's server
-- mark.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists st cascade;
create schema st;

create table st.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);
create table st.ids (k text primary key, v text);
create table st.targets (fn text primary key, purpose text);

create function st.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into st.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- rls_q228_closure_backup_parts.sql's helpers, with the schema renamed.
create function st.denied(p_state text, p_hint text, p_constraint text)
returns text language sql immutable set search_path = '' as $$
  select 'denied(' || p_state
         || coalesce(':' || case when p_hint like 'Grant the required privileges%' then 'missing_grant'
                                 else coalesce(nullif(p_hint, ''), nullif(p_constraint, '')) end, '')
         || ')';
$$;

create function st.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text; v_con text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    v_actual := st.denied(sqlstate, v_hint, v_con);
  end;
  perform st.record(p_label, p_expected, v_actual);
end $$;

create function st.t(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v text; v_hint text; v_con text;
begin
  begin
    if pg_catalog.lower(pg_catalog.ltrim(p_sql)) like 'select%' then
      execute p_sql into v;
      return coalesce(v, '<null>');
    end if;
    execute p_sql;
    return 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    return st.denied(sqlstate, v_hint, v_con);
  end;
end $$;

create function st.sc_text(p_steps text[])
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_out text := ''; v_s text; v_hint text; v_con text;
begin
  begin
    foreach v_s in array p_steps loop
      v_out := v_out || case when v_out = '' then '' else '|' end || st.t(v_s);
    end loop;
    raise exception using errcode = 'P0001', message = 'st_undo';
  exception when others then
    if sqlerrm = 'st_undo' then return v_out; end if;
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    return v_out || '|' || st.denied(sqlstate, v_hint, v_con);
  end;
end $$;

create function st.sc(p_label text, p_steps text[], p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  perform st.record(p_label, p_expected, st.sc_text(p_steps));
end $$;

-- PLANTS a token the real mint would never write, for the refusals. Always
-- clears the caller's own live tokens for the purpose first, so 'none' means
-- none. Definer: the table has no client privilege at all.
create function st.plant(p_purpose text, p_variant text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  delete from private.step_up_tokens t
   where t.user_id = v_uid and t.purpose = p_purpose and t.consumed_at is null;
  if p_variant = 'other_user' then
    insert into private.step_up_tokens (user_id, purpose, expires_at)
    select i.v::uuid, p_purpose, pg_catalog.now() + interval '5 minutes' from st.ids i where i.k = 'other';
  elsif p_variant = 'expired' then
    insert into private.step_up_tokens (user_id, purpose, created_at, expires_at)
    values (v_uid, p_purpose, pg_catalog.now() - interval '6 minutes', pg_catalog.now() - interval '1 minute');
  elsif p_variant = 'consumed' then
    insert into private.step_up_tokens (user_id, purpose, expires_at, consumed_at)
    values (v_uid, p_purpose, pg_catalog.now() + interval '5 minutes', pg_catalog.now());
  elsif p_variant = 'other_purpose' then
    insert into private.step_up_tokens (user_id, purpose, expires_at)
    values (v_uid,
            case when p_purpose = 'override' then 'impersonation' else 'override' end,
            pg_catalog.now() + interval '5 minutes');
  elsif p_variant <> 'none' then
    raise exception 'st.plant: unknown variant %', p_variant;
  end if;
  return true;
end $$;

-- Ages every token of the caller's for the purpose past its five minutes.
create function st.backdate(p_purpose text)
returns boolean language sql security definer set search_path = '' as $$
  update private.step_up_tokens t
     set created_at = t.created_at - interval '6 minutes', expires_at = t.expires_at - interval '6 minutes'
   where t.user_id = (select auth.uid()) and t.purpose = p_purpose;
  select true;
$$;

-- The caller's newest token for the purpose, and how many are still live.
create function st.token_state(p_purpose text)
returns text language sql security definer set search_path = '' as $$
  select format('newest_consumed=%s,live=%s',
    (select (t.consumed_at is not null)::text from private.step_up_tokens t
      where t.user_id = (select auth.uid()) and t.purpose = p_purpose
      order by t.created_at desc limit 1),
    (select pg_catalog.count(*) from private.step_up_tokens t
      where t.user_id = (select auth.uid()) and t.purpose = p_purpose
        and t.consumed_at is null and t.expires_at > pg_catalog.now()));
$$;

-- Every expired token, anyone's.
create function st.expired()
returns bigint language sql security definer set search_path = '' as $$
  select pg_catalog.count(*) from private.step_up_tokens t where t.expires_at <= pg_catalog.now();
$$;

-- The newest row the mint wrote for the caller, described.
create function st.newest(p_purpose text)
returns text language sql security definer set search_path = '' as $$
  select format('self=%s,life=%s,consumed=%s',
                t.user_id = (select auth.uid()), t.expires_at - t.created_at, t.consumed_at is not null)
    from private.step_up_tokens t
   where t.purpose = p_purpose
   order by t.created_at desc limit 1;
$$;

create function st.as_claims(p_claims text)
returns text language sql immutable set search_path = '' as $$
  select pg_catalog.format($f$select pg_catalog.set_config('request.jwt.claims', %L, true) is not null$f$, p_claims);
$$;

-- What a step outputs when it works: a SELECT step 'true' (every step here is
-- written to say so), anything else 'ok'.
create function st.ok_of(p_steps text[])
returns text language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.string_agg(
           case when pg_catalog.lower(pg_catalog.ltrim(s)) like 'select%' then 'true' else 'ok' end,
           '|' order by n), '')
    from pg_catalog.unnest(p_steps) with ordinality u(s, n);
$$;

-- THE GATE, for one entry point. p_call must SUCCEED once the prelude has run
-- and a fresh token is held; p_ok is what it then outputs ('true' for a
-- `select (...) is not null`, 'ok' for an insert). Records six rows: five
-- refusals and the success.
create function st.gate(p_label text, p_fn text, p_claims text, p_purpose text,
                        p_call text, p_ok text, p_prelude text[] default '{}')
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare
  v_head text[] := array[st.as_claims(p_claims), 'set local role authenticated'] || p_prelude;
  v_pre  text := st.ok_of(v_head);
  v_variant text;
begin
  insert into st.targets (fn, purpose) values (p_fn, p_purpose) on conflict (fn) do nothing;
  foreach v_variant in array array['none', 'other_user', 'expired', 'consumed', 'other_purpose'] loop
    perform st.sc(p_label || ' ' || v_variant || ' -> refused',
      v_head || array[format('select st.plant(%L, %L)', p_purpose, v_variant), p_call],
      v_pre || '|true|denied(42501:step_up_required)');
  end loop;
  perform st.sc(p_label || ' fresh token -> succeeds, and the token is spent',
    v_head || array[format('select step_up_fixture.mint(%L)', p_purpose), p_call,
                    format('select st.token_state(%L)', p_purpose)],
    v_pre || '|true|' || p_ok || '|newest_consumed=true,live=0');
end $$;

grant usage on schema st to authenticated, anon, service_role;
grant execute on all functions in schema st to authenticated, anon, service_role;
grant select, insert on st.ids to authenticated;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres)
--   su       the aal2 platform superuser
--   owner_a  Owner of A (active): lifecycle, overrides, impersonation, export
--   owner_c  Owner of C, which C's fixture CLOSES: the closure decisions
--   owner_d  Owner of D (active): close_my_workspace
--   eraser   no workspace, aal1: their own account erasure
--   subj     no workspace, aal1: files an account-erasure request (DSR)
--            inside each scenario that needs one (the register keeps every row)
--   other    the "another user" whose tokens must not count
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as su      \gset
select gen_random_uuid()::text as owner_a \gset
select gen_random_uuid()::text as owner_c \gset
select gen_random_uuid()::text as owner_d \gset
select gen_random_uuid()::text as eraser  \gset
select gen_random_uuid()::text as subj    \gset
select gen_random_uuid()::text as other   \gset
select gen_random_uuid()::text as org_a   \gset
select gen_random_uuid()::text as org_c   \gset
select gen_random_uuid()::text as org_d   \gset
select 'st-a-' || left(:'org_a', 8) as slug_a \gset
select 'st-c-' || left(:'org_c', 8) as slug_c \gset
select 'st-d-' || left(:'org_d', 8) as slug_d \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'su')      as su_c      \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_a') as owner_a_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_c') as owner_c_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_d') as owner_d_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'eraser')  as eraser_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'subj')    as subj_c    \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'other')   as other_c   \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'su'::uuid,      'st-su-'      || :'su'      || '@test.local'),
               (:'owner_a'::uuid, 'st-owner-a-' || :'owner_a' || '@test.local'),
               (:'owner_c'::uuid, 'st-owner-c-' || :'owner_c' || '@test.local'),
               (:'owner_d'::uuid, 'st-owner-d-' || :'owner_d' || '@test.local'),
               (:'eraser'::uuid,  'st-eraser-'  || :'eraser'  || '@test.local'),
               (:'subj'::uuid,    'st-subj-'    || :'subj'    || '@test.local'),
               (:'other'::uuid,   'st-other-'   || :'other'   || '@test.local')) v(u, e);
insert into public.platform_admins (user_id) values (:'su');
insert into st.ids values ('other', :'other');

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Step-up A', :'slug_a'),
  (:'org_c', 'Step-up C', :'slug_c'),
  (:'org_d', 'Step-up D', :'slug_d');
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, 'starter', 'monthly', 3, 'active', now() + interval '30 days'
  from unnest(array[:'org_a', :'org_c', :'org_d']::uuid[]) o
on conflict (organisation_id) do update set plan_id = 'starter', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'owner_a', 'owner', 'active', now()),
  (:'org_c', :'owner_c', 'owner', 'active', now()),
  (:'org_d', :'owner_d', 'owner', 'active', now());

-- C, closed by its Owner (the closure decisions' precondition).
set role authenticated;
set request.jwt.claims = :'owner_c_c';
select step_up_fixture.mint('workspace_close') \g /dev/null
select public.close_my_workspace(:'org_c', :'slug_c', 'st: closing C') \g /dev/null
reset role;
reset request.jwt.claims;

select st.val('SF1 FIXTURE: C is owner_closed, A and D are active',
  format($$select string_agg(lifecycle_state, ',' order by slug) from public.organisations where id in (%L, %L, %L)$$,
         :'org_a', :'org_c', :'org_d'), 'active,owner_closed,active');
select st.val('SF3 FIXTURE: the runner''s server mark is on in this session',
  $$select private.request_is_from_server()::text$$, 'true');

-- ===========================================================================
-- § SM  THE MINT
-- ===========================================================================
select st.sc('SM1 a minted token is the caller''s, lives five minutes and is unspent',
  array[st.as_claims(:'owner_a_c'), 'set local role authenticated',
        $$select step_up_fixture.mint('override')$$, $$select st.newest('override')$$],
  'true|ok|true|self=t,life=00:05:00,consumed=f');
select st.sc('SM2 no server mark -> refused (a browser cannot mint then call)',
  array[st.as_claims(:'owner_a_c'), 'set local role authenticated',
        $$select pg_catalog.set_config('getsetpaid.from_server', 'off', true) is not null$$,
        $$select step_up_fixture.mint('override')$$],
  'true|ok|true|denied(42501:step_up_mint_needs_the_server)');
select st.sc('SM3 a session with no user -> refused',
  array[st.as_claims('{"role":"authenticated"}'), 'set local role authenticated',
        $$select step_up_fixture.mint('override')$$],
  'true|ok|denied(42501:step_up_mint_needs_a_session)');
select st.sc('SM4 a purpose off the closed list -> refused by its CHECK',
  array[st.as_claims(:'owner_a_c'), 'set local role authenticated',
        $$select step_up_fixture.mint('everything')$$],
  'true|ok|denied(23514:step_up_tokens_purpose_known)');
select st.sc('SM5 a mint deletes every expired token, anyone''s (the table holds minutes of rows)',
  array[st.as_claims(:'other_c'), 'set local role authenticated',
        $$select st.plant('override', 'expired')$$, $$select st.expired()::text$$,
        st.as_claims(:'owner_a_c'),
        $$select step_up_fixture.mint('override')$$, $$select st.expired()::text$$],
  'true|ok|true|1|true|true|0');
select st.val('SM6 grants: authenticated EXECUTEs the mint; anon, service_role and PUBLIC do not',
  $$select format('%s/%s/%s',
     has_function_privilege('authenticated', 'public.mint_step_up_token(text)', 'execute'),
     has_function_privilege('anon', 'public.mint_step_up_token(text)', 'execute'),
     has_function_privilege('service_role', 'public.mint_step_up_token(text)', 'execute'))$$,
  't/f/f');
select st.val('SM7 consume_step_up: authenticated only (the INVOKER RPCs call it); never anon',
  $$select format('%s/%s',
     has_function_privilege('authenticated', 'private.consume_step_up(text)', 'execute'),
     has_function_privilege('anon', 'private.consume_step_up(text)', 'execute'))$$,
  't/f');
select st.val('SM8 no client role holds ANY privilege on private.step_up_tokens',
  $$select count(*)::text from (values ('anon'), ('authenticated'), ('service_role')) r(role)
     where has_table_privilege(r.role, 'private.step_up_tokens', 'select,insert,update,delete,truncate,references,trigger')$$,
  '0');
select st.val('SM9 RLS is on, and both functions are SECURITY DEFINER with search_path ''''',
  $$select format('%s/%s',
     (select relrowsecurity from pg_class where oid = 'private.step_up_tokens'::regclass),
     (select bool_and(prosecdef and proconfig = array['search_path=""'])
        from pg_proc where oid in ('public.mint_step_up_token(text)'::regprocedure,
                                   'private.consume_step_up(text)'::regprocedure)))$$,
  't/t');
select st.sc('SM10 authenticated cannot write a token directly',
  array[st.as_claims(:'owner_a_c'), 'set local role authenticated',
        $$insert into private.step_up_tokens (user_id, purpose, expires_at)
            values (auth.uid(), 'override', now() + interval '5 minutes')$$],
  'true|ok|denied(42501:missing_grant)');

-- ===========================================================================
-- § SP  PER PURPOSE, THE TOKEN'S RULES (consume_step_up called directly)
-- ===========================================================================
-- The DO block below cannot see psql variables; it reads these.
select set_config('st.owner_a_c', :'owner_a_c', false) \g /dev/null
select set_config('st.other_c', :'other_c', false) \g /dev/null
do $do$
declare
  p text;
  v_as text := st.as_claims(current_setting('st.owner_a_c'));
  v_other text := st.as_claims(current_setting('st.other_c'));
  v_consume text;
begin
  for p in
    select unnest(string_to_array(regexp_replace(pg_get_constraintdef(oid), '^.*ARRAY\[(.*)\].*$', '\1'), ', '))
      from pg_constraint where conname = 'step_up_tokens_purpose_known'
  loop
    p := replace(split_part(p, '::', 1), '''', '');
    v_consume := format('select pg_typeof(private.consume_step_up(%L))::text', p);
    perform st.sc(format('SP %s: no server mark -> the mint is refused', p),
      array[v_as, 'set local role authenticated',
            $$select pg_catalog.set_config('getsetpaid.from_server', 'off', true) is not null$$,
            format('select step_up_fixture.mint(%L)', p)],
      'true|ok|true|denied(42501:step_up_mint_needs_the_server)');
    perform st.sc(format('SP %s: no token -> refused', p),
      array[v_as, 'set local role authenticated', format('select st.plant(%L, %L)', p, 'none'), v_consume],
      'true|ok|true|denied(42501:step_up_required)');
    perform st.sc(format('SP %s: a fresh token -> taken once', p),
      array[v_as, 'set local role authenticated', format('select step_up_fixture.mint(%L)', p), v_consume],
      'true|ok|true|void');
    perform st.sc(format('SP %s: the same token again -> refused (single use)', p),
      array[v_as, 'set local role authenticated', format('select step_up_fixture.mint(%L)', p), v_consume, v_consume],
      'true|ok|true|void|denied(42501:step_up_required)');
    perform st.sc(format('SP %s: a token past its five minutes -> refused', p),
      array[v_as, 'set local role authenticated', format('select step_up_fixture.mint(%L)', p),
            format('select st.backdate(%L)', p), v_consume],
      'true|ok|true|true|denied(42501:step_up_required)');
    perform st.sc(format('SP %s: a token for another purpose -> refused', p),
      array[v_as, 'set local role authenticated',
            format('select step_up_fixture.mint(%L)', case when p = 'override' then 'impersonation' else 'override' end),
            v_consume],
      'true|ok|true|denied(42501:step_up_required)');
    perform st.sc(format('SP %s: another user''s token -> refused', p),
      array[v_other, 'set local role authenticated', format('select step_up_fixture.mint(%L)', p),
            v_as, v_consume],
      'true|ok|true|true|denied(42501:step_up_required)');
  end loop;
end
$do$;

-- ===========================================================================
-- § SG  EVERY GATED ENTRY POINT, WITH ARGUMENTS THAT OTHERWISE SUCCEED
--
-- Each gate() row set is five refusals (no token, another user's, expired,
-- consumed, another purpose's), every one 42501 step_up_required -- the hint
-- is part of the expectation, so a refusal from any OTHER guard is red -- and
-- the positive control: with a fresh token the call succeeds and spends it.
-- ===========================================================================

-- organisation_lifecycle (A is active)
select st.gate('SG1 suspend_organisation', 'suspend_organisation', :'su_c', 'organisation_lifecycle',
  format($$select public.suspend_organisation(%L, 'st: suspend') is not null$$, :'slug_a'), 'true');
select st.gate('SG2 delete_organisation', 'delete_organisation', :'su_c', 'organisation_lifecycle',
  format($$select public.delete_organisation(%L, 'st: delete') is not null$$, :'slug_a'), 'true');
select st.gate('SG3 reinstate_organisation', 'reinstate_organisation', :'su_c', 'organisation_lifecycle',
  format($$select public.reinstate_organisation(%L, 'st: reinstate') is not null$$, :'slug_a'), 'true',
  array[$$select step_up_fixture.mint('organisation_lifecycle')$$,
        format($$select public.suspend_organisation(%L, 'st: suspended first') is not null$$, :'slug_a')]);

-- closure_decision (C is owner_closed)
select st.gate('SG4 reassign_closed_workspace', 'reassign_closed_workspace', :'su_c', 'closure_decision',
  format($$select public.reassign_closed_workspace(%L, %L, 'st: reassign') is not null$$, :'slug_c', :'owner_c'), 'true');
select st.gate('SG5 delete_closed_workspace', 'delete_closed_workspace', :'su_c', 'closure_decision',
  format($$select public.delete_closed_workspace(%L, 'st: delete', true) is not null$$, :'slug_c'), 'true');

-- workspace_close (D is active; F4)
select st.gate('SG6 close_my_workspace', 'close_my_workspace', :'owner_d_c', 'workspace_close',
  format($$select public.close_my_workspace(%L, %L, 'st: close') is not null$$, :'org_d', :'slug_d'), 'true');

-- override
select st.gate('SG7 grant_billing_override', 'grant_billing_override', :'su_c', 'override',
  format($$select public.grant_billing_override(%L, 'pro', null, 'st: grant', now() + interval '1 day') is not null$$, :'slug_a'), 'true');
select st.gate('SG8 revoke_billing_override', 'revoke_billing_override', :'su_c', 'override',
  $$select public.revoke_billing_override(current_setting('st.ov')::uuid, 'st: revoke') is not null$$, 'true',
  array[$$select step_up_fixture.mint('override')$$,
        format($$select set_config('st.ov', public.grant_billing_override(%L, 'pro', null, 'st: granted first', now() + interval '1 day')::text, true) is not null$$, :'slug_a')]);
select st.gate('SG9 grant_feature_override', 'grant_feature_override', :'su_c', 'override',
  format($$select public.grant_feature_override(%L, 'early_access_preview', 'st: grant', now() + interval '1 day') is not null$$, :'slug_a'), 'true');
select st.gate('SG10 revoke_feature_override', 'revoke_feature_override', :'su_c', 'override',
  $$select public.revoke_feature_override(current_setting('st.ov')::uuid, 'st: revoke') is not null$$, 'true',
  array[$$select step_up_fixture.mint('override')$$,
        format($$select set_config('st.ov', public.grant_feature_override(%L, 'early_access_preview', 'st: granted first', now() + interval '1 day')::text, true) is not null$$, :'slug_a')]);

-- impersonation
select st.gate('SG11 request_impersonation', 'request_impersonation', :'su_c', 'impersonation',
  format($$select public.request_impersonation(%L, 'st: request') is not null$$, :'slug_a'), 'true');
select st.gate('SG12 start_impersonation_session', 'start_impersonation_session', :'su_c', 'impersonation',
  $$select public.start_impersonation_session(current_setting('st.imp')::uuid) is not null$$, 'true',
  array[$$select step_up_fixture.mint('impersonation')$$,
        format($$select set_config('st.imp', public.request_impersonation(%L, 'st: requested first')::text, true) is not null$$, :'slug_a'),
        st.as_claims(:'owner_a_c'),
        $$select set_config('st.x', public.accept_impersonation_request(current_setting('st.imp')::uuid)::text, true) is not null$$,
        st.as_claims(:'su_c')]);

-- retention_settings
select st.gate('SG13 set_retention_enabled', 'set_retention_enabled', :'su_c', 'retention_settings',
  $$select public.set_retention_enabled(true, true, 'st: unchanged')::text is not null$$, 'true');
select st.gate('SG14 release_audit_purge_ceiling', 'release_audit_purge_ceiling', :'su_c', 'retention_settings',
  $$select public.release_audit_purge_ceiling('st: release')::text is not null$$, 'true');

-- legal_document
select st.gate('SG15 publish_legal_document', 'publish_legal_document', :'su_c', 'legal_document',
  $$select public.publish_legal_document(current_setting('st.doc')::uuid) is not null$$, 'true',
  array[$$select set_config('st.doc', public.create_legal_document_draft('contact')::text, true) is not null$$]);
select st.gate('SG16 record_legal_document_counsel_review', 'record_legal_document_counsel_review', :'su_c', 'legal_document',
  $$select public.record_legal_document_counsel_review(current_setting('st.doc')::uuid, 'st counsel') is not null$$, 'true',
  array[$$select set_config('st.doc', public.create_legal_document_draft('contact')::text, true) is not null$$]);

-- dsr_rejection
select st.gate('SG17 transition_data_subject_request (rejected)', 'transition_data_subject_request', :'su_c', 'dsr_rejection',
  $$select count(*) = 1 from public.transition_data_subject_request(current_setting('st.dsr')::uuid, 'rejected', 'st: no basis under Art 17(3)')$$, 'true',
  array[st.as_claims(:'subj_c'),
        $$select set_config('st.dsr', (select request_id from public.submit_data_subject_request('erasure', 'account', 'st: please erase my account'))::text, true) is not null$$,
        st.as_claims(:'su_c')]);

-- workspace_export: the export_jobs insert (coordinator decision 3)
select st.gate('SG18 export_jobs insert (workspace)', 'export_jobs_before_insert', :'owner_a_c', 'workspace_export',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'org_a'), 'ok');

-- account_erasure: the erasure_jobs insert (F4), the person's own and the
-- operator's on behalf of a request
select st.gate('SG19 erasure_jobs insert (own account)', 'erasure_jobs_before_insert', :'eraser_c', 'account_erasure',
  $$insert into public.erasure_jobs (kind) values ('account')$$, 'ok');
select st.gate('SG20 start_erasure_for_request', 'start_erasure_for_request', :'su_c', 'account_erasure',
  $$select public.start_erasure_for_request(current_setting('st.dsr')::uuid) is not null$$, 'true',
  array[st.as_claims(:'subj_c'),
        $$select set_config('st.dsr', (select request_id from public.submit_data_subject_request('erasure', 'account', 'st: please erase my account'))::text, true) is not null$$,
        st.as_claims(:'su_c')]);

-- ===========================================================================
-- § SC  CONTROLS: WHAT IS NOT GATED STILL WORKS WITHOUT A TOKEN
-- ===========================================================================
select st.sc('SC1 an ACCOUNT export needs no token',
  array[st.as_claims(:'owner_a_c'), 'set local role authenticated',
        $$select st.plant('workspace_export', 'none')$$,
        $$insert into public.export_jobs (kind) values ('account')$$],
  'true|ok|true|ok');
select st.sc('SC2 a DSR move other than a rejection needs no token',
  array[st.as_claims(:'subj_c'), 'set local role authenticated',
        $$select set_config('st.dsr', (select request_id from public.submit_data_subject_request('erasure', 'account', 'st: please erase my account'))::text, true) is not null$$,
        st.as_claims(:'su_c'),
        $$select st.plant('dsr_rejection', 'none')$$,
        $$select count(*) = 1 from public.transition_data_subject_request(current_setting('st.dsr')::uuid, 'in_progress')$$],
  'true|ok|true|true|true|true');
select st.sc('SC3 the closure backup inside close_my_workspace needs no workspace_export token',
  array[st.as_claims(:'owner_d_c'), 'set local role authenticated',
        $$select st.plant('workspace_export', 'none')$$,
        $$select step_up_fixture.mint('workspace_close')$$,
        format($$select public.close_my_workspace(%L, %L, 'st: close') is not null$$, :'org_d', :'slug_d'),
        format($$select count(*)::text from public.export_jobs where organisation_id = %L and closure_backup$$, :'org_d')],
  'true|ok|true|true|true|1');

-- ===========================================================================
-- § SN  NON-VACUITY
-- ===========================================================================
select st.val('SN1 the closed purpose list',
  $$select string_agg(p, ',' order by p) from (
      select replace(split_part(unnest(string_to_array(
               regexp_replace(pg_get_constraintdef(oid), '^.*ARRAY\[(.*)\].*$', '\1'), ', ')), '::', 1), '''', '') p
        from pg_constraint where conname = 'step_up_tokens_purpose_known') s$$,
  'account_erasure,closure_decision,dsr_rejection,impersonation,legal_document,organisation_lifecycle,override,retention_settings,workspace_close,workspace_export');
select st.val('SN2 every purpose on the list is consumed by some function body, and none off it',
  $$select string_agg(distinct m[1], ',' order by m[1])
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(p.prosrc, $r$consume_step_up\('([a-z_]+)'\)$r$, 'g') m
     where n.nspname in ('public', 'private')$$,
  'account_erasure,closure_decision,dsr_rejection,impersonation,legal_document,organisation_lifecycle,override,retention_settings,workspace_close,workspace_export');
select st.val('SN3 the functions that consume a token',
  $$select string_agg(p.proname, ',' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and strpos(p.prosrc, 'consume_step_up(''') > 0$$,
  'close_my_workspace,delete_closed_workspace,delete_organisation,erasure_jobs_before_insert,export_jobs_before_insert,grant_billing_override,grant_feature_override,publish_legal_document,reassign_closed_workspace,record_legal_document_counsel_review,reinstate_organisation,release_audit_purge_ceiling,request_impersonation,revoke_billing_override,revoke_feature_override,set_retention_enabled,start_impersonation_session,suspend_organisation,transition_data_subject_request');
select st.val('SN4 every function that consumes a token is a target in § SG (none untested)',
  $$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and strpos(p.prosrc, 'consume_step_up(''') > 0
       and p.proname not in (select fn from st.targets)$$, '0');
select st.val('SN5 § SG covered 20 entry points',
  $$select count(*)::text from st.targets$$, '20');

-- ===========================================================================
-- TEARDOWN (rls_q228_closure_backup_parts.sql § QZ's shape: `replica` turns
-- off the FK cascades and the append-only guards for the fixture rows only).
-- ===========================================================================
\o /dev/null
set session_replication_role = replica;
delete from public.export_jobs where organisation_id in (:'org_a', :'org_c', :'org_d')
   or requested_by in (:'owner_a', :'owner_c', :'owner_d', :'eraser', :'subj', :'su', :'other');
delete from public.erasure_jobs where subject_user_id in (:'eraser', :'subj') or requested_by in (:'su', :'eraser', :'subj');
delete from public.audit_events where organisation_id in (:'org_a', :'org_c', :'org_d')
   or actor_user_id in (:'su', :'owner_a', :'owner_c', :'owner_d', :'eraser', :'subj', :'other');
delete from public.organisation_memberships where organisation_id in (:'org_a', :'org_c', :'org_d');
delete from public.organisation_subscriptions where organisation_id in (:'org_a', :'org_c', :'org_d');
delete from public.organisations where id in (:'org_a', :'org_c', :'org_d');
set session_replication_role = origin;
delete from public.platform_admins where user_id = :'su';
delete from auth.users where id in (:'su', :'owner_a', :'owner_c', :'owner_d', :'eraser', :'subj', :'other');
\o
select st.val('SZ1 no fixture organisation, user or token is left',
  format($$select (select count(*) from public.organisations where id in (%L, %L, %L))::text || '/' ||
                  (select count(*) from auth.users where email like 'st-%%@test.local')::text || '/' ||
                  (select count(*) from private.step_up_tokens)::text$$, :'org_a', :'org_c', :'org_d'),
  '0/0/0');

select label, expected, actual from st.results where not pass order by seq;
