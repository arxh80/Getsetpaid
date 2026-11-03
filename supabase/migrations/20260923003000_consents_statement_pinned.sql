-- ===========================================================================
-- Phase 8 Task 2, fix round 1 (review finding M1):
-- the wording a consent records is pinned in the database, not only in TypeScript.
-- ===========================================================================
-- consents_technical_context_bounded (20260923000000) holds
-- technical_context.statement to a token SHAPE. It said nothing about which
-- tokens exist: the review stored `totally-made-up-wording` through
-- record_consent(), and a null p_statement recorded a GRANT with no wording at
-- all. The SHA-256 pin binding a token to its sentence lived only in
-- tests/unit/consent/catalogue.test.ts, so a caller using PostgREST could put
-- any wording id on their own evidence.
--
-- THE FIX:
--   * private.consent_statements() -- the closed list of wording identifiers
--     currently shown, per purpose. Mirrored by lib/consent/catalogue.ts
--     (statementId) and asserted equal by tests/unit/consent/catalogue.test.ts,
--     which also requires every listed id to carry a SHA-256 pin there.
--   * private.consents_before_insert() now REFUSES a grant whose context names
--     no statement (22023 missing_statement) or names one the catalogue does
--     not list for that purpose (22023 unknown_statement). A withdrawal may
--     carry no statement (withdrawing must never be harder than granting), but
--     one it does carry must be listed. The token's SHAPE is still the CHECK's
--     job: a value that is not a well-formed token is left for the CHECK to
--     refuse (23514), so the two layers do not mask each other.
--   * Both refusals come after the redundancy and version refusals and BEFORE
--     the meter, so an unworded click spends nothing.
--
-- Retiring wording: when the sentence changes, the NEW id is added here (and
-- in the catalogue with its hash) and the old id is REMOVED -- nobody can be
-- shown the old words any more, so nobody can newly agree to them. Rows
-- already recorded against the old id are untouched (the table is
-- append-only), and the unit test keeps the old id's hash forever.
--
-- Existing rows are not re-validated: the trigger runs on INSERT only.
--
-- REBUILT FROM ITS LATEST DEFINITION (20260923000000 § 5; no later migration
-- replaced it). Every other line is unchanged.
-- ===========================================================================

create or replace function private.consent_statements()
returns table (purpose text, statement_id text)
language sql
immutable
set search_path = ''
as $$
  values ('marketing_email'::text, 'marketing-email-1'::text);
$$;

comment on function private.consent_statements() is
  'THE closed list of consent wording identifiers currently shown, per purpose (20260923003000). A grant must name one of these for its purpose (private.consents_before_insert, 22023 missing_statement / unknown_statement). Mirrored by lib/consent/catalogue.ts statementId, asserted equal (and each id pinned to its exact sentence by SHA-256) by tests/unit/consent/catalogue.test.ts. Retired wording is removed from here, never from the pin.';

revoke all on function private.consent_statements() from public, anon, authenticated, service_role;

create or replace function private.consents_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
  new.user_id := v_uid;

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
$$;

comment on function private.consents_before_insert() is
  'BEFORE INSERT on public.consents, for EVERY writer: refuses a sessionless write (42501); stamps user_id from auth.uid(); derives category and policy_slug from private.consent_purposes() (22023 unknown_purpose); serialises per (user, purpose); refuses a redundant event (22023 already_granted / not_granted); requires a GRANT''s policy_version to equal the currently published version (22023 stale_policy_version); requires a GRANT to name wording listed in private.consent_statements() for its purpose, and a withdrawal that names wording to name listed wording (22023 missing_statement / unknown_statement; 20260923003000); meters GRANTS at 10/hour/user (PT429, remaining seconds in HINT, crossing alert at the last accepted grant); stamps granted_at / withdrawn_at from the database clock, and for a WITHDRAWAL stamps the in-force version and the grant it ends. Withdrawals are never metered.';

revoke all on function private.consents_before_insert() from public, anon, authenticated, service_role;

comment on function public.record_consent(text, text, integer, text) is
  'The ONLY session write path into public.consents: records a grant or a withdrawal for the CALLER (there is no user argument -- private.consents_before_insert() stamps it from the session). p_policy_version is the version of the governing legal document the caller was shown (required for a grant, ignored for a withdrawal); p_statement is the identifier of the wording shown beside the control (required for a grant and checked against private.consent_statements(); optional for a withdrawal, and checked if given). Mechanism is always account_settings. Errors: 42501 no session; 22023 with hint unknown_purpose / already_granted / not_granted / stale_policy_version / missing_statement / unknown_statement; 23514 a statement that is not a token; PT429 (grants only) with the remaining seconds in hint.';
