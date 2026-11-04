-- ============================================================================
-- PHASE 10 TASK 16 (G29): THE VOLUME THE LIST PLANS ARE MEASURED AGAINST.
--
-- Run by supabase/tests/perf/run.sh on a FRESH reset, never inside the RLS
-- runner (whose dirty-database preflight would refuse the next run), and the
-- database is reset again afterwards. Do not run it against hosted.
--
--   * one tenant ("perf-volume") whose member is the caller every plan in
--     list-plans.sql is explained as, with 50,000 rows in each hot list table;
--   * a second tenant ("perf-network") publishing 20,000 network profiles,
--     which the first tenant's member reaches through network_directory.
--
-- The two users and both organisations go through the real paths (an
-- auth.users insert and create_organisation()), so memberships,
-- subscriptions and presence are what the app would see. The bulk rows are
-- written with session_replication_role = replica: the audit, rate-limit and
-- notification triggers would otherwise write 550,000 side rows and refuse
-- the volume, and none of them changes a list read's plan.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

\set member    '00000000-0000-4000-8000-00000000f001'
\set publisher '00000000-0000-4000-8000-00000000f002'
\set rows      50000
\set profiles  20000

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, email_confirmed_at)
values
  (:'member',    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perf-member@perf.test',    now(), now(), now()),
  (:'publisher', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perf-publisher@perf.test', now(), now(), now());

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'member', 'role', 'authenticated', 'aal', 'aal2')::text, false);
select public.create_organisation('Perf Volume', 'perf-volume');
select set_config('request.jwt.claims',
  json_build_object('sub', :'publisher', 'role', 'authenticated', 'aal', 'aal2')::text, false);
select public.create_organisation('Perf Network', 'perf-network');
reset role;
reset request.jwt.claims;

select id as org from public.organisations where slug = 'perf-volume' \gset
select id as net from public.organisations where slug = 'perf-network' \gset

begin;
set local session_replication_role = replica;

-- Names carry a per-row hash so a search term matches a realistic handful of
-- rows rather than all of them or none.
insert into public.contacts (organisation_id, owner_user_id, name, email)
select :'org', :'member', 'Contact ' || md5(g::text), 'c' || g || '@perf.test'
from generate_series(1, :rows) g;

insert into public.companies (organisation_id, owner_user_id, name)
select :'org', :'member', 'Company ' || md5(g::text) from generate_series(1, :rows) g;

insert into public.artists (organisation_id, owner_user_id, name)
select :'org', :'member', 'Artist ' || md5(g::text) from generate_series(1, :rows) g;

insert into public.venues (organisation_id, owner_user_id, name)
select :'org', :'member', 'Venue ' || md5(g::text) from generate_series(1, :rows) g;

insert into public.agencies (organisation_id, owner_user_id, name)
select :'org', :'member', 'Agency ' || md5(g::text) from generate_series(1, :rows) g;

insert into public.events (organisation_id, owner_user_id, name, starts_at)
select :'org', :'member', 'Event ' || md5(g::text), now() + (g % 2000 - 1000) * interval '1 day'
from generate_series(1, :rows) g;

insert into public.tasks (organisation_id, owner_user_id, title, created_at)
select :'org', :'member', 'Task ' || md5(g::text), now() - g * interval '1 minute'
from generate_series(1, :rows) g;

insert into public.meetings (organisation_id, owner_user_id, title, starts_at)
select :'org', :'member', 'Meeting ' || md5(g::text), now() + (g % 2000 - 1000) * interval '1 day'
from generate_series(1, :rows) g;

insert into public.notes (organisation_id, owner_user_id, body, visibility, created_at)
select :'org', :'member', 'Note ' || md5(g::text) || ' about the rider and the load-in',
       'company', now() - g * interval '1 minute'
from generate_series(1, :rows) g;

insert into public.documents (organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes, created_at)
select :'org', :'member', 'doc-' || md5(g::text) || '.pdf', :'org' || '/' || gen_random_uuid(),
       'application/pdf', 1024, now() - g * interval '1 minute'
from generate_series(1, :rows) g;

insert into public.network_profiles
  (organisation_id, entity_kind, entity_id, display_name, status, published_at)
select :'net', 'company', gen_random_uuid(), 'Profile ' || md5(g::text), 'published', now()
from generate_series(1, :profiles) g;

commit;

analyze public.contacts, public.companies, public.artists, public.venues, public.agencies,
        public.events, public.tasks, public.meetings, public.notes, public.documents,
        public.network_profiles;
