-- PHASE 8 TASK 8 MUTANT 15-09-crm-audit-network-links
-- guard:  the Task 7 audit triggers on public.network_links
-- change: dropped (audit_insert, audit_update and audit_delete where present)
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
drop trigger if exists audit_insert on public.network_links;
drop trigger if exists audit_update on public.network_links;
drop trigger if exists audit_delete on public.network_links;
