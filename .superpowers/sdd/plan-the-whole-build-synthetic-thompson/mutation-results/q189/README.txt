Q189 mutation run (results.txt), 2026-10-10

- Target: private.audit_organisation_update() and its trigger (20261031000000), measured by
  supabase/tests/rls_phase8_crm_audit_p3_6.sql § PO (+ PC1/PC2/PC4).
- Run AFTER a full `bash supabase/tests/run-rls-tests.sh` on a fresh reset: the c7 suite needs the
  runner's fixtures and is run standalone with the P7 variables rebuilt from auth.users. Command:
  `python mutants.py` from the worktree root (Windows python; not via bash run.sh).
- Each mutant is applied to the live DB and restored in a finally block. Control 233/0 red before
  and after: the restores were exact, and the suite re-runs cleanly on one DB.
- M01 sessionless exemption removed  -> PO4, PO4a red (log_audit_event refuses a null actor).
- M02 no-op exemption removed        -> PO3b (+ PO4b, PO5b, PO6b, PO7).
- M03 lifecycle columns in changed   -> PO5b, PO6b, PO7.
- M04 every changed column valued    -> PO7.
- M05 trigger dropped                -> PC1, PC2, PC4, PO1b-PO9 (13 red).
- PO6c (lifecycle_reason never in a payload) is reddened by no single mutant: under M03 the reason
  column is NAMED but not valued, and under M04 it is outside the changed set. It is a second
  line behind both; it goes red only if both terms are broken together.
- Two earlier attempts are not in results.txt: the suite then crashed under M01 (a sessionless
  UPDATE outside c7.try, and a sessionless restore), which left fixtures behind and zeroed every
  later mutant. Both statements were fixed (PO4 is a c7.try; the restore runs with padmin's claims).
