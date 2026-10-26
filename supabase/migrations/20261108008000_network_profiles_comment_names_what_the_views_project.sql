-- Phase 10 Task 18 (final review finding 9): the table comment said
-- entity_kind/entity_id are "NEVER projected by either view", but both views
-- project entity_kind (the record type, "venue" or "artist", which the
-- directory shows); only entity_id, the id of the publisher's private
-- record, is never projected. Comment only; nothing else changes.
do $$
declare v text := pg_catalog.obj_description('public.network_profiles'::regclass, 'pg_class');
begin
  if pg_catalog.strpos(v, 'entity_kind/entity_id name the org''s own private record and are NEVER projected by either view.') = 0 then
    raise exception 'network_profiles comment: the sentence to correct is not there';
  end if;
  execute pg_catalog.format('comment on table public.network_profiles is %L',
    pg_catalog.replace(v,
      'entity_kind/entity_id name the org''s own private record and are NEVER projected by either view.',
      'entity_kind/entity_id name the org''s own private record. entity_id is NEVER projected by either view; entity_kind (the record type) is, by both.'));
end $$;
