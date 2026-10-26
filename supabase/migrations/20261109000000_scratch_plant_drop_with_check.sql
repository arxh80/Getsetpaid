-- SCRATCH PLANT (Phase 10 Task 9, G1 proof). Never merged: the psql CI job must go red on it.
alter policy "contacts_insert_manage_contacts" on public.contacts with check (true);
