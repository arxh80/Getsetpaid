-- PHASE 8 TASK 9a FIX ROUND 1 MUTANT 19a-release-bumps-switch-time (review m2)
-- guard:  set_updated_at on public.retention_settings is column-scoped to the
--         kill-switch columns (20261013000000)
-- change: the trigger is restored to a plain BEFORE UPDATE (20261003010000's
--         shape), so a ceiling release stamps updated_at again and the
--         panel's "Last changed" line describes the release
-- Applied after a fresh reset by run-mutation.sh and removed by the next
-- reset. Never a migration.
drop trigger if exists set_updated_at on public.retention_settings;
create trigger set_updated_at before update on public.retention_settings
  for each row when (old.* is distinct from new.*)
  execute function private.set_updated_at();
