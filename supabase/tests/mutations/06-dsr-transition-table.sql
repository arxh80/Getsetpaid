-- PHASE 8 TASK 8 MUTANT 06-dsr-transition-table
-- guard:  private.dsr_transition_allowed
-- change: every (from, to) pair is allowed
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.dsr_transition_allowed(p_from text, p_to text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select true or (p_from, p_to) in (
    ('open',        'in_progress'),
    ('open',        'routed'),
    ('open',        'fulfilled'),
    ('open',        'rejected'),
    ('open',        'withdrawn'),
    ('in_progress', 'routed'),
    ('in_progress', 'fulfilled'),
    ('in_progress', 'rejected'),
    ('in_progress', 'withdrawn'),
    ('routed',      'fulfilled'),
    ('routed',      'rejected'),
    ('routed',      'withdrawn')
  );
$function$;
