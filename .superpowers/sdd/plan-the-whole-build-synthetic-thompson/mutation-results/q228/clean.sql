-- Q228 mutation run: remove anything a qp run left behind before the next one.
-- rls_q228_closure_backup_parts.sql removes its own fixtures in QZ, but a mutant that
-- aborts the suite before QZ would leave them, and QZ1 then counts `qp-%` slugs.
-- Part rows first: `replica` turns off the FK cascade.
set session_replication_role = replica;
delete from public.export_job_parts p using public.export_jobs j
 where j.id = p.job_id
   and (j.organisation_id in (select id from public.organisations where slug like 'qp-%')
        or j.requested_by in (select id from auth.users where email like 'qp-%@test.local'));
delete from public.export_jobs
 where organisation_id in (select id from public.organisations where slug like 'qp-%')
    or requested_by in (select id from auth.users where email like 'qp-%@test.local');
delete from public.audit_events
 where organisation_id in (select id from public.organisations where slug like 'qp-%')
    or actor_user_id in (select id from auth.users where email like 'qp-%@test.local');
delete from public.organisation_memberships where organisation_id in (select id from public.organisations where slug like 'qp-%');
delete from public.organisation_subscriptions where organisation_id in (select id from public.organisations where slug like 'qp-%');
delete from public.organisations where slug like 'qp-%';
set session_replication_role = origin;
delete from public.platform_admins where user_id in (select id from auth.users where email like 'qp-%@test.local');
delete from auth.users where email like 'qp-%@test.local';
select count(*) from public.organisations where slug like 'qp-%';
