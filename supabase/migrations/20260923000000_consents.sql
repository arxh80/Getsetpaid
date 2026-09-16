-- ===========================================================================
-- PHASE 8 TASK 2 -- THE CONSENT LEDGER.
--
-- PRD §12 (read-prd.py l.358-364): consent records store "timestamp, policy
-- version, mechanism and relevant technical context", behind "account-level
-- privacy controls". CLAUDE.md § Legal and regulatory compliance: consent is
-- used ONLY where the law requires it (marketing communications,
-- non-essential cookies), is never bundled with core-service processing
-- (that is contract, Art 6(1)(b)), and is as easy to withdraw as to give.
--
-- ===========================================================================
-- THE SHAPE: ONE ROW PER EVENT, AND NO ROW IS EVER CHANGED
-- ===========================================================================
-- Two designs were on the table: a grant row later STAMPED with withdrawn_at,
-- or a new row for every grant and every withdrawal. This is the second, for
-- three reasons:
--
--   * APPEND-ONLY BECOMES STRUCTURAL. With no stamp to make, the table needs
--     no UPDATE path at all -- no client grant, and a guard that refuses every
--     UPDATE for every role, `postgres` included. "The history of what was
--     agreed, when, to which version, must never be rewritten" is then a
--     property of the table rather than of a careful trigger that permits
--     exactly one column to move once.
--   * A WITHDRAWAL IS EVIDENCE TOO. It has its own time, its own mechanism,
--     its own wording and the notice that was in force when it happened. A
--     stamp on the grant row has nowhere to put any of that.
--   * RE-GRANTING IS ORDINARY. grant -> withdraw -> grant is three rows, and
--     "what was the state on 3 March" is a read of the ledger up to that
--     instant, with nothing overwritten on the way.
--
-- Each row therefore carries EXACTLY ONE of granted_at / withdrawn_at (CHECK),
-- matching `action`. A withdrawal names the grant it ends (`withdraws_id`),
-- stamped by the database. The current state of (user, purpose) is the newest
-- row by `seq` (an identity column: two events inside one transaction share
-- now(), so time alone cannot order them).
--
-- ===========================================================================
-- WHAT A ROW HOLDS, AND WHAT IT DELIBERATELY DOES NOT (data minimisation)
-- ===========================================================================
-- A consent record is itself personal data. It holds:
--   user_id            who -- from the session, never from the request
--   category, purpose  what for (the purpose catalogue below decides the
--                      category; nothing else can)
--   action             granted / withdrawn
--   policy_slug +      WHICH TEXT, as a real composite foreign key to
--   policy_version     public.legal_documents (slug, version). A published
--                      version is immutable for every role
--                      (private.legal_documents_guard) and a non-draft cannot
--                      be deleted, so "what did they agree to" is answerable
--                      exactly, forever -- and a superseded version is still
--                      the one they agreed to.
--   mechanism          how: 'account_settings' is the only value today
--   technical_context  a bounded jsonb holding at most ONE key, `statement`:
--                      the identifier of the exact wording shown beside the
--                      control (lib/consent/catalogue.ts pins each identifier
--                      to its text by hash, so the words cannot change under
--                      an old identifier). A token matching
--                      ^[a-z0-9][a-z0-9-]{0,63}$ -- no free text can be put
--                      here, by construction.
--   granted_at /       when, from the database clock
--   withdrawn_at
--
-- NO IP ADDRESS, NO USER AGENT. This is a signed-in, account-level control:
-- the authenticated session already identifies the data subject, and the
-- server clock says when. An IP address or a browser string would add
-- tracking data about the person with no evidential value this record lacks
-- -- ICO guidance asks for who, when, how and what they were told, all of
-- which are above. If counsel wants them, that is a decision with a stated
-- retention period, not a default (DECISIONS-QUEUE, Task 2's entries).
--
-- ===========================================================================
-- ATTRIBUTION IS NON-FORGEABLE BY CONSTRUCTION
-- ===========================================================================
-- Phase 7's lesson (Task 5 I1, Task 6 I1): attribution is enforced where
-- every writer passes, not validated in a server action. Here:
--   * No client role holds INSERT, UPDATE or DELETE on the table -- not anon,
--     not authenticated, not service_role. The one write path a session has
--     is public.record_consent(), which takes NO user argument.
--   * private.consents_before_insert() is a BEFORE INSERT trigger, so it runs
--     for every writer -- that RPC, `postgres`, any future definer function --
--     and it OVERWRITES user_id with auth.uid(), and refuses outright when
--     there is no session: a consent is the data subject's own act, so a
--     sessionless write (a fixture, a seed, a well-meaning backfill) cannot
--     record one on anybody's behalf. It also overwrites category, the policy
--     reference on a withdrawal, the timestamps and withdraws_id.
--   * The one value the caller DOES choose for a grant -- the policy version
--     they were shown -- must equal the CURRENT published version of the
--     purpose's document, or the grant is refused (22023, hint
--     'stale_policy_version'). So nobody can be recorded as agreeing to a
--     version other than the one the page is serving: not a superseded one,
--     not a draft, not a made-up number. (A stale screen gets told to reload;
--     silently stamping a version the person never saw would be the
--     forgery this prevents.) A withdrawal never fails that way: it records
--     the notice in force and cannot be blocked by a stale page.
--
-- WHAT IS STILL POSSIBLE, stated: `postgres`, or anyone who can set
-- request.jwt.claims in a direct database session, can impersonate a session.
-- That is a superuser capability, not a client one, and the audit row it
-- would produce names the same forged actor -- the property is "no CLIENT
-- can record a consent for somebody else", which is what the psql suite
-- measures.
--
-- ===========================================================================
-- ONLY WHAT THE CATALOGUE KNOWS
-- ===========================================================================
-- private.consent_purposes() is the closed list of things this product asks
-- consent for. Today it is ONE row: marketing_email -> marketing, governed by
-- the Marketing and Communications Preferences page. `analytics` is a valid
-- category with no purpose (no analytics vendor is chosen, Q129), and
-- `necessary` is a valid category that can NEVER have a purpose: strictly
-- necessary storage is exempt from consent under PECR, and asking for it
-- would be exactly the "consent to things that are not consent-based" CLAUDE.md
-- forbids. The column CHECK names all three so the schema says what the
-- categories are; the catalogue is what makes the last two unwritable.
--
-- A grant when already granted, or a withdrawal when not granted, is refused
-- (22023, hints 'already_granted' / 'not_granted') and serialised per
-- (user, purpose) by a transaction-scoped advisory lock, so two racing
-- requests cannot both pass. That keeps the ledger meaningful AND bounds it:
-- withdrawals can never outnumber grants.
--
-- ===========================================================================
-- THE METER, AND WHY IT BINDS GRANTS ONLY
-- ===========================================================================
-- A new rate_limit_policies category, `consent_grant`: 10 per hour per user
-- -- the same tier SECURITY.md § 5 gives other user write actions (feedback).
-- Metered in the BEFORE INSERT trigger, the chokepoint, with feedback's exact
-- shape (read-before-write, PT429 with the remaining seconds in HINT, the
-- crossing alert filed by the last accepted grant, no counting past the
-- limit -- Q115).
--
-- WITHDRAWALS ARE NEVER METERED, deliberately: "as easy to withdraw as to
-- give" rules out a state where a person may not withdraw because they have
-- clicked too often. It costs nothing, because the alternation rule above
-- means a withdrawal can only follow a grant: the ledger grows by at most
-- 2 x 10 rows an hour per user per purpose, whatever the caller does.
--
-- ===========================================================================
-- READS
-- ===========================================================================
--   consents_select_own       a user reads their own rows (the settings page)
--   consents_select_platform  the platform superuser at aal2 reads every row,
--                             for oversight (complaints, DSR handling). Q103:
--                             a column on a readable row is readable, so every
--                             column was reviewed for that audience -- all of
--                             them are identifiers, enums, a version number,
--                             timestamps and the statement token. No content.
--   public.consent_is_granted(user, purpose)
--                             the check a future marketing sender MUST call
--                             (lib/consent/marketing.ts). Granted to
--                             service_role ALONE -- a sender has no session --
--                             so no user can probe anybody else's consent.
--
-- ===========================================================================
-- DELETION AND ERASURE
-- ===========================================================================
-- The rows are append-only for every role, `postgres` included (guard below),
-- with ONE exception: `user_id` is ON DELETE CASCADE, so deleting the auth
-- account removes the ledger with it. The guard lets that cascade through by
-- its trigger depth (a cascaded delete runs inside the foreign key's own
-- trigger, depth >= 2; a DELETE statement, from any role or any function,
-- runs the guard at depth 1 and is refused). Whether an erased account's
-- consent history should instead be kept (anonymised) as evidence is Task 5's
-- decision and is queued, not decided here. TRUNCATE is refused outright.
--
-- Every grant and withdrawal writes one audit row (consent.granted /
-- consent.withdrawn) carrying identifiers and enums only.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE PURPOSE CATALOGUE
-- ---------------------------------------------------------------------------

create or replace function private.consent_purposes()
returns table (purpose text, category text, policy_slug text)
language sql
immutable
set search_path = ''
as $$
  values ('marketing_email'::text, 'marketing'::text, 'marketing-preferences'::text);
$$;

comment on function private.consent_purposes() is
  'THE closed list of things GetSetPaid asks consent for (Phase 8 Task 2): purpose -> category -> the legal document whose published version a consent records. One row today, marketing_email. No `analytics` purpose exists (no vendor, Q129) and no `necessary` purpose may ever exist (strictly necessary storage is PECR-exempt; asking for it would bundle consent with the service). Mirrored by lib/consent/catalogue.ts, and asserted equal by tests/unit/consent/catalogue.test.ts.';

revoke all on function private.consent_purposes() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE TABLE
-- ---------------------------------------------------------------------------

create table public.consents (
  id                 uuid primary key default gen_random_uuid(),
  seq                bigint generated always as identity,
  user_id            uuid not null references auth.users (id) on delete cascade,
  category           text not null,
  purpose            text not null,
  action             text not null,
  policy_slug        text not null,
  policy_version     integer not null,
  mechanism          text not null,
  technical_context  jsonb not null default '{}'::jsonb,
  granted_at         timestamptz,
  withdrawn_at       timestamptz,
  withdraws_id       uuid references public.consents (id) on delete cascade,

  constraint consents_seq_unique unique (seq),
  constraint consents_policy_version_fkey
    foreign key (policy_slug, policy_version)
    references public.legal_documents (slug, version) on delete restrict,

  constraint consents_category_known
    check (category in ('necessary', 'analytics', 'marketing')),
  constraint consents_purpose_shape
    check (purpose ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint consents_action_known
    check (action in ('granted', 'withdrawn')),
  constraint consents_mechanism_known
    check (mechanism in ('account_settings')),
  -- Exactly one timestamp, and it is the one the action names.
  constraint consents_granted_at_iff_granted
    check ((action = 'granted') = (granted_at is not null)),
  constraint consents_withdrawn_at_iff_withdrawn
    check ((action = 'withdrawn') = (withdrawn_at is not null)),
  -- A withdrawal names the grant it ends; a grant names nothing.
  constraint consents_withdraws_iff_withdrawn
    check ((action = 'withdrawn') = (withdraws_id is not null)),
  -- The technical context: an object with at most the one documented key,
  -- whose value is a short token. Nothing else fits.
  constraint consents_technical_context_bounded check (
        jsonb_typeof(technical_context) = 'object'
    and (technical_context - 'statement') = '{}'::jsonb
    and (not (technical_context ? 'statement')
         or (jsonb_typeof(technical_context -> 'statement') = 'string'
             and (technical_context ->> 'statement') ~ '^[a-z0-9][a-z0-9-]{0,63}$')))
);

comment on table public.consents is
  'The consent ledger (Phase 8 Task 2; PRD §12). ONE ROW PER EVENT -- a grant or a withdrawal -- and no row is ever updated, by any role (private.consents_guard). Attribution is stamped from the session by private.consents_before_insert() for every writer; no client role holds a write privilege, and the one session write path is public.record_consent(), which takes no user argument. policy_slug + policy_version is a real foreign key to the immutable legal_documents version the person was shown. technical_context is bounded to one token naming the wording shown; no IP address and no user agent are stored. Current state of (user, purpose) = the newest row by seq. Rows go when the auth account is deleted (ON DELETE CASCADE; Task 5 decides whether erasure should keep them anonymised).';

comment on column public.consents.policy_version is
  'The version of public.legal_documents(policy_slug) the event was recorded against. For a GRANT: the version the person was shown, which must equal the version currently published or the grant is refused (hint stale_policy_version). For a WITHDRAWAL: the version in force when it happened, stamped by the database.';
comment on column public.consents.technical_context is
  'At most {"statement": "<token>"} -- the identifier of the exact wording shown beside the control (lib/consent/catalogue.ts). Bounded by CHECK so no free text fits. Deliberately no IP address and no user agent: the authenticated session already identifies the subject (data minimisation; see the migration header).';
comment on column public.consents.seq is
  'Insertion order. The current state of (user_id, purpose) is the row with the greatest seq; timestamps cannot order two events in one transaction.';

-- CLAUDE.md: index every foreign key. (user_id leads the state index.)
create index consents_user_purpose_seq_idx on public.consents (user_id, purpose, seq desc);
create index consents_policy_idx on public.consents (policy_slug, policy_version);
create index consents_withdraws_id_idx on public.consents (withdraws_id);


-- ---------------------------------------------------------------------------
-- 3. GRANTS AND RLS
-- ---------------------------------------------------------------------------

revoke all on public.consents from public, anon, authenticated, service_role;
grant select on public.consents to authenticated;

alter table public.consents enable row level security;

create policy consents_select_own
  on public.consents for select to authenticated
  using (user_id = (select auth.uid()));

comment on policy consents_select_own on public.consents is
  'PERMITS: a signed-in user to read their own consent events (the account privacy page shows the current state, its time and version, and the history). DOES NOT PERMIT: reading anybody else''s. There is no INSERT/UPDATE/DELETE policy and no such grant: writes go through public.record_consent().';

create policy consents_select_platform
  on public.consents for select to authenticated
  using ((select private.has_platform_permission('oversee_consents')));

comment on policy consents_select_platform on public.consents is
  'PERMITS: the platform superuser (allowlisted, aal2) to read every consent event, for oversight -- complaints and data subject requests. Q103: every column of the row is therefore visible to that audience, and every column was chosen with that in mind (identifiers, enums, a version, timestamps, a statement token; no content, no IP, no user agent). DOES NOT PERMIT: any write.';


-- ---------------------------------------------------------------------------
-- 4. THE METER'S POLICY ROW
-- ---------------------------------------------------------------------------

insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description)
values ('consent_grant', 'user', 10, 3600,
        'Consent GRANTS per user (Phase 8 Task 2). Enforced at the insert by private.consents_before_insert(); withdrawals are never metered.');


-- ---------------------------------------------------------------------------
-- 5. THE CHOKEPOINT: BEFORE INSERT
-- ---------------------------------------------------------------------------

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

    -- (4) THE METER -- grants only; after every refusal above, so a
    -- redundant or stale click spends nothing.
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
  'BEFORE INSERT on public.consents, for EVERY writer: refuses a sessionless write (42501); stamps user_id from auth.uid(); derives category and policy_slug from private.consent_purposes() (22023 unknown_purpose); serialises per (user, purpose); refuses a redundant event (22023 already_granted / not_granted); requires a GRANT''s policy_version to equal the currently published version (22023 stale_policy_version); meters GRANTS at 10/hour/user (PT429, remaining seconds in HINT, crossing alert at the last accepted grant); stamps granted_at / withdrawn_at from the database clock, and for a WITHDRAWAL stamps the in-force version and the grant it ends. Withdrawals are never metered.';

revoke all on function private.consents_before_insert() from public, anon, authenticated, service_role;

create trigger consents_before_insert
  before insert on public.consents
  for each row execute function private.consents_before_insert();


-- ---------------------------------------------------------------------------
-- 6. APPEND-ONLY, FOR EVERY ROLE
-- ---------------------------------------------------------------------------

create or replace function private.consents_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'consents: the consent ledger is append-only -- record a new event instead'
      using errcode = '42501';
  end if;
  -- DELETE. Depth 1 is a DELETE statement (from any role, or any function);
  -- depth >= 2 is a foreign key's own cascade -- the account being deleted.
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception 'consents: the consent ledger is append-only -- rows go only with the account they belong to'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function private.consents_guard() is
  'BEFORE UPDATE OR DELETE on public.consents, for EVERY role (postgres included): refuses every UPDATE, and every DELETE except one run by a foreign key''s cascade (pg_trigger_depth() >= 2) -- i.e. the auth account being deleted. The deliberate DBA escape hatches (disabling the trigger, session_replication_role = replica) are the only other ways past it.';

revoke all on function private.consents_guard() from public, anon, authenticated, service_role;

create trigger consents_guard
  before update or delete on public.consents
  for each row execute function private.consents_guard();

create or replace function private.consents_truncate_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'consents: the consent ledger cannot be truncated'
    using errcode = '42501';
end;
$$;

comment on function private.consents_truncate_guard() is
  'BEFORE TRUNCATE (statement level) on public.consents, for every role: refuses. Row triggers do not fire for TRUNCATE, so without this the ledger could be emptied past private.consents_guard (the gap 20260922003000 closed for legal_documents).';

revoke all on function private.consents_truncate_guard() from public, anon, authenticated, service_role;

create trigger consents_truncate_guard
  before truncate on public.consents
  for each statement execute function private.consents_truncate_guard();


-- ---------------------------------------------------------------------------
-- 7. AUDIT: one row per event, identifiers and enums only
-- ---------------------------------------------------------------------------

create or replace function private.audit_consent_event()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.action = 'granted' then
    perform private.log_audit_event(
      p_action      => 'consent.granted',
      p_target_type => 'consent',
      p_target_id   => new.id,
      p_after       => pg_catalog.jsonb_build_object(
                         'category',       new.category,
                         'purpose',        new.purpose,
                         'policy_slug',    new.policy_slug,
                         'policy_version', new.policy_version,
                         'mechanism',      new.mechanism)
    );
  else
    perform private.log_audit_event(
      p_action      => 'consent.withdrawn',
      p_target_type => 'consent',
      p_target_id   => new.id,
      p_after       => pg_catalog.jsonb_build_object(
                         'category',       new.category,
                         'purpose',        new.purpose,
                         'policy_slug',    new.policy_slug,
                         'policy_version', new.policy_version,
                         'mechanism',      new.mechanism,
                         'withdraws',      new.withdraws_id)
    );
  end if;
  return null;
end;
$$;

comment on function private.audit_consent_event() is
  'AFTER INSERT on public.consents: writes consent.granted or consent.withdrawn to audit_events (no organisation -- consent is account-level). Payload: category, purpose, policy slug and version, mechanism, and for a withdrawal the id of the grant it ends. Identifiers and enums only. Every insert has a session (the BEFORE trigger refuses one without), so log_audit_event always has an actor.';

revoke all on function private.audit_consent_event() from public, anon, authenticated, service_role;

create trigger consents_audit_event
  after insert on public.consents
  for each row execute function private.audit_consent_event();


-- ---------------------------------------------------------------------------
-- 8. THE ONE SESSION WRITE PATH
-- ---------------------------------------------------------------------------

create or replace function public.record_consent(
  p_purpose        text,
  p_action         text,
  p_policy_version integer default null,
  p_statement      text    default null
)
returns table (
  consent_id       uuid,
  recorded_action  text,
  recorded_slug    text,
  recorded_version integer,
  occurred_at      timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'record_consent: no session' using errcode = '42501';
  end if;

  -- Everything that matters is decided by private.consents_before_insert();
  -- this function only names the mechanism and shapes the context.
  insert into public.consents as c (purpose, action, policy_version, mechanism, technical_context)
  values (
    p_purpose,
    p_action,
    -- Placeholder for a withdrawal (the trigger stamps the real one); the
    -- caller's value for a grant, checked by the trigger.
    coalesce(p_policy_version, 0),
    'account_settings',
    case when p_statement is null then '{}'::jsonb
         else pg_catalog.jsonb_build_object('statement', p_statement) end
  )
  returning c.id, c.action, c.policy_slug, c.policy_version,
            coalesce(c.granted_at, c.withdrawn_at)
       into consent_id, recorded_action, recorded_slug, recorded_version, occurred_at;
  return next;
end;
$$;

comment on function public.record_consent(text, text, integer, text) is
  'The ONLY session write path into public.consents: records a grant or a withdrawal for the CALLER (there is no user argument -- private.consents_before_insert() stamps it from the session). p_policy_version is the version of the governing legal document the caller was shown (required for a grant, ignored for a withdrawal); p_statement is the identifier of the wording shown beside the control. Mechanism is always account_settings. Errors: 42501 no session; 22023 with hint unknown_purpose / already_granted / not_granted / stale_policy_version; PT429 (grants only) with the remaining seconds in hint.';

revoke all on function public.record_consent(text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.record_consent(text, text, integer, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. THE CHECK EVERY FUTURE MARKETING SENDER MUST CALL
-- ---------------------------------------------------------------------------

create or replace function public.consent_is_granted(p_user_id uuid, p_purpose text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last text;
begin
  if not exists (select 1 from private.consent_purposes() c where c.purpose = p_purpose) then
    raise exception 'consent_is_granted: % is not a consent purpose', p_purpose
      using errcode = '22023';
  end if;
  select c.action into v_last
    from public.consents c
   where c.user_id = p_user_id and c.purpose = p_purpose
   order by c.seq desc
   limit 1;
  -- No record is no consent.
  return coalesce(v_last = 'granted', false);
end;
$$;

comment on function public.consent_is_granted(uuid, text) is
  'True iff the newest consent event for (p_user_id, p_purpose) is a grant. No record = false. A grant stays valid when a later version of the governing page is published (DECISIONS-QUEUE, Task 2: re-consent on a material change is not automatic). Raises 22023 for a purpose outside the catalogue, so a typo in a sender fails loudly instead of silently never sending. EXECUTE is granted to service_role ALONE: a marketing sender runs without a session, and no user may probe another user''s consent. lib/consent/marketing.ts wraps it; every future marketing sender must call that wrapper (tests/unit/consent/marketing-sender-census.test.ts).';

revoke all on function public.consent_is_granted(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.consent_is_granted(uuid, text) to service_role;
