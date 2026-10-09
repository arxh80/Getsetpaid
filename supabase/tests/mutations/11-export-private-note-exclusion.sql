-- PHASE 8 TASK 8 MUTANT 11-export-private-note-exclusion
-- guard:  private.export_read_page_as_requester's owner
-- change: re-owned by postgres, so the read runs as a BYPASSRLS definer instead of as the requester
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
alter function private.export_read_page_as_requester(text, uuid, text, integer) owner to postgres;
