-- PHASE 8 TASK 8 MUTANT 08-dsr-operator-notes-boundary
-- guard:  the operator notes' single SELECT policy
-- change: a second permissive SELECT policy lets every signed-in session read every note
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
create policy t8_mutant_notes_readable on public.data_subject_request_notes for select to authenticated using (true);
