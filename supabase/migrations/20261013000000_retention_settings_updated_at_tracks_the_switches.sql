-- Phase 8 Task 9a fix round 1, review finding m2: retention_settings.updated_at
-- MEANS "THE KILL SWITCHES LAST CHANGED" AGAIN, SO THE PANEL'S "Last changed"
-- LINE IS TRUE AFTER A CEILING RELEASE.
--
-- 20261003010000 attached set_updated_at to public.retention_settings as a
-- plain BEFORE UPDATE trigger. 20261010000000 then added the three
-- audit_ceiling_* columns, written by public.release_audit_purge_ceiling(),
-- and that UPDATE fired the trigger too. The /super/health retention panel
-- (components/admin/retention-panel.tsx) renders
--   Last changed <updated_at> -- "<the switches' reason>"
-- so after a release it paired the RELEASE's time with the switches' OLD
-- reason (or, on a never-changed deployment, said "(never changed)" beside a
-- fresh time). 20261010000000's header acknowledged the new meaning but the
-- panel was not adjusted. The audit log was always right.
--
-- THE FIX IS THE TRIGGER'S COLUMN LIST, NOT A NEW COLUMN. The trigger now
-- fires only on an UPDATE whose SET list names a kill-switch column
-- (enabled, audit_purge_enabled, reason, updated_by) -- the columns
-- public.set_retention_enabled() writes and the columns `updated_at` and
-- `reason` describe on the panel. A release writes only audit_ceiling_*, so
-- it leaves updated_at alone; the release has its own released_at, which
-- the panel already shows under "Audit purge ceiling". L5's guarantee (the
-- trigger, not "the RPC remembers to", stamps the time) still holds for any
-- future writer of a switch. The trigger keeps its name, so the L5 census
-- (rls_phase2_crm.sql) is unchanged, and its WHEN clause as before.
--
-- No function is rebuilt: release_audit_purge_ceiling() never named
-- updated_at; only the trigger made it move. Pinned by RL-REL REL9a/REL11a/
-- REL11b (rls_phase8_retention.sql). 20261010000000's header sentence
-- ("updated_at is 'the row last changed'") is a plain `--` comment in a
-- shipped migration and is left as written; this file is its correction.

drop trigger if exists set_updated_at on public.retention_settings;
create trigger set_updated_at
  before update of enabled, audit_purge_enabled, reason, updated_by
  on public.retention_settings
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();

comment on trigger set_updated_at on public.retention_settings is
  'Stamps updated_at when a KILL-SWITCH column (enabled, audit_purge_enabled, reason, updated_by) is written -- column-scoped since 20261013000000 so that a ceiling release (audit_ceiling_* only) does not move it, and the /super/health "Last changed" line keeps describing the switches and their reason. The release carries its own audit_ceiling_released_at.';

comment on column public.retention_settings.updated_at is
  'When the kill switches (enabled / audit_purge_enabled / reason) last changed. NOT moved by a ceiling release (20261013000000), which has audit_ceiling_released_at of its own.';
