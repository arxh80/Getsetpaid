-- PHASE 8 TASK 8 MUTANT 15-03-crm-audit-event-lineup
-- guard:  the Task 7 audit triggers on public.event_lineup
-- change: dropped (audit_insert, audit_update and audit_delete where present)
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
drop trigger if exists audit_insert on public.event_lineup;
drop trigger if exists audit_update on public.event_lineup;
drop trigger if exists audit_delete on public.event_lineup;
