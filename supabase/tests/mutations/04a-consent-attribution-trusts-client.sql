-- PHASE 8 TASK 8 MUTANT 04a-consent-attribution-trusts-client
-- guard:  private.consents_before_insert
-- change: attribution trusts a caller-supplied user_id instead of overwriting it
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.consents_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid       uuid := (select auth.uid());
  v_category  text;
  v_slug      text;
  v_current   integer;
  v_last_id   uuid;
  v_last      text;
  v_policy    public.rate_limit_policies%rowtype;
  v_window    timestamptz;
  v_count     integer;
  v_after     integer;
  v_retry     integer;
  v_statement text;
begin
  -- (1) WHO. A consent is the data subject's own act: no session, no record.
  -- Deliberately NOT the "sessionless writer is a fixture, let it through"
  -- shape feedback uses -- a fixture that could write a consent could write
  -- one for anybody.
  if v_uid is null then
    raise exception 'consents: a consent can only be recorded from the data subject''s own session'
      using errcode = '42501';
  end if;
  new.user_id := coalesce(new.user_id, v_uid);

  -- (2) WHAT FOR. The catalogue decides the category and the governing text.
  select c.category, c.policy_slug into v_category, v_slug
    from private.consent_purposes() c
   where c.purpose = new.purpose;
  if not found then
    raise exception 'consents: % is not a purpose GetSetPaid asks consent for', new.purpose
      using errcode = '22023', hint = 'unknown_purpose';
  end if;
  new.category    := v_category;
  new.policy_slug := v_slug;

  -- The wording token, when the context carries one as a string. A context
  -- of any other shape is left for consents_technical_context_bounded.
  if pg_catalog.jsonb_typeof(new.technical_context) = 'object'
     and pg_catalog.jsonb_typeof(new.technical_context -> 'statement') = 'string' then
    v_statement := new.technical_context ->> 'statement';
  end if;

  if new.action is null or new.action not in ('granted', 'withdrawn') then
    raise exception 'consents: action must be granted or withdrawn'
      using errcode = '22023', hint = 'unknown_action';
  end if;

  -- (3) ONE EVENT AT A TIME per (user, purpose), so the state read below
  -- cannot be raced.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('consents:' || v_uid::text || ':' || new.purpose, 0));

  select c.id, c.action into v_last_id, v_last
    from public.consents c
   where c.user_id = v_uid and c.purpose = new.purpose
   order by c.seq desc
   limit 1;

  select d.version into v_current
    from public.legal_documents d
   where d.slug = v_slug and d.status = 'published';
  if not found then
    raise exception 'consents: % has no published version to record against', v_slug
      using errcode = '55000';
  end if;

  if new.action = 'granted' then
    if v_last is not distinct from 'granted' then
      raise exception 'consents: % is already granted', new.purpose
        using errcode = '22023', hint = 'already_granted';
    end if;
    -- The version the person was shown must be the one being served.
    if new.policy_version is distinct from v_current then
      raise exception 'consents: the % page is at version %, not %', v_slug, v_current, new.policy_version
        using errcode = '22023', hint = 'stale_policy_version';
    end if;

    -- (3b) THE WORDING. A grant is evidence of agreement to specific words,
    -- so it must name a statement the catalogue knows for this purpose
    -- (20260923003000, review finding M1). The CHECK constraint still owns
    -- the token's SHAPE; this owns its MEMBERSHIP.
    if v_statement is null then
      raise exception 'consents: a grant must name the wording that was shown'
        using errcode = '22023', hint = 'missing_statement';
    end if;
    if v_statement ~ '^[a-z0-9][a-z0-9-]{0,63}$'
       and not exists (select 1 from private.consent_statements() s
                        where s.purpose = new.purpose and s.statement_id = v_statement) then
      raise exception 'consents: % is not wording GetSetPaid shows for %', v_statement, new.purpose
        using errcode = '22023', hint = 'unknown_statement';
    end if;

    -- (4) THE METER -- grants only; after every refusal above, so a
    -- redundant, stale or unworded click spends nothing.
    select * into v_policy from public.rate_limit_policies p where p.category = 'consent_grant';
    if not found then
      raise exception 'consents: no rate-limit policy for consent_grant' using errcode = '22023';
    end if;

    v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
    v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                  (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                    - pg_catalog.now())))::integer);

    select c.request_count into v_count
      from public.rate_limit_counters c
     where c.category      = 'consent_grant'
       and c.subject_scope = 'user'
       and c.subject_id    = v_uid
       and c.window_start  = v_window;
    v_count := coalesce(v_count, 0);

    if v_count >= v_policy.max_requests then
      raise exception 'consents: too many consent changes (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;

    select r.request_count into v_after
      from private.record_rate_limit_event('consent_grant', 'user', v_uid, null) r;

    if v_after > v_policy.max_requests then
      raise exception 'consents: too many consent changes (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;

    if v_after = v_policy.max_requests then
      insert into public.incident_alerts (alert_type, organisation_id, summary, details)
      values (
        'rate_limit_tripped',
        null,
        pg_catalog.format(
          'Rate limit reached: consent_grant (limit %s per %s seconds).',
          v_policy.max_requests, v_policy.window_seconds),
        pg_catalog.jsonb_build_object(
          'category',        'consent_grant',
          'subject_scope',   'user',
          'subject_id',      v_uid,
          'window_start',    v_window,
          'max_requests',    v_policy.max_requests,
          'window_seconds',  v_policy.window_seconds,
          'counts_refusals', false
        )
      );
    end if;

    new.granted_at   := pg_catalog.now();
    new.withdrawn_at := null;
    new.withdraws_id := null;
  else
    if v_last is distinct from 'granted' then
      raise exception 'consents: % is not currently granted', new.purpose
        using errcode = '22023', hint = 'not_granted';
    end if;
    -- A withdrawal needs no wording (withdrawing must never be harder than
    -- granting), but if it names one, it must be a real one.
    if v_statement is not null
       and v_statement ~ '^[a-z0-9][a-z0-9-]{0,63}$'
       and not exists (select 1 from private.consent_statements() s
                        where s.purpose = new.purpose and s.statement_id = v_statement) then
      raise exception 'consents: % is not wording GetSetPaid shows for %', v_statement, new.purpose
        using errcode = '22023', hint = 'unknown_statement';
    end if;
    -- The notice in force at the time; never the caller's value, and never a
    -- reason to refuse a withdrawal.
    new.policy_version := v_current;
    new.withdraws_id   := v_last_id;
    new.withdrawn_at   := pg_catalog.now();
    new.granted_at     := null;
  end if;

  return new;
end;
$function$;
