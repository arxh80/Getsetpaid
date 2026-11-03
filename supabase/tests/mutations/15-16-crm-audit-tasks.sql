-- PHASE 8 TASK 8 MUTANT 15-16-crm-audit-tasks
-- guard:  the Task 7 audit triggers on public.tasks
-- change: dropped (audit_insert, audit_update and audit_delete where present)
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
drop trigger if exists audit_insert on public.tasks;
drop trigger if exists audit_update on public.tasks;
drop trigger if exists audit_delete on public.tasks;
