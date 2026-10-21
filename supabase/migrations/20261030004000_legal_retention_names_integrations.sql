-- ===========================================================================
-- PHASE 9 TASK 3 -- THE RETENTION PAGE STATES THE TWO NEW PERIODS.
--
-- 20261030003000 declared two classes in private.retention_periods():
-- `integration_sync_run` (90 days) and `integration_connection_revoked`
-- (2 years), and the scheduled job now applies them. rls_phase8_retention.sql
-- § RL binds EVERY declared period to the published /legal/data-retention
-- page, in the sentence that states it, with the database's number -- so a
-- declared period the page does not state is a red assertion, which is the
-- point. This is the version that states them:
--
--   data-retention   7 -> 8
--
-- Built by exact replacement on the version published now and refused if
-- that version has moved; published BY ID, never "every draft of the slug",
-- so a draft counsel has open in /super/legal is left alone. Both new
-- sentences also say plainly that no connection to another service can be
-- made yet -- every provider is disabled in this release.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. It lands with no counsel review marker,
-- so the page keeps its "draft pending legal review" notice.
--
-- ADDITIVE. No applied migration or published row is edited except by the
-- one transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_integrations_v (
  slug       text primary key,
  current_id uuid not null,
  version    integer not null,
  body       text not null
);

do $do$
declare
  v_current text;
  v_next    text;
  v_id      uuid;
  v_version integer;
begin
  -- ---- Data Retention, version 7 -----------------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'data-retention' and status = 'published';
  if v_version <> 7 then
    raise exception 'legal integrations: the published data-retention page is version %, not the version 7 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$- **Stored files that no record refers to** (for example, left behind by an upload that did not complete): 1 day.$t$,
$t$- **The history of a connection to another service** (when it last exchanged data with GetSetPaid, how many items moved, and whether that worked): 90 days after that exchange finished. No connection to another service can be made yet.
- **A connection to another service that has been disconnected:** 2 years after it was disconnected. The key that let us reach the other service is deleted the moment the connection is disconnected; what is kept until then is the record that the connection existed.
- **Stored files that no record refers to** (for example, left behind by an upload that did not complete): 1 day.$t$);
  if v_next = v_current then
    raise exception 'legal integrations: the data-retention page no longer carries the version 7 stored-files sentence -- correct it through /super/legal';
  end if;
  insert into legal_integrations_v values ('data-retention', v_id, v_version, v_next);
end;
$do$;

do $do$
declare
  r      record;
  v_new  uuid;
begin
  for r in select * from legal_integrations_v order by slug loop
    insert into public.legal_documents (slug, version, title, effective_date, body)
    select d.slug, d.version + 1, d.title, (now() at time zone 'Europe/London')::date, r.body
      from public.legal_documents d
     where d.id = r.current_id
    returning id into strict v_new;

    -- Supersede first, then publish -- as public.publish_legal_document()
    -- does, because one published version per slug is checked per statement.
    update public.legal_documents d
       set status = 'superseded', superseded_at = now()
     where d.id = r.current_id and d.status = 'published';

    -- BY ID.
    update public.legal_documents d
       set status = 'published', published_at = now()
     where d.id = v_new;
  end loop;
end;
$do$;

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published'
         and counsel_reviewed_at is null
         and slug = 'data-retention' and version = 8
         and body like '%**The history of a connection to another service**%: 90 days after that exchange finished%'
         and body like '%**A connection to another service that has been disconnected:** 2 years after it was disconnected%'
         and body like '%judged when the document is deleted%') <> 1 then
    raise exception 'legal integrations: expected one new published, unreviewed data-retention version 8 stating both integration periods';
  end if;
end;
$do$;

drop table legal_integrations_v;
