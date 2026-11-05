-- ===========================================================================
-- PHASE 8 OWED (final review B, F1) -- SUBPROCESSORS VERSION 4.
--
-- Two things changed since version 3 was published, and the published page
-- is immutable, so they arrive as the next version rather than an edit:
--
--   * Q42 (founder 2026-10-13) chose the malware scanner: self-hosted ClamAV,
--     running on our own application server (SECURITY.md § 6,
--     docs/clamav.md). Version 3 says twice that a scanning service "has not
--     been chosen". It has, and it is not a subprocessor: no customer file
--     leaves our server to be scanned. docs/sub-processors.md already says so.
--   * The Brevo row widened to the Phase 8 notification emails (final review
--     B, F1). /legal/subprocessors renders that table from
--     lib/legal/sub-processors.ts, so the table changed when the code
--     shipped; this version dates the change on the page.
--
--   subprocessors   3 -> 4
--
-- Built by exact replacement on the version published now and refused if
-- that version has moved; published BY ID, never "every draft of the slug",
-- so a draft counsel has open in /super/legal is left alone.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. It lands with no counsel review marker,
-- so the page keeps its "draft pending legal review" notice.
--
-- ADDITIVE. No applied migration or published row is edited except by the
-- one transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_scanner_v (
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
  -- ---- Subprocessors, version 3 ------------------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'subprocessors' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'subprocessors' and status = 'published';
  if v_version <> 3 then
    raise exception 'legal scanner: the published subprocessors page is version %, not the version 3 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$The location of our application servers is still pending, and a malware-scanning service has not been chosen.$t$,
$t$The location of our application servers is still pending.$t$);
  if v_next = v_current then
    raise exception 'legal scanner: the subprocessors page no longer carries the version 3 opening -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$No third-party malware-scanning service receives your files today: the production scanning engine has not been chosen yet. When one is, it will be listed here before it receives any file.$t$,
$t$Uploaded files are scanned for malware by ClamAV, open-source software we run on our own application server. No third party receives your files to scan them, so the scanner is not a subprocessor. Its malware definitions are downloaded from ClamAV's own servers, and that download carries none of your data.$t$);
  if v_next = v_current then
    raise exception 'legal scanner: the subprocessors page no longer carries the version 3 scanner sentence -- correct it through /super/legal';
  end if;
  insert into legal_scanner_v values ('subprocessors', v_id, v_version, v_next);
end;
$do$;

do $do$
declare
  r      record;
  v_new  uuid;
begin
  for r in select * from legal_scanner_v order by slug loop
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
         and slug = 'subprocessors' and version = 4
         and body like '%scanned for malware by ClamAV, open-source software we run on our own application server%'
         and body not like '%has not been chosen%'
         and body like '%IONOS SE%') <> 1 then
    raise exception 'legal scanner: expected one new published, unreviewed subprocessors version 4 that names the self-hosted scanner';
  end if;
end;
$do$;

drop table legal_scanner_v;
