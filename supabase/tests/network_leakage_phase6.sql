-- ===========================================================================
-- Phase 6 (Network), Task 5: THE CONSOLIDATED NETWORK-LEAKAGE SUITE.
--
-- A SEPARATE FILE from rls_phase6_network.sql, in the file_access_phase4.sql
-- tradition: a dedicated file for the one boundary that must never move. That
-- file exists because the download half of the file pipeline is a single
-- invariant worth isolating from the surface that produced it; this one exists
-- for the same reason and a stronger one. CLAUDE.md calls the private/network
-- split "the highest-risk boundary" and § Testing gates calls network-leakage
-- tests the ones that "matter most". THE PRD EXIT CRITERION FOR THIS PHASE IS
-- "private/public boundaries proven by tests". This file is that proof.
--
-- ===========================================================================
-- WHAT MAKES THIS DIFFERENT FROM rls_phase6_network.sql
-- ===========================================================================
-- That suite proves the surfaces Tasks 1-4 built behave as their authors say.
-- THIS ONE ASSUMES THOSE AUTHORS ARE WRONG AND GOES LOOKING. Concretely:
--
--   * IT DRIVES A REAL COUNTERPARTY. rls_phase6_network.sql's cross-tenant
--     assertions run as `pbowner`, BETA's owner -- and BETA is CONNECTED to
--     ALPHA by the time that file ends (its NR9/NU4 accept a request between
--     the two organisations, and run-rls-tests.sh's own Task-3 comment says so
--     at length). So there was, until this file, NO psql assertion in the repo
--     run as an UNCONNECTED counterparty. § LA creates one: a THIRD
--     organisation with a real member of its own.
--   * IT SWEEPS EVERY PRIVATE RELATION, not the ones the feature touched.
--     § LC drives 23 tenant-private relations from BOTH counterparty
--     distances, each with a measured denominator, rather than asserting the
--     four tables the network feature happens to name.
--   * IT LOOKS INSIDE FUNCTION BODIES. rls_phase6_network.sql § ND asserts
--     each view's dependency SET. Task 1's own fix-round ledger records the
--     residual: "the I1 fix widens the guard's reach but not its depth --
--     function BODIES are unexamined; a helper the connected view calls could
--     read a private table". § LF closes that, with a transitive closure and a
--     planted positive control.
--
-- ===========================================================================
-- SECTIONS
-- ===========================================================================
--   LA  THE COUNTERPARTY FIXTURE -- a third organisation, a real member of it,
--       and a real member of the connected one. Asserted to belong to exactly
--       the organisation this file says they belong to, because an assertion
--       run as a user who belongs to neither org proves less than it appears.
--   LB  THE VIEW MATRIX -- directory / connected view / base table, from both
--       distances, with ALPHA's own read as the positive control.
--   LC  THE PRIVATE-RELATION SWEEP -- 23 relations x {unconnected, connected}
--       = 0 of N, every N measured, every 0 paired with a positive control.
--   LD  network_links (Q82) from BOTH distances.
--   LE  THE FORWARD RATINGS GUARD (N5/Q85), with the census widened to close
--       Task 1 ledger item M6 (NF1b excluded private.audit_network_row).
--   LF  THE FUNCTION-BODY DEPTH GUARD -- Task 1 ledger item I1.
--   LG  THE IDENTIFIER-DISCLOSURE PROBE -- no exposed VALUE is a private id.
--   LH  THE entity_id INFERENCE PROBE.
--   LI  THE DOWNGRADE PROBE (Q81) -- both halves.
--   LJ  THE SUSPENSION PROBE -- MEASURED AND RECORDED, not asserted-as-correct.
--   LK  THE aal1 PROBE.
--   LW  THE COUNTERPARTY WRITE PROBES.
--   LZ  HOUSEKEEPING -- what this file leaves standing, and why.
--
-- ===========================================================================
-- WHAT IT LEAVES BEHIND, ON PURPOSE
-- ===========================================================================
-- Unlike file_access_phase4.sql it does NOT tear its fixture down: the HTTP
-- block at the bottom of run-rls-tests.sh reuses the two counterparty tokens
-- and the third organisation to drive the same matrix over PostgREST. § LZ
-- states exactly what is left and asserts the one property the upstream HTTP
-- checks depend on -- that the third organisation publishes NO network profile,
-- so the "all four published profiles" counts in the Task 1 HTTP block are
-- untouched.
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh (after rls_phase6_network.sql).
-- psql vars: P6VARS -- the twelve P2 fixture users' claims, `super_c`, and the
-- two counterparty users this task added (`pgmgr`/`pbmgr`, each with `_c` at
-- aal2 and `_c1` at aal1).
--
-- EXPECTATION VOCABULARY (unchanged from the other suites):
--   denied(42501) no grant, or a WITH CHECK / INSERT policy refusal
--   denied(23514) a CHECK -- the constraint layer, every writer
--   denied(42703) an undefined column -- the view does not project it
--   ok(0)         accepted, matched no rows -- a USING clause filtered it
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists leak cascade;
create schema leak;

create table leak.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function leak.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into leak.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function leak.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform leak.record(p_label, p_expected, v_actual);
end $$;

create function leak.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform leak.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema leak to authenticated, anon, service_role;
grant execute on function leak.record(text,text,text) to authenticated, anon, service_role;
grant execute on function leak.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function leak.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null

select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

\o

-- ===========================================================================
-- LA. THE COUNTERPARTY FIXTURE.
--
-- ===========================================================================
-- WHY A THIRD ORGANISATION HAD TO BE CREATED
-- ===========================================================================
-- The matrix this file drives has two columns -- UNCONNECTED and CONNECTED --
-- and the existing fixture world can only supply one of them. ALPHA and BETA
-- ARE CONNECTED: rls_phase6_network.sql NR9 sends a request from alpha_org to
-- beta_org and NU4 accepts it, and public.network_connected_profiles' `exists`
-- is ORGANISATION-to-ORGANISATION (20260904004000's header), so from that
-- moment every published BETA profile is connections-visible to ALPHA and vice
-- versa. Every "an outsider sees nothing" assertion written as `pbowner` after
-- that point is an assertion about a CONNECTED outsider, whatever its label
-- says.
--
-- So GAMMA is created here: a real organisation, with a real member, that has
-- never exchanged a request with anybody. LA4/LA5 assert that state rather
-- than assuming it, because "unconnected" is the entire meaning of the column.
--
-- ===========================================================================
-- AND WHY EACH COUNTERPARTY IS A REAL MEMBER OF EXACTLY ONE ORGANISATION
-- ===========================================================================
-- The Task 5 brief's own words: "an assertion run as a user who belongs to
-- neither org proves less than it appears to". A session with no membership at
-- all reads zero rows everywhere for a reason that has nothing to do with the
-- private/network boundary -- it fails the `is_active_member` half of every
-- policy in the schema before any tenant term is reached. LA2/LA3 pin the
-- membership; LA6/LA7 pin that the key is actually HELD, so a 0 later in this
-- file is a boundary and not an inert session.
--
-- Both counterparties are `manager`, which is MFA-OPTIONAL
-- (private.role_requires_mfa('manager') is false), so their aal1 sessions hold
-- view_network for real. That matters: an owner or admin counterparty at aal1
-- holds nothing, and every 0 measured through one would be the MFA gate rather
-- than the tenant boundary. § LK drives the aal1 question deliberately, where
-- it is the subject rather than a confound.
-- ===========================================================================
\o /dev/null
insert into public.organisations (id, name, slug)
values ('a0110000-0000-0000-0000-0000000000ca', 'Gamma Unconnected', 'org-gamma-leak')
on conflict (slug) do nothing;

select id as gamma_org from public.organisations where slug='org-gamma-leak' \gset

insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values (:'gamma_org', :'pgmgr', 'manager', 'active', now())
on conflict (organisation_id, user_id) do update set role='manager', status='active';

insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values (:'beta_org', :'pbmgr', 'manager', 'active', now())
on conflict (organisation_id, user_id) do update set role='manager', status='active';
\o

select leak.val('LA1 FIXTURE: the third organisation exists and is LIVE',
  $$select (count(*) = 1)::text from public.organisations
     where slug='org-gamma-leak' and deleted_at is null$$, 'true');

-- THE MEMBERSHIP, PINNED. Each counterparty belongs to exactly ONE
-- organisation and it is the one this file names.
select leak.val('LA2 the UNCONNECTED counterparty is an active manager of GAMMA and of nothing else',
  format($$select string_agg(o.slug || ':' || m.role || ':' || m.status, ',')
             from public.organisation_memberships m
             join public.organisations o on o.id = m.organisation_id
            where m.user_id = %L$$, :'pgmgr'),
  'org-gamma-leak:manager:active');
select leak.val('LA3 the CONNECTED counterparty is an active manager of BETA and of nothing else',
  format($$select string_agg(o.slug || ':' || m.role || ':' || m.status, ',')
             from public.organisation_memberships m
             join public.organisations o on o.id = m.organisation_id
            where m.user_id = %L$$, :'pbmgr'),
  'org-beta:manager:active');

-- THE CONNECTION STATE, MEASURED. This is what makes the two columns of the
-- matrix mean what they say.
select leak.val('LA4 GAMMA has ZERO accepted connections with ALPHA (the UNCONNECTED column)',
  format($$select count(*)::text from public.network_connection_requests
            where status='accepted'
              and ((from_organisation_id=%L and to_organisation_id=%L)
                or (from_organisation_id=%L and to_organisation_id=%L))$$,
         :'gamma_org', :'alpha_org', :'alpha_org', :'gamma_org'), '0');
select leak.val('LA5 CONTROL: BETA has at least one accepted connection with ALPHA (the CONNECTED column)',
  format($$select (count(*) >= 1)::text from public.network_connection_requests
            where status='accepted'
              and ((from_organisation_id=%L and to_organisation_id=%L)
                or (from_organisation_id=%L and to_organisation_id=%L))$$,
         :'beta_org', :'alpha_org', :'alpha_org', :'beta_org'), 'true');
select leak.val('LA5b ...and GAMMA has never exchanged a request with ANYBODY, in any state',
  format($$select count(*)::text from public.network_connection_requests
            where from_organisation_id=%L or to_organisation_id=%L$$,
         :'gamma_org', :'gamma_org'), '0');

-- THE SESSIONS ARE LIVE AND HOLD THE READ KEY. Without this pair every 0 below
-- is satisfied by a session that cannot read anything at all.
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LA6 the UNCONNECTED counterparty''s aal1 session HOLDS view_network in GAMMA',
  format($$select (%L::uuid in (select private.permitted_organisations('view_network')))::text$$,
         :'gamma_org'), 'true');
select leak.val('LA6b ...and reads exactly its OWN organisation row (a live, RLS-scoped session)',
  $$select string_agg(slug, ',' order by slug) from public.organisations$$, 'org-gamma-leak');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbmgr_c1';
select leak.val('LA7 the CONNECTED counterparty''s aal1 session HOLDS view_network in BETA',
  format($$select (%L::uuid in (select private.permitted_organisations('view_network')))::text$$,
         :'beta_org'), 'true');
select leak.val('LA7b ...and reads BETA''s OWN contacts (so its 0s below are a boundary)',
  format($$select (count(*) >= 1)::text from public.contacts where organisation_id=%L$$,
         :'beta_org'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LB. THE VIEW MATRIX.
--
-- The four cells of the brief's first three rows, driven from both distances
-- with ALPHA's own read as the positive control:
--
--   network_directory            network fields only, BOTH distances
--   network_connected_profiles   0 rows unconnected; network+connections
--                                fields connected
--   network_profiles (base)      readable BY DESIGN, both distances -- the
--                                documented fact the source-shape guards are
--                                paired with
--
-- The subject is ALPHA's published profile e0110000-...-000a, whose seven
-- publishable fields are spread across all three levels by
-- rls_phase6_network.sql's own fixture: headline/city `network`,
-- bio/contact_email `connections`, region/country/website_url hidden (and
-- therefore NULL in the base column -- N3).
-- ===========================================================================

-- ---- UNCONNECTED ----------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';

select leak.val('LB1 UNCONNECTED: ALPHA''s published profile IS in the directory',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select leak.val('LB2 UNCONNECTED: a `network` field resolves (city)',
  $$select city from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Bristol');
select leak.val('LB2b UNCONNECTED: ...and the second one (headline), so LB2 is not one-column luck',
  $$select headline from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Independent promoter');
select leak.val('LB3 UNCONNECTED: a `connections` field is NULL in the directory (contact_email)',
  $$select coalesce(contact_email,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
select leak.val('LB3b UNCONNECTED: ...and so is the second one (bio)',
  $$select coalesce(bio,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
select leak.val('LB4 UNCONNECTED: the CONNECTED view returns 0 rows for ALPHA''s profile',
  $$select count(*)::text from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, '0');
select leak.val('LB4b UNCONNECTED: ...and 0 rows in TOTAL, not merely for that one profile',
  $$select count(*)::text from public.network_connected_profiles$$, '0');
select leak.val('LB4c CONTROL: the same session DOES see rows in the directory (LB4b is a boundary)',
  $$select (count(*) >= 1)::text from public.network_directory$$, 'true');
-- ALPHA's DRAFT is not discoverable at either distance -- the IDOR row of the
-- matrix, at the policy layer. The HTTP block drives the same id over
-- PostgREST and the e2e suite drives it through the route.
select leak.val('LB5 UNCONNECTED: ALPHA''s DRAFT profile is 0 rows in the directory',
  $$select count(*)::text from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
select leak.val('LB5b UNCONNECTED: ...and 0 rows in the BASE TABLE too (no existence leak)',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');

-- THE BASE TABLE IS READABLE BY DESIGN, AND THAT IS THE DOCUMENTED FACT the
-- source-shape guards are the other half of (20260904003000's own comment on
-- network_profiles_select_published_directory). It is asserted from the
-- UNCONNECTED distance here for the first time -- run-rls-tests.sh's Task 3
-- block measures it as ALPHA's own manager reading BETA's row, which is a
-- different caller.
select leak.val('LB6 BY DESIGN: the UNCONNECTED counterparty reads ALPHA''s organisation_id off the BASE TABLE',
  format($$select (organisation_id = %L)::text from public.network_profiles
             where id='e0110000-0000-0000-0000-00000000000a'$$, :'alpha_org'), 'true');
select leak.val('LB6b BY DESIGN: ...and entity_id, which names one of ALPHA''s private companies',
  $$select entity_id::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$,
  '11110000-0000-0000-0000-000000000002');
select leak.val('LB6c BY DESIGN: ...and a `connections`-level VALUE, unmasked',
  $$select contact_email from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'bookings@alpha.test');
select leak.val('LB6d ...while a HIDDEN field is NULL in the base column too (N3 -- nothing to leak)',
  $$select coalesce(region,'<null>') || '/' || coalesce(country,'<null>') || '/' ||
           coalesce(website_url,'<null>')
      from public.network_profiles where id='e0110000-0000-0000-0000-00000000000a'$$,
  '<null>/<null>/<null>');
reset role; reset request.jwt.claims;

-- ---- CONNECTED ------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pbmgr_c1';

select leak.val('LB7 CONNECTED: the directory STILL masks the `connections` field (the view''s test does not vary)',
  $$select coalesce(contact_email,'<null>') from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '<null>');
select leak.val('LB8 CONNECTED: the CONNECTED view resolves it -- this is the ONE thing accept changes (N4)',
  $$select contact_email from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'bookings@alpha.test');
select leak.val('LB8b CONNECTED: ...and the second connections field (bio)',
  $$select bio from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Twenty years of shows');
select leak.val('LB9 CONNECTED: ALPHA''s DRAFT is STILL 0 rows -- accept does not unlock a draft',
  $$select count(*)::text from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
select leak.val('LB9b CONNECTED: ...and still 0 in the base table',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
-- The connected view exposes the SAME eleven columns and no more: an accepted
-- connection widens VALUES, never the column list.
select leak.val('LB10 CONNECTED: the connected view still projects neither organisation_id nor entity_id',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='network_connected_profiles'
       and column_name in ('organisation_id','entity_id')$$, '0');
reset role; reset request.jwt.claims;

-- ---- ALPHA'S OWN READ, THE POSITIVE CONTROL FOR THE WHOLE SECTION ---------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LB11 CONTROL: ALPHA reads ALL its own published values, unmasked, off its own row',
  $$select display_name || '|' || headline || '|' || city || '|' || bio || '|' || contact_email
      from public.network_profiles where id='e0110000-0000-0000-0000-00000000000a'$$,
  'Alpha Promotions|Independent promoter|Bristol|Twenty years of shows|bookings@alpha.test');
select leak.val('LB11b CONTROL: ...and sees its OWN draft, which neither counterparty could',
  $$select display_name from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, 'Alpha Draft Venue');
reset role; reset request.jwt.claims;

-- ---- THE DIRECTORY VIEW'S `deleted_at is null` PREDICATE IS LOAD-BEARING ---
--
-- ===========================================================================
-- WHY THIS COULD NOT BE PROVEN FROM A COUNTERPARTY, AND WHY THE PREDICATE
-- STILL MATTERS
-- ===========================================================================
-- A SOFT-DELETED published profile is kept out of discovery by TWO independent
-- terms: the `network_profiles_select_published_directory` RLS policy carries
-- `deleted_at is null`, AND the view carries it too. For a COUNTERPARTY the RLS
-- term is the backstop -- drop it from the view and a counterparty still sees
-- nothing, because the policy filters the row before the view is even reached.
-- So no counterparty assertion in this file (or in rls_phase6_network.sql) can
-- observe the view's own `deleted_at is null` being removed, and the mutation
-- that removes it survives the whole suite unless THIS block exists.
--
-- The term still matters, and here is the exposure it closes: an organisation's
-- OWN members hold `network_profiles_select_view_network`, which is
-- organisation-scoped and -- per Constraint 7 -- does NOT filter soft-deletes.
-- So a member reads its own soft-deleted profile straight off the base table,
-- and the VIEW's `deleted_at is null` is the ONLY thing keeping a profile the
-- org has UNPUBLISHED (soft-deleted) from reappearing in that org's own
-- directory browsing. Drop it and a withdrawn identity is discoverable again to
-- the very people who withdrew it. This block plants exactly that shape, driven
-- as ALPHA's own member, with the base-table read and a live profile as the two
-- controls that make the 0 the view predicate rather than an empty fixture.
--
-- Planted as postgres (RLS does not apply to the writer; the partial unique
-- index is `where deleted_at is null` so a soft-deleted duplicate of an
-- already-published entity is allowed) and TORN DOWN at the end of the block,
-- so nothing downstream -- the LC sweep's denominators, LZ's "exactly 4
-- published live", the HTTP block's profile counts -- meets a row this planted.
-- ===========================================================================
\o /dev/null
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, display_name, status,
   field_visibility, published_at, deleted_at)
values ('e0110000-0000-0000-0000-0000000000fd', :'alpha_org', 'company',
        '11110000-0000-0000-0000-000000000002', 'Alpha Withdrawn', 'published',
        '{"city":"network"}'::jsonb, now(), now())
on conflict (id) do update set status='published', deleted_at=now();
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LB12 M2: ALPHA''s OWN soft-deleted published profile is EXCLUDED from the directory view',
  $$select count(*)::text from public.network_directory
     where id='e0110000-0000-0000-0000-0000000000fd'$$, '0');
select leak.val('LB12b CONTROL: ...but ALPHA DOES read it off the base table (view_network ignores soft-delete)',
  $$select (count(*) = 1)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-0000000000fd'$$, 'true');
select leak.val('LB12c CONTROL: a LIVE published profile IS in the directory (LB12 is the deleted_at term, not an empty fixture)',
  $$select count(*)::text from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, '1');
reset role; reset request.jwt.claims;
\o /dev/null
delete from public.network_profiles where id='e0110000-0000-0000-0000-0000000000fd';
\o
select leak.val('LB12d HOUSEKEEPING: the planted soft-deleted profile is gone (nothing downstream meets it)',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-0000000000fd'$$, '0');

-- ===========================================================================
-- LC. THE PRIVATE-RELATION SWEEP.
--
-- ===========================================================================
-- THE DENOMINATORS ARE MEASURED, NEVER HARDCODED (Constraint 14)
-- ===========================================================================
-- "0 rows" is satisfied perfectly by a table that is empty. So every relation
-- below is counted AS POSTGRES first, into leak.den, and LC0 refuses to
-- continue if any of them is zero. The counterparty assertions then read
-- "0 (of N)" with N in the label -- a number that came out of this database on
-- this run, not out of a comment.
--
-- WHY A SWEEP AND NOT A LIST OF HAND-WRITTEN ASSERTIONS. The boundary this
-- phase defends is not "the four tables the network feature happens to name".
-- It is EVERY tenant-private relation, including the ones a future phase adds.
-- A loop over a catalogue-shaped list is what makes adding a relation to the
-- guard a one-line change, and what makes the omission of one visible.
--
-- document_versions IS DELIBERATELY EXCLUDED AND THE EXCLUSION IS STATED: it
-- ships dormant (SELECT-only, no write path -- CLAUDE.md § Operations) and has
-- ZERO rows in this fixture, so a "0 of 0" assertion would be exactly the
-- vacuous shape Constraint 14 exists to forbid. LC0c asserts it is empty, so
-- the exclusion is a measurement rather than an oversight, and a future
-- fixture that plants one turns LC0c red and pulls it into the sweep.
-- ===========================================================================
\o /dev/null
create table leak.den (rel text primary key, n bigint not null);

-- The org id reaches the anonymous block through a GUC rather than through
-- string interpolation: psql's :'alpha_org' cannot be substituted inside a
-- dollar-quoted body, and concatenating it in would be the string-built SQL
-- CLAUDE.md forbids "anywhere".
select set_config('leak.alpha', :'alpha_org', false);

do $$
declare r text; n bigint;
begin
  foreach r in array array[
    'contacts','companies','artists','venues','venue_rooms','agencies',
    'contact_companies','events','event_lineup','event_status_changes',
    'tasks','meetings','notes','documents','financial_entries',
    'custom_field_values','task_links','meeting_links','note_links',
    'document_links','network_links','audit_events','activity_events'
  ] loop
    execute format('select count(*) from public.%I where organisation_id = %L',
                   r, current_setting('leak.alpha')) into n;
    insert into leak.den (rel, n) values (r, n);
  end loop;
end $$;
\o

select leak.val('LC0 DENOMINATOR: 23 private relations were counted, and EVERY ONE is non-empty for ALPHA',
  $$select count(*)::text || '/' || count(*) filter (where n > 0)::text from leak.den$$, '23/23');
select leak.val('LC0b the relations swept, by name (a dropped one is red here, not silently unswept)',
  $$select string_agg(rel, ',' order by rel) from leak.den$$,
  'activity_events,agencies,artists,audit_events,companies,contact_companies,contacts,'
  'custom_field_values,document_links,documents,event_lineup,event_status_changes,events,'
  'financial_entries,meeting_links,meetings,network_links,note_links,notes,task_links,'
  'tasks,venue_rooms,venues');
select leak.val('LC0c STATED EXCLUSION: public.document_versions is empty, so it is out of the sweep',
  $$select count(*)::text from public.document_versions$$, '0');

grant select on leak.den to authenticated;

-- The sweep itself. SECURITY INVOKER, so the dynamic counts meet the calling
-- session's RLS exactly as an attacker's query would.
create function leak.sweep(p_prefix text, p_org uuid, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare r record; v_n bigint; act text;
begin
  for r in select d.rel, d.n from leak.den d order by d.rel loop
    begin
      execute format('select count(*) from public.%I where organisation_id = %L', r.rel, p_org)
        into v_n;
      act := v_n::text;
    exception when others then act := 'denied(' || sqlstate || ')'; end;
    perform leak.record(p_prefix || r.rel || ' (of ' || r.n || ')', p_expected, act);
  end loop;
end $$;

-- The positive half: at least one row of each is reachable to the organisation
-- that owns it, so every 0 above is a boundary and not an empty table twice.
create function leak.sweep_reachable(p_prefix text, p_org uuid, p_skip text[])
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare r record; v_n bigint; act text;
begin
  for r in select d.rel, d.n from leak.den d where not (d.rel = any(p_skip)) order by d.rel loop
    begin
      execute format('select count(*) from public.%I where organisation_id = %L', r.rel, p_org)
        into v_n;
      act := (v_n >= 1)::text;
    exception when others then act := 'denied(' || sqlstate || ')'; end;
    perform leak.record(p_prefix || r.rel || ' (of ' || r.n || ')', 'true', act);
  end loop;
end $$;

-- ...and the FIDELITY figure, which is what stops "at least one" from being a
-- soft assertion: how many of the swept relations does the owning
-- organisation see IN FULL, and which two does it not.
create function leak.sweep_fidelity(p_org uuid, p_skip text[])
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare r record; v_n bigint; v_exact int := 0; v_total int := 0; v_differ text[] := '{}';
begin
  for r in select d.rel, d.n from leak.den d where not (d.rel = any(p_skip)) order by d.rel loop
    v_total := v_total + 1;
    begin
      execute format('select count(*) from public.%I where organisation_id = %L', r.rel, p_org)
        into v_n;
    exception when others then v_n := -1; end;
    if v_n = r.n then v_exact := v_exact + 1; else v_differ := v_differ || r.rel; end if;
  end loop;
  return v_exact || '/' || v_total || ' exact; differ: ' ||
         coalesce(array_to_string(v_differ, ','), '<none>');
end $$;

grant execute on function leak.sweep(text,uuid,text)               to authenticated;
grant execute on function leak.sweep_reachable(text,uuid,text[])   to authenticated;
grant execute on function leak.sweep_fidelity(uuid,text[])         to authenticated;

-- ---- THE NEGATIVE, TWICE --------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.sweep('LC1 UNCONNECTED counterparty reads 0 ALPHA rows: ', :'alpha_org', '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbmgr_c1';
select leak.sweep('LC2 CONNECTED counterparty reads 0 ALPHA rows: ', :'alpha_org', '0');
reset role; reset request.jwt.claims;

-- The connected counterparty at aal2, because a manager may hold a factor and
-- the accepted connection is the thing under test, not the assurance level.
set role authenticated;
set request.jwt.claims = :'pbmgr_c';
select leak.sweep('LC3 CONNECTED counterparty AT aal2 reads 0 ALPHA rows: ', :'alpha_org', '0');
reset role; reset request.jwt.claims;

-- ---- THE POSITIVE CONTROLS ------------------------------------------------
-- ALPHA's OWNER at aal2 is the broadest tenant reader there is. audit_events is
-- skipped and handled separately: it is readable to NO tenant role at all --
-- measured, not assumed (LC5 is that measurement) -- so the superuser is its
-- only positive control, exactly as the brief's matrix says.
set role authenticated;
set request.jwt.claims = :'powner_c';
select leak.sweep_reachable('LC4 CONTROL ALPHA''s owner reaches at least one: ',
                            :'alpha_org', array['audit_events']);
-- MEASURED, AND THE THREE THAT DIFFER ARE NAMED RATHER THAN ROUNDED OFF:
-- ALPHA holds one `private` note authored by somebody else, which its owner
-- cannot read (Q54, notes_select_visibility), and that one row accounts for
-- all three -- the note itself, its `note_links` row (the child policy reads
-- through the parent) and its `activity_events` row. Naming them is what makes
-- "19 of 22 exact" a finding rather than a fudge factor.
select leak.val('LC4b CONTROL: how much of it ALPHA''s owner sees IN FULL, and what it does not',
  format($$select leak.sweep_fidelity(%L, array['audit_events'])$$, :'alpha_org'),
  '19/22 exact; differ: activity_events,note_links,notes');
select leak.val('LC5 MEASURED: audit_events is readable to NO tenant role, not even ALPHA''s owner',
  format($$select count(*)::text from public.audit_events where organisation_id=%L$$,
         :'alpha_org'), '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select leak.val('LC5b CONTROL: the SUPERUSER reads ALPHA''s network publish audit rows (LC5 is scope, not emptiness)',
  format($$select (count(*) >= 1)::text from public.audit_events
             where organisation_id=%L and action like 'network_%%'$$, :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LD. network_links (Q82) FROM BOTH DISTANCES.
--
-- rls_phase6_network.sql § NL proves the profile's OWNER cannot see who linked
-- to them, as BETA's owner -- i.e. from what is now known to be the CONNECTED
-- distance. This adds the unconnected one and the accept-changes-nothing half:
-- an accepted connection must not open a link path either (N4).
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LD1 UNCONNECTED: 0 network_links visible in total',
  $$select count(*)::text from public.network_links$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbmgr_c1';
select leak.val('LD2 CONNECTED: 0 network_links visible in total -- accept opens no link path (N4)',
  $$select count(*)::text from public.network_links$$, '0');
select leak.val('LD2b CONNECTED: ...including the one filed against BETA''s OWN profile (Q82)',
  $$select count(*)::text from public.network_links
     where network_profile_id='e0110000-0000-0000-0000-00000000000b'$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LD3 CONTROL: the LINKING organisation reads its own link (LD1/LD2 are boundaries)',
  $$select count(*)::text from public.network_links
     where id='d0110000-0000-0000-0000-000000000001'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LE. THE FORWARD RATINGS GUARD (N5 / Q85), WITH THE CENSUS WIDENED.
--
-- ===========================================================================
-- TASK 1 LEDGER ITEM M6, CLOSED HERE
-- ===========================================================================
-- rls_phase6_network.sql § NF builds its census with
-- `pr.proname like 'network%'`. That NAME filter misses two of the five
-- functions on the network surface:
--
--   private.audit_network_row               -- the audit writer, whose whole
--                                              job is deciding what leaves the
--                                              tenant onto a superuser-readable
--                                              table. The single likeliest
--                                              future home for a rating count.
--   private.fill_connection_request_recipient -- the BEFORE INSERT trigger that
--                                              derives to_organisation_id.
--
-- Neither name starts with `network`, so NF1's "0 bodies mention rating" was
-- measured over three functions where five were in scope. THE FIX IS NOT TO
-- ADD TWO NAMES -- a name list drifts the same way the last one did. The census
-- below is STRUCTURAL: a function is on the network surface if it is a TRIGGER
-- on one of the three network tables, or if a network policy or view NAMES it,
-- or if its own name mentions network. LE1c asserts by name that the two
-- previously-missing functions are now inside it, so the fix is visible rather
-- than merely effective.
-- ===========================================================================
\o /dev/null
create view leak.network_surface_text as
  select 'policy:' || p.polname as objname,
         coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
         coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '') as body
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relnamespace='public'::regnamespace and c.relname like 'network%'
  union all
  select 'view:' || c.relname, pg_catalog.pg_get_viewdef(c.oid)
    from pg_catalog.pg_class c
   where c.relnamespace='public'::regnamespace and c.relkind='v'
     and c.relname like 'network%';

create view leak.network_fns as
  -- (a) STRUCTURAL: a trigger on one of the three network tables.
  select distinct t.tgfoid as oid
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
   where c.relnamespace='public'::regnamespace
     and c.relname like 'network%' and not t.tgisinternal
  union
  -- (b) STRUCTURAL: named by a network policy expression or a network view.
  select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','private') and p.prokind = 'f'
     and exists (select 1 from leak.network_surface_text s
                  where s.body ~ ('\m' || n.nspname || '\.' || p.proname || '\M'))
  union
  -- (c) BY NAME, kept as a third net rather than as the only one.
  select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','private') and p.prokind = 'f'
     and p.proname like '%network%';

create view leak.network_surface_wide as
  select objname, body from leak.network_surface_text
  union all
  select 'function:' || n.nspname || '.' || p.proname,
         pg_catalog.pg_get_functiondef(p.oid)
    from leak.network_fns f
    join pg_catalog.pg_proc p on p.oid = f.oid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace;
\o

select leak.val('LE1 N5: NOTHING on the network surface names a rating, in any form',
  $$select count(*)::text from leak.network_surface_wide where body ~* 'rating'$$, '0');
select leak.val('LE1b DENOMINATOR: the widened census inspected 11 policies, 2 views and 9 functions',
  $$select count(*) filter (where objname like 'policy:%')::text || '/' ||
           count(*) filter (where objname like 'view:%')::text || '/' ||
           count(*) filter (where objname like 'function:%')::text || '/' ||
           count(*)::text
      from leak.network_surface_wide$$, '11/2/9/22');
-- M6, NAMED. The two functions rls_phase6_network.sql § NF1b could not see.
select leak.val('LE1c M6: the two functions the NAME filter missed are INSIDE this census',
  $$select string_agg(objname, ',' order by objname) from leak.network_surface_wide
     where objname in ('function:private.audit_network_row',
                       'function:private.fill_connection_request_recipient')$$,
  'function:private.audit_network_row,function:private.fill_connection_request_recipient');
select leak.val('LE1d ...and the functions in the census, by name, so a dropped one is red',
  $$select string_agg(replace(objname,'function:',''), ',' order by objname)
      from leak.network_surface_wide where objname like 'function:%'$$,
  'private.audit_network_row,private.entity_is_manageable,private.entity_org_unchanged,'
  'private.fill_connection_request_recipient,private.network_publish_organisations,'
  'private.network_request_status_transition_guard,private.network_visibility_is_valid,'
  'private.permitted_organisations,private.set_updated_at');

-- THE PLANTED POSITIVE CONTROL. Without it, "0 bodies mention rating" is a
-- claim about a regex nobody has watched fire.
\o /dev/null
create function private.leak_probe_network_rating() returns bigint
  language sql stable set search_path = '' as $$
  -- names public.network_profiles so net (b)/(c) both catch it, and a rating
  -- so LE2 has something to find.
  select count(*) from public.network_profiles where display_name = 'rating probe';
$$;
\o
select leak.val('LE2 POSITIVE CONTROL: a planted function naming a rating IS flagged by LE1''s query',
  $$select count(*)::text from leak.network_surface_wide where body ~* 'rating'$$, '1');
select leak.val('LE2b ...and it is flagged BY NAME, so LE2 is not some other object',
  $$select string_agg(objname, ',') from leak.network_surface_wide where body ~* 'rating'$$,
  'function:private.leak_probe_network_rating');
\o /dev/null
drop function private.leak_probe_network_rating();
\o
select leak.val('LE2c ...and the probe is gone, so LE1''s 0 stands for the shipped schema',
  $$select count(*)::text from leak.network_surface_wide where body ~* 'rating'$$, '0');

-- THE TABLE ITSELF DOES NOT EXIST, WITH A DENOMINATOR. The forward guard is
-- only forward while that stays true; the day it lands, LE3 goes red and
-- whoever lands it must read LE1 rather than re-run it.
select leak.val('LE3 public.ratings does not exist (the guard is FORWARD, Q85)',
  $$select count(*)::text from pg_catalog.pg_class
     where relnamespace='public'::regnamespace and relname='ratings'$$, '0');
select leak.val('LE3b DENOMINATOR: the same query DOES see the schema''s relations',
  $$select (count(*) >= 30)::text from pg_catalog.pg_class
     where relnamespace='public'::regnamespace and relkind in ('r','v')$$, 'true');

-- ===========================================================================
-- LF. THE FUNCTION-BODY DEPTH GUARD -- TASK 1 LEDGER ITEM I1.
--
-- ===========================================================================
-- WHAT I1 LEFT OPEN, IN ITS OWN WORDS
-- ===========================================================================
-- "the I1 fix widens the guard's reach but not its depth -- function BODIES are
-- unexamined; a helper the connected view calls could read a private table."
--
-- rls_phase6_network.sql § ND3d asserts network_connected_profiles calls
-- EXACTLY private.permitted_organisations. That is a statement about the view's
-- pg_depend row and nothing else: if permitted_organisations were rewritten
-- tomorrow to left-join public.notes, ND3d would still say "1" and still be
-- green, and the connected view would be reading a private table.
--
-- ===========================================================================
-- WHAT THIS SECTION DOES ABOUT IT, AND WHAT IT DOES NOT
-- ===========================================================================
-- It builds the TRANSITIVE CLOSURE of functions reachable from the two masking
-- views -- seeded from pg_depend (which records a view's direct function
-- calls) and expanded by schema-qualified NAME MATCH over the bodies, which is
-- sound here because every function in `public`/`private` sets search_path=''
-- and therefore MUST schema-qualify everything it calls -- and asserts that no
-- body in the closure names a tenant-private relation.
--
-- THE BOUND, STATED (Constraint 13). This closes I1 for the DISCOVERY PATH,
-- which is what N2 is about and what the ledger item names. It deliberately
-- does NOT sweep the functions the network WRITE policies call
-- (private.entity_is_manageable resolves entity_id against companies/artists/
-- venues/agencies BY DESIGN and would be a false positive), because a write
-- policy is not a discovery path: nothing it reads is returned to the caller.
-- LF4 states that exclusion as a measurement.
--
-- Name matching over a body is a TEXT test, so a private relation named only
-- inside a comment would be a false POSITIVE. That is the safe direction and
-- is left as-is on purpose.
-- ===========================================================================
\o /dev/null
create view leak.view_seed_fns as
  select p.oid, n.nspname, p.proname
    from pg_catalog.pg_class v
    join pg_catalog.pg_rewrite rw on rw.ev_class = v.oid
    join pg_catalog.pg_depend d
      on d.objid = rw.oid and d.classid = 'pg_catalog.pg_rewrite'::regclass
     and d.refclassid = 'pg_catalog.pg_proc'::regclass
    join pg_catalog.pg_proc p on p.oid = d.refobjid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where v.relkind = 'v'
     and v.relname in ('network_directory','network_connected_profiles',
                       'leak_probe_view_over_fn');

create view leak.fn_closure as
  with recursive walk as (
    select p.oid,
           n.nspname || '.' || p.proname as fqn,
           pg_catalog.pg_get_functiondef(p.oid) as body
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where p.oid in (select oid from leak.view_seed_fns)
    union
    select q.oid,
           qn.nspname || '.' || q.proname,
           pg_catalog.pg_get_functiondef(q.oid)
      from walk w
      join pg_catalog.pg_proc q on q.prokind = 'f'
      join pg_catalog.pg_namespace qn on qn.oid = q.pronamespace
     where qn.nspname in ('public','private')
       and q.oid <> w.oid
       and w.body ~ ('\m' || qn.nspname || '\.' || q.proname || '\M')
  )
  select fqn, body from walk;

-- The needle set: every tenant-private relation, plus the ones that do not
-- exist yet (ratings) and the two aggregate views over private data, which are
-- exactly what N2's own header names as the plausible future edit.
create table leak.private_rel (rel text primary key);
insert into leak.private_rel (rel)
select unnest(array[
  'contacts','companies','artists','venues','venue_rooms','agencies',
  'contact_companies','events','event_lineup','event_status_changes',
  'tasks','meetings','notes','documents','document_versions',
  'financial_entries','custom_field_values','task_links','meeting_links',
  'note_links','document_links','audit_events','activity_events',
  'event_finance_summary','merges','merge_candidates','ratings','feedback'
]);
grant select on leak.private_rel to authenticated;
\o

select leak.val('LF1 I1 CLOSED: no function reachable from either masking view names a private relation',
  $$select count(*)::text from leak.fn_closure f
     join leak.private_rel r on f.body ~ ('\mpublic\.' || r.rel || '\M')$$, '0');
select leak.val('LF1b DENOMINATOR: 28 private relation names were the needle set',
  $$select count(*)::text from leak.private_rel$$, '28');
-- FOUR, AND THE FOURTH IS THE FALSE POSITIVE THIS SECTION'S HEADER PROMISED,
-- MEASURED RATHER THAN HYPOTHETICAL. private.permitted_organisations' body
-- carries the comment "-- Q6, mirrored from public.has_permission.", and a
-- TEXT closure cannot tell a comment from a call. public.has_permission is
-- pulled in, read, and found to name no private relation -- so the guard is
-- one function wider than the call graph and no weaker for it. Over-inclusion
-- is the safe direction and is left as-is on purpose.
select leak.val('LF2 DENOMINATOR: the closure, by name -- these are the bodies that were read',
  $$select count(*)::text || ':' || string_agg(fqn, ',' order by fqn) from leak.fn_closure$$,
  '4:private.permitted_organisations,private.role_requires_mfa,'
  'private.session_is_aal2,public.has_permission');
-- THE DEPTH ASSERTION. private.role_requires_mfa is NOT a pg_depend child of
-- either view -- it is reached only by reading permitted_organisations' body.
-- Its presence is the measurable difference between § ND's reach and this
-- section's depth, and it is the whole of ledger item I1.
select leak.val('LF2b DEPTH: the closure reaches a function NEITHER view depends on directly',
  $$select ((select count(*) from leak.fn_closure where fqn='private.role_requires_mfa') = 1
            and (select count(*) from leak.view_seed_fns
                  where nspname='private' and proname='role_requires_mfa') = 0)::text$$,
  'true');
select leak.val('LF2c ...and the seed really is the two views'' direct calls, and only that',
  $$select string_agg(nspname || '.' || proname, ',' order by nspname || '.' || proname)
      from leak.view_seed_fns$$, 'private.permitted_organisations');

-- THE PLANTED POSITIVE CONTROL: a helper that reads a private table, called by
-- a view, is exactly the shape I1 describes. It is caught.
\o /dev/null
create function private.leak_probe_private_reader() returns bigint
  language sql stable set search_path = '' as $$
  select count(*) from public.notes;
$$;
create view leak.leak_probe_view_over_fn as
  select private.leak_probe_private_reader() as n;
\o
select leak.val('LF3 POSITIVE CONTROL: a view-called helper that reads public.notes IS flagged',
  $$select count(*)::text from leak.fn_closure f
     join leak.private_rel r on f.body ~ ('\mpublic\.' || r.rel || '\M')$$, '1');
select leak.val('LF3b ...and flagged BY NAME and BY RELATION, so LF3 is not some other object',
  $$select f.fqn || ' -> public.' || r.rel from leak.fn_closure f
     join leak.private_rel r on f.body ~ ('\mpublic\.' || r.rel || '\M')$$,
  'private.leak_probe_private_reader -> public.notes');
\o /dev/null
drop view leak.leak_probe_view_over_fn;
drop function private.leak_probe_private_reader();
\o
select leak.val('LF3c ...and the probe is gone, so LF1''s 0 stands for the shipped schema',
  $$select count(*)::text from leak.fn_closure f
     join leak.private_rel r on f.body ~ ('\mpublic\.' || r.rel || '\M')$$, '0');

-- THE STATED BOUND. The write policies' helper DOES read private tables, by
-- design, and is outside this closure -- recorded as a measurement so the
-- exclusion cannot be read as an omission.
select leak.val('LF4 STATED BOUND: entity_is_manageable DOES read private tables, and is NOT in the discovery closure',
  $$select ((select count(*) from pg_catalog.pg_proc p
              join pg_catalog.pg_namespace n on n.oid=p.pronamespace
             where n.nspname='private' and p.proname='entity_is_manageable'
               and pg_catalog.pg_get_functiondef(p.oid) ~ '\mpublic\.companies\M') = 1
            and (select count(*) from leak.fn_closure
                  where fqn='private.entity_is_manageable') = 0)::text$$, 'true');

-- ===========================================================================
-- LG. THE IDENTIFIER-DISCLOSURE PROBE.
--
-- rls_phase6_network.sql NC4 asserts the two views do not PROJECT
-- organisation_id or entity_id. That is a statement about column names. This
-- is the statement about VALUES: no value of any column the directory does
-- expose is a uuid that names one of ALPHA's private rows. A display_name
-- carrying a contact's id, or a headline built by a well-meaning migration out
-- of `id::text`, would pass NC4 and hand a counterparty an enumeration key.
-- ===========================================================================
\o /dev/null
create table leak.private_ids (id uuid primary key, src text not null);
insert into leak.private_ids (id, src)
select id, 'contacts'   from public.contacts   where organisation_id = :'alpha_org'
union all select id, 'companies' from public.companies where organisation_id = :'alpha_org'
union all select id, 'artists'   from public.artists   where organisation_id = :'alpha_org'
union all select id, 'venues'    from public.venues    where organisation_id = :'alpha_org'
union all select id, 'agencies'  from public.agencies  where organisation_id = :'alpha_org'
union all select id, 'events'    from public.events    where organisation_id = :'alpha_org'
union all select id, 'notes'     from public.notes     where organisation_id = :'alpha_org'
union all select id, 'documents' from public.documents where organisation_id = :'alpha_org'
union all select id, 'tasks'     from public.tasks     where organisation_id = :'alpha_org'
union all select id, 'meetings'  from public.meetings  where organisation_id = :'alpha_org'
union all select id, 'financial_entries' from public.financial_entries
      where organisation_id = :'alpha_org'
on conflict (id) do nothing;
grant select on leak.private_ids to authenticated;

-- security_invoker, and it is NOT decoration: without it this view would run
-- as its owner (postgres), RLS would not apply to network_directory
-- underneath, and § LG's counterparty probes would be reading every row in the
-- database through a test helper. The same single-gate reasoning
-- 20260904004000 gives for the two shipped views.
create view leak.directory_values with (security_invoker = true) as
  select d.id as profile_id, v.col, v.val
    from public.network_directory d
    cross join lateral (values
      ('id',            d.id::text),
      ('entity_kind',   d.entity_kind),
      ('display_name',  d.display_name),
      ('headline',      d.headline),
      ('bio',           d.bio),
      ('city',          d.city),
      ('region',        d.region),
      ('country',       d.country),
      ('website_url',   d.website_url),
      ('contact_email', d.contact_email),
      ('published_at',  d.published_at::text)
    ) v(col, val);
grant select on leak.directory_values to authenticated;
\o

select leak.val('LG0 DENOMINATOR: ALPHA''s private id set is non-empty, and this is its size',
  $$select (count(*) >= 50)::text from leak.private_ids$$, 'true');

set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LG1 DENOMINATOR: values inspected across the directory (11 per visible row, non-zero)',
  $$select (count(*) >= 11)::text from leak.directory_values$$, 'true');
select leak.val('LG2 THE FINDING: NO value of any directory column is one of ALPHA''s private row ids',
  $$select count(*)::text from leak.directory_values v
     where v.val in (select id::text from leak.private_ids)$$, '0');
reset role; reset request.jwt.claims;

-- THE PLANTED POSITIVE CONTROL. `headline` is at `network` on ALPHA's profile,
-- so a value put there really is visible to a counterparty -- which is exactly
-- why this is the shape worth catching. Planted as postgres (the CHECK still
-- applies; RLS does not) and reverted immediately.
\o /dev/null
update public.network_profiles
   set headline = '11110000-0000-0000-0000-000000000002'
 where id = 'e0110000-0000-0000-0000-00000000000a';
\o
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LG3 POSITIVE CONTROL: a private id planted in a `network` field IS caught',
  $$select count(*)::text from leak.directory_values v
     where v.val in (select id::text from leak.private_ids)$$, '1');
select leak.val('LG3b ...and named, with the column and the private table it came from',
  $$select v.col || '=' || p.src from leak.directory_values v
     join leak.private_ids p on p.id::text = v.val$$, 'headline=companies');
reset role; reset request.jwt.claims;
\o /dev/null
update public.network_profiles
   set headline = 'Independent promoter'
 where id = 'e0110000-0000-0000-0000-00000000000a';
\o
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LG3c ...and reverted, so LG2''s 0 stands for the shipped fixture',
  $$select count(*)::text from leak.directory_values v
     where v.val in (select id::text from leak.private_ids)$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LH. THE entity_id INFERENCE PROBE.
--
-- network_profiles.entity_id names one of ALPHA's private records and sits on
-- the deliberately-readable base table (LB6b measured it). What must hold is
-- that neither VIEW hands it over -- so a counterparty who only ever reads the
-- sanctioned path cannot enumerate ALPHA's companies ids from the directory.
-- Asserted as the ERROR a select of it raises, not merely as an absent column
-- name: 42703 is what a caller actually meets.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LH1 selecting entity_id from the directory is an UNDEFINED COLUMN, not a value',
  $$select entity_id::text from public.network_directory limit 1$$, 'denied(42703)');
select leak.val('LH1b ...and organisation_id likewise',
  $$select organisation_id::text from public.network_directory limit 1$$, 'denied(42703)');
select leak.val('LH1c ...and both on the CONNECTED view too, which Task 1 asserted only for the directory',
  $$select entity_id::text from public.network_connected_profiles limit 1$$, 'denied(42703)');
select leak.val('LH2 CONTROL: a column the view DOES project selects fine (LH1 is the column list talking)',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
-- The inference the column would enable, closed at the value layer as well:
-- ALPHA's company id appears nowhere in any directory row this caller can see.
select leak.val('LH3 ALPHA''s entity_id appears in NO value of any directory row',
  $$select count(*)::text from leak.directory_values
     where val = '11110000-0000-0000-0000-000000000002'$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LI. THE DOWNGRADE PROBE (Q81) -- BOTH HALVES.
--
-- "Downgrading a subscription makes features read-only or limited; it must
-- never silently delete data" (CLAUDE.md § Permissions). For the network that
-- means two things at once, and asserting only the second is how a product
-- ends up quietly unpublishing a paying customer's profile on a billing blip:
--
--   (i)  ALPHA's published profile STAYS in the counterparty's directory.
--   (ii) EVERY ALPHA network write refuses, loudly (42501, never a silent 204).
--
-- rls_phase6_network.sql § NT proves the gate bites for ALPHA's own writes.
-- Half (i) -- what the OUTSIDE sees -- is new here.
-- ===========================================================================
\o /dev/null
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org', 'free', 'monthly', 1, 'active', now() + interval '30 days')
on conflict (organisation_id) do update set plan_id='free', status='active';
\o

set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LI1 DOWNGRADE (i): ALPHA''s published profile is STILL in the counterparty''s directory',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select leak.val('LI1b ...with its `network` fields still resolving -- nothing was hidden or deleted',
  $$select city || '|' || headline from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Bristol|Independent promoter');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LI2 DOWNGRADE: ALPHA still READS its own profile (a downgrade never blinds you)',
  $$select display_name from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select leak.try('LI3 DOWNGRADE (ii): a new profile INSERT refuses 42501 (loud, not a silent 0)',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name)
           values (%L,'company','11110000-0000-0000-0000-000000000002','Free Tier Attempt')$$,
         :'alpha_org'), 'denied(42501)');
select leak.try('LI3b ...an UPDATE of the existing profile refuses 42501 (the term is in WITH CHECK)',
  $$update public.network_profiles set headline='Free Tier Edit'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'denied(42501)');
select leak.try('LI3c ...a network_link INSERT refuses 42501',
  format($$insert into public.network_links
             (organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values (%L,'e0110000-0000-0000-0000-00000000000b','venue',
                   '55550000-0000-0000-0000-000000000001')$$, :'alpha_org'), 'denied(42501)');
select leak.try('LI3d ...and a connection request INSERT refuses 42501',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'denied(42501)');
select leak.val('LI4 CONTROL: after the four refusals the profile''s headline is UNCHANGED',
  $$select headline from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Independent promoter');
reset role; reset request.jwt.claims;

-- BACK TO STARTER: the same statement that just refused now succeeds, so LI3
-- is the PLAN talking and not a broken write path.
\o /dev/null
update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'alpha_org';
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.try('LI5 CONTROL: on STARTER the SAME update succeeds (the gate is the plan, not a door)',
  $$update public.network_profiles set headline='Independent promoter'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
delete from public.organisation_subscriptions where organisation_id = :'alpha_org';
\o

-- ===========================================================================
-- LJ. THE SUSPENSION PROBE -- MEASURED AND RECORDED.
--
-- ===========================================================================
-- READ THIS BEFORE READING THE EXPECTATIONS BELOW
-- ===========================================================================
-- The expectations in this section are a RECORD OF MEASURED BEHAVIOUR, not a
-- claim that the behaviour is right. The Task 5 brief asks for the answer to
-- one question -- "what does a COUNTERPARTY see of a suspended organisation's
-- published profile" -- and asks for it to be stated rather than left
-- undiscovered. .superpowers/sdd/phase-6-network/task-5-report.md § "The
-- suspension answer" carries the finding and FOLLOW-UPS.md carries the
-- decision it needs.
--
-- THE MEASUREMENT, IN ONE PARAGRAPH. All three network permission keys are
-- survives_suspension = false (20260904002000), so a suspended organisation's
-- own members lose view_network -- and with it their own network_profiles rows
-- and their network_links. But
-- network_profiles_select_published_directory does NOT ask for view_network:
-- it asks for `status='published' and deleted_at is null` plus an ACTIVE
-- MEMBERSHIP OF ANY ORGANISATION (20260904003000), and neither term consults
-- public.organisations.deleted_at. So:
--
--   * a counterparty STILL sees a suspended organisation's published profile;
--   * a suspended organisation's OWN members still see the directory, and
--     still see their own PUBLISHED profiles through that same directory
--     policy -- while losing their DRAFTS and their links.
--
-- The second half CONTRADICTS a shipped comment (20260904002000:41-45, "a
-- suspended organisation's members cannot browse the directory or read their
-- own network profiles until the workspace is reinstated"). That is Task 1
-- ledger items M2/M3. THIS SUITE DOES NOT CHANGE THE POLICY: a one-clause
-- change to the directory predicate is a product decision, not a test's.
-- ===========================================================================
\o /dev/null
update public.organisations set deleted_at = now() where id = :'alpha_org';
\o

set role authenticated;
set request.jwt.claims = :'pgmgr_c1';
select leak.val('LJ1 THE ANSWER (measured): a COUNTERPARTY STILL sees a SUSPENDED org''s published profile',
  $$select display_name from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select leak.val('LJ1b ...with its `network` fields still resolving',
  $$select city from public.network_directory
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Bristol');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbmgr_c1';
select leak.val('LJ2 ...and a CONNECTED counterparty still resolves its `connections` fields too',
  $$select contact_email from public.network_connected_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'bookings@alpha.test');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LJ3 the suspended org''s OWN member has LOST view_network (survives_suspension=false)',
  format($$select (%L::uuid in (select private.permitted_organisations('view_network')))::text$$,
         :'alpha_org'), 'false');
select leak.val('LJ3b CONTROL: ...while KEEPING view_crm, which is the one key that survives',
  format($$select (%L::uuid in (select private.permitted_organisations('view_crm')))::text$$,
         :'alpha_org'), 'true');
select leak.val('LJ4 CONSEQUENCE: it loses its own DRAFT profile',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000d'$$, '0');
select leak.val('LJ4b CONSEQUENCE: ...and its network_links',
  $$select count(*)::text from public.network_links$$, '0');
-- M2, MEASURED. The shipped comment says the opposite of both of these.
select leak.val('LJ5 M2 (measured, contradicts 20260904002000:41-45): it STILL browses the directory',
  $$select (count(*) >= 1)::text from public.network_directory$$, 'true');
select leak.val('LJ5b M2: ...and STILL reads its own PUBLISHED profile, through the directory policy',
  $$select display_name from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Alpha Promotions');
select leak.val('LJ6 CONSEQUENCE: and it can no longer WRITE its profile (the USING clause filters it)',
  $$select count(*)::text from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'
       and organisation_id in (select private.permitted_organisations('manage_network_profile'))$$,
  '0');
reset role; reset request.jwt.claims;

\o /dev/null
update public.organisations set deleted_at = null where id = :'alpha_org';
\o
select leak.val('LJ7 HOUSEKEEPING: ALPHA is reinstated, so nothing downstream meets a suspended org',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'alpha_org'), 'true');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LJ7b ...and view_network came back with the workspace',
  format($$select (%L::uuid in (select private.permitted_organisations('view_network')))::text$$,
         :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- LK. THE aal1 PROBE.
--
-- MFA is REQUIRED for Owner (CLAUDE.md § Session security) and
-- private.permitted_organisations folds the check in for every key
-- (20260827210000). So an Owner on a password-only session holds NONE of the
-- three network keys, and the same Owner at aal2 holds all three. Both sides
-- asserted, because a gate that never opens and a gate that never closes both
-- pass a one-sided test.
--
-- NOTE THE TWO REFUSAL SHAPES, and that the difference is deliberate: an
-- INSERT refusal is a loud 42501 (the WITH CHECK), while an UPDATE refusal is
-- `ok(0)` -- the USING clause simply filters the row out, and PostgREST turns
-- that into a 204 No Content that looks exactly like success. LK4 measures the
-- quiet one so the report can say which surface owes the `{count:"exact"}`
-- discipline (Constraint 6).
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'powner_c1';
select leak.val('LK1 an aal1 OWNER holds 0 of the 3 network keys',
  format($$select (
      (case when %L::uuid in (select private.permitted_organisations('view_network')) then 1 else 0 end) +
      (case when %L::uuid in (select private.permitted_organisations('manage_network_profile')) then 1 else 0 end) +
      (case when %L::uuid in (select private.permitted_organisations('manage_network_connections')) then 1 else 0 end)
    )::text$$, :'alpha_org', :'alpha_org', :'alpha_org'), '0');
-- THE TARGET IS AN ALPHA AGENCY WITH NO LIVE PROFILE, AND THAT IS NOT
-- ARBITRARY: network_profiles_org_entity_unique is a partial unique index on
-- (organisation_id, entity_kind, entity_id) where deleted_at is null, so
-- aiming LK3b at a record ALPHA has already published would answer 23505 and
-- prove nothing about the MFA gate. Every ALPHA company/venue/artist is
-- already spoken for by an earlier suite; this agency is not.
select leak.try('LK2 an aal1 OWNER''s profile INSERT is a loud 42501',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name)
           values ('e0110000-0000-0000-0000-0000000000fb', %L,'agency',
                   '33330000-0000-0000-0000-000000000002','aal1 attempt')$$,
         :'alpha_org'), 'denied(42501)');
select leak.try('LK4 an aal1 OWNER''s profile UPDATE is the QUIET shape -- ok(0), a 204 over HTTP',
  $$update public.network_profiles set headline='aal1 edit'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(0)');
-- The same aal1 owner still READS the row -- through the directory policy,
-- which asks only for an active membership -- so LK4's 0 is the WRITE policy's
-- USING clause and not an invisible row, and the value it did not change is
-- legible right here.
select leak.val('LK4b CONTROL: the headline is unchanged, so LK4''s ok(0) really wrote nothing',
  $$select headline from public.network_profiles
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'Independent promoter');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select leak.val('LK3 CONTROL: the SAME owner at aal2 holds 3 of the 3',
  format($$select (
      (case when %L::uuid in (select private.permitted_organisations('view_network')) then 1 else 0 end) +
      (case when %L::uuid in (select private.permitted_organisations('manage_network_profile')) then 1 else 0 end) +
      (case when %L::uuid in (select private.permitted_organisations('manage_network_connections')) then 1 else 0 end)
    )::text$$, :'alpha_org', :'alpha_org', :'alpha_org'), '3');
select leak.try('LK3b CONTROL: ...and the SAME INSERT succeeds',
  format($$insert into public.network_profiles
             (id, organisation_id, entity_kind, entity_id, display_name)
           values ('e0110000-0000-0000-0000-0000000000fb', %L,'agency',
                   '33330000-0000-0000-0000-000000000002','aal2 control')$$,
         :'alpha_org'), 'ok(1)');
select leak.val('LK3c ...and it landed as a DRAFT, so it never enters the directory',
  $$select status from public.network_profiles
     where id='e0110000-0000-0000-0000-0000000000fb'$$, 'draft');
reset role; reset request.jwt.claims;
\o /dev/null
delete from public.network_profiles where id='e0110000-0000-0000-0000-0000000000fb';
\o

-- ===========================================================================
-- LW. THE COUNTERPARTY WRITE PROBES.
--
-- The read matrix answers "what can they see". This answers "what can they
-- do", which is the other half of a breakout and the half a reader assumes
-- somebody covered. Every one is driven as the CONNECTED counterparty, the
-- strictly stronger case: if the accepted connection granted anything, it
-- would show here.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pbmgr_c';
select leak.try('LW1 CONNECTED counterparty cannot UPDATE ALPHA''s published profile',
  $$update public.network_profiles set headline='taken over'
     where id='e0110000-0000-0000-0000-00000000000a'$$, 'ok(0)');
select leak.try('LW2 ...cannot INSERT a profile into ALPHA',
  format($$insert into public.network_profiles
             (organisation_id, entity_kind, entity_id, display_name)
           values (%L,'company','11110000-0000-0000-0000-000000000002','planted')$$,
         :'alpha_org'), 'denied(42501)');
select leak.try('LW3 ...cannot INSERT a contact into ALPHA',
  format($$insert into public.contacts (organisation_id, name)
           values (%L,'planted by the counterparty')$$, :'alpha_org'), 'denied(42501)');
select leak.try('LW4 ...cannot INSERT a note into ALPHA',
  format($$insert into public.notes (organisation_id, body, visibility)
           values (%L,'planted','company')$$, :'alpha_org'), 'denied(42501)');
select leak.try('LW5 ...cannot link one of ALPHA''s private records to a profile',
  format($$insert into public.network_links
             (organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a','company',
                   '11110000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'denied(42501)');
select leak.try('LW6 ...and cannot forge a request FROM ALPHA to itself',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id,
              to_organisation_id, to_network_profile_id)
           values (%L,'e0110000-0000-0000-0000-00000000000a',
                   %L,'e0110000-0000-0000-0000-00000000000b')$$,
         :'alpha_org', :'beta_org'), 'denied(42501)');
-- THE POSITIVE CONTROL IS A network_link AND THE TABLE CHOICE IS DELIBERATE.
-- The obvious control -- insert a contact into BETA -- would fire
-- private.audit_crm_row and add a row to public.activity_events, and the HTTP
-- block downstream carries censuses of both (its "activity timeline" and
-- "dedup and merge" sections). public.network_links emits NO audit row on
-- purpose (rls_phase6_network.sql NX4) and is not an activity source, so this
-- proves the caller's writes work while leaving nothing for a later assertion
-- to trip over. It is also the on-topic write: BETA filing ALPHA's published
-- profile against one of its own records is the exact act Q82 keeps private.
select leak.try('LW7 CONTROL: the same caller CAN write in its OWN organisation (LW1-LW6 are boundaries)',
  format($$insert into public.network_links
             (id, organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values ('d0110000-0000-0000-0000-0000000000fa', %L,
                   'e0110000-0000-0000-0000-00000000000a',
                   'company','1111000b-0000-0000-0000-00000000000b')$$,
         :'beta_org'), 'ok(1)');
select leak.val('LW7b ...and ALPHA, whose profile was just filed, still sees 0 links to it (Q82 again)',
  $$select count(*)::text from public.network_links
     where network_profile_id='e0110000-0000-0000-0000-00000000000a'$$, '1');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select leak.val('LW7c Q82: ALPHA -- the profile''s OWNER -- sees 0 of that 1 link',
  $$select count(*)::text from public.network_links
     where network_profile_id='e0110000-0000-0000-0000-00000000000a'$$, '0');
reset role; reset request.jwt.claims;
\o /dev/null
delete from public.network_links where id='d0110000-0000-0000-0000-0000000000fa';
\o
select leak.val('LW7d HOUSEKEEPING: LW7''s control row is removed (network_links is back to 1)',
  $$select count(*)::text from public.network_links$$, '1');

-- ===========================================================================
-- LZ. HOUSEKEEPING -- WHAT THIS FILE LEAVES STANDING, AND WHY.
--
-- It leaves the third organisation and the two counterparty memberships,
-- deliberately: the HTTP block at the bottom of run-rls-tests.sh signs in as
-- both counterparties and drives the same matrix over PostgREST, and a fixture
-- torn down here would have to be rebuilt there in a second, drifting copy.
--
-- What it MUST NOT leave is anything the HTTP checks upstream of it were
-- written against. Two things matter and both are asserted:
--   * GAMMA publishes NO network profile, so the Task 1 HTTP block's "all four
--     published profiles" counts are unmoved.
--   * ALPHA has no organisation_subscriptions row (§ LI planted and removed
--     one), so the Task 1 HTTP tier block starts from the state it expects.
-- ===========================================================================
select leak.val('LZ1 GAMMA publishes NO network profile (the "4 published profiles" HTTP counts are unmoved)',
  format($$select count(*)::text from public.network_profiles where organisation_id=%L$$,
         :'gamma_org'), '0');
select leak.val('LZ1b CONTROL: the whole schema still holds exactly 4 published, live profiles',
  $$select count(*)::text from public.network_profiles
     where status='published' and deleted_at is null$$, '4');
select leak.val('LZ2 this file left no ALPHA organisation_subscriptions row behind',
  format($$select count(*)::text from public.organisation_subscriptions where organisation_id=%L$$,
         :'alpha_org'), '0');
select leak.val('LZ3 GAMMA owns no tenant rows of any kind -- it is a viewer, not a fixture tenant',
  format($$select (
      (select count(*) from public.contacts where organisation_id=%L) +
      (select count(*) from public.companies where organisation_id=%L) +
      (select count(*) from public.events where organisation_id=%L) +
      (select count(*) from public.network_links where organisation_id=%L)
    )::text$$, :'gamma_org', :'gamma_org', :'gamma_org', :'gamma_org'), '0');
select leak.val('LZ4 ALPHA''s published profile is byte-identical to how § LB found it',
  $$select display_name || '|' || headline || '|' || city || '|' || bio || '|' || contact_email
      from public.network_profiles where id='e0110000-0000-0000-0000-00000000000a'$$,
  'Alpha Promotions|Independent promoter|Bristol|Twenty years of shows|bookings@alpha.test');

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 6 NETWORK-LEAKAGE SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from leak.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from leak.results;
