-- PHASE 8 TASK 8 MUTANT 02-legal-anon-column-grant
-- guard:  anon's eight-column SELECT on public.legal_documents
-- change: widened to a TABLE-level SELECT (status, counsel_reviewer, published_by readable signed out)
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
grant select on public.legal_documents to anon;
