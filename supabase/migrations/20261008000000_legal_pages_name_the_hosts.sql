-- ===========================================================================
-- PHASE 8 TASK 9a, JOB 1 -- FOUNDER RULINGS 2026-09-30 ON HOSTING (Q142,
-- Q145), PLUS Q187'S CLAUSE RIDING WITH THEM.
--
-- Five pages get a new version, each built by exact replacement on the
-- version published now and refused if that version has moved:
--
--   privacy                    3 -> 4
--   data-processing-addendum   4 -> 5
--   security                   2 -> 3
--   subprocessors              2 -> 3
--   data-retention             6 -> 7
--
-- Q145 (founder 2026-09-30): the production Supabase project is in IRELAND
-- (eu-west-1). Every page that said "hosted by Supabase in a UK/EU region
-- **(deployment setting)**" now names the region and drops the marker. The
-- other "(deployment setting)" markers on the Security page (Google sign-in,
-- the two-factor settings, the server-side session limits, the lockout hook,
-- email delivery) are NOT about the region and stay exactly as they were:
-- nothing in this ruling verifies them.
--
-- Q142 (founder 2026-09-30): the application host is an IONOS VPS. IONOS SE
-- is a company in Germany; the server has not been bought, and its region
-- is "most likely UK" -- which is an expectation, not a fact, so every page
-- says the location is PENDING and none of them names a country for it. The
-- "[Counsel to confirm]" gaps that said the host was "not yet listed as a
-- subprocessor" now name IONOS SE and leave only its transfer basis (which
-- depends on the pending region) and its unsigned DPA open. The register
-- (docs/sub-processors.md) and the generated Subprocessors table
-- (lib/legal/sub-processors.ts) gained the IONOS row in the commit before
-- this one; the drift test binds the two.
--
-- Q187 (kept as recommended, founder 2026-09-30): "fold 'judged when the
-- document was deleted' into the NEXT published version of the page rather
-- than publishing a v7 for one clause". This is that next version: the
-- retention page's document-file sentence now says which period applies is
-- judged at deletion (the Q186 freeze), that a later change to the event's
-- money does not move it either way, and that a restore and a second
-- deletion judge it again. The sentence private.retention_periods() is bound
-- to in rls_phase8_retention.sql § RL is kept word for word, so that binding
-- still reads the database's numbers in the same place.
--
-- PUBLISHED BY ID (Task 6 fix round 1, m4): every new version is published
-- by the id this migration inserted, never "every draft of the slug", so a
-- draft counsel has open in /super/legal is left alone.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. Each lands with no counsel review
-- marker, so every page keeps its "draft pending legal review" notice.
--
-- ADDITIVE. No applied migration or published row is edited except by the
-- one transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_hosting_v (
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
  -- ---- (a) the Privacy Notice, version 3 ---------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'privacy' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'privacy' and status = 'published';
  if v_version <> 3 then
    raise exception 'legal hosting: the published privacy notice is version %, not the version 3 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$Our database and file storage are hosted by Supabase in a UK/EU region **(deployment setting)**. A deployment setting is chosen in our account with a provider rather than written into the service: it is on our pre-launch checklist, and this notice does not by itself show that it is set for the service you are using. Transactional email is sent through a provider in France, which is covered by the UK's adequacy regulations.$t$,
$t$Our database and file storage are hosted by Supabase in Ireland (eu-west-1), in the EU. The application servers, which handle every request to the service, will run on a virtual private server rented from IONOS SE, a company in Germany; that server has not been set up yet, and its location is pending. Transactional email is sent through a provider in France, which is covered by the UK's adequacy regulations.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the privacy notice no longer carries the version 3 storage paragraph -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$and the provider that hosts the application servers, which handle every request to the service, is not yet listed as a subprocessor.]$t$,
$t$and the location of the application servers hosted by IONOS SE is pending, and its data processing agreement has not been signed either.]$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the privacy notice no longer carries the version 3 transfer gap -- correct it through /super/legal';
  end if;
  insert into legal_hosting_v values ('privacy', v_id, v_version, v_next);

  -- ---- (b) the Data Processing Addendum, version 4 -----------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-processing-addendum' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'data-processing-addendum' and status = 'published';
  if v_version <> 4 then
    raise exception 'legal hosting: the published DPA is version %, not the version 4 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$Customer data is hosted by Supabase in a UK/EU region **(deployment setting)**. A deployment setting is chosen in our account with a provider rather than written into the service: it is on our pre-launch checklist, and this addendum does not by itself show that it is set for your deployment. Transactional email is sent through a subprocessor in France, which is covered by the UK's adequacy regulations.$t$,
$t$Customer data is hosted by Supabase in Ireland (eu-west-1), in the EU. The application servers, which handle every request, will be hosted by IONOS SE, a company in Germany, on a server that has not been set up yet and whose location is pending. Transactional email is sent through a subprocessor in France, which is covered by the UK's adequacy regulations.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the DPA no longer carries the version 4 transfers paragraph -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$and the provider that hosts the application servers is not yet listed on the Subprocessors page.]$t$,
$t$and the location of the application servers hosted by IONOS SE is pending, and its data processing agreement has not been signed either.]$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the DPA no longer carries the version 4 transfer gap -- correct it through /super/legal';
  end if;
  insert into legal_hosting_v values ('data-processing-addendum', v_id, v_version, v_next);

  -- ---- (c) Security and Trust, version 2 ---------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'security' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'security' and status = 'published';
  if v_version <> 2 then
    raise exception 'legal hosting: the published security page is version %, not the version 2 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$- Our database and file storage are hosted by Supabase in a UK/EU region. The region is chosen in our hosting account **(deployment setting)**.$t$,
$t$- Our database and file storage are hosted by Supabase in Ireland (eu-west-1), in the EU.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the security page no longer carries the version 2 region line -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$- [Counsel to confirm: the provider that hosts the application servers, which handle every request, with its location and transfer basis. It is not yet listed on our Subprocessors page.]$t$,
$t$- The application servers, which handle every request, will run on a virtual private server from IONOS SE, a company in Germany. That server has not been set up yet and its location is pending, so nothing on this page describes its configuration yet. [Counsel to confirm: the transfer basis for the application servers once their location is decided.]$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the security page no longer carries the version 2 application-host gap -- correct it through /super/legal';
  end if;
  insert into legal_hosting_v values ('security', v_id, v_version, v_next);

  -- ---- (d) Subprocessors, version 2 --------------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'subprocessors' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'subprocessors' and status = 'published';
  if v_version <> 2 then
    raise exception 'legal hosting: the published subprocessors page is version %, not the version 2 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$These are the third parties we have assessed so far that process personal data on GetSetPaid's behalf. **This list is not complete yet.**$t$,
$t$These are the third parties we have assessed so far that process personal data on GetSetPaid's behalf, or will once the service is running. **This list is not complete yet.** The location of our application servers is still pending, and a malware-scanning service has not been chosen.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the subprocessors page no longer carries the version 2 opening -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$[Counsel to confirm: the provider that hosts the application servers, with its location and transfer basis. Those servers handle every request to the service, so that provider already processes personal data, and it is not listed below. For our database provider,$t$,
$t$[Counsel to confirm: the transfer basis for the application servers hosted by IONOS SE, once their location is decided. For our database provider,$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the subprocessors page no longer carries the version 2 counsel gap -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$Where the table says a provider hosts data in a region **(deployment setting)**, the region is chosen in our account with that provider rather than written into the service: it is on our pre-launch checklist, and this page does not by itself show that it is set for the service you are using.$t$,
$t$Where the table says a server's region is **pending**, that server has not been set up yet. We will publish a new version of this page naming its location when it is chosen.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the subprocessors page no longer carries the version 2 region note -- correct it through /super/legal';
  end if;
  insert into legal_hosting_v values ('subprocessors', v_id, v_version, v_next);

  -- ---- (e) Data Retention, version 6 (Q187) ------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';
  select id, version into strict v_id, v_version
    from public.legal_documents where slug = 'data-retention' and status = 'published';
  if v_version <> 6 then
    raise exception 'legal hosting: the published data-retention page is version %, not the version 6 this was written against -- make the change through /super/legal', v_version;
  end if;

  v_next := replace(v_current,
$t$-- or 7 years if the document is attached to an event that carries financial entries. It is the file that is deleted.$t$,
$t$-- or 7 years if the document is attached to an event that carries financial entries. Which of the two applies is judged when the document is deleted: a later change to that event's financial entries does not move it either way, and a document that is restored and deleted again is judged again at that second deletion. It is the file that is deleted.$t$);
  if v_next = v_current then
    raise exception 'legal hosting: the data-retention page no longer carries the version 6 document-file sentence -- correct it through /super/legal';
  end if;
  insert into legal_hosting_v values ('data-retention', v_id, v_version, v_next);
end;
$do$;

do $do$
declare
  r      record;
  v_new  uuid;
begin
  for r in select * from legal_hosting_v order by slug loop
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

    -- m4: BY ID.
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
         and ((slug = 'privacy' and version = 4
               and body like '%hosted by Supabase in Ireland (eu-west-1)%'
               and body like '%IONOS SE%' and body like '%its location is pending%')
           or (slug = 'data-processing-addendum' and version = 5
               and body like '%hosted by Supabase in Ireland (eu-west-1)%'
               and body like '%IONOS SE%' and body like '%whose location is pending%')
           or (slug = 'security' and version = 3
               and body like '%hosted by Supabase in Ireland (eu-west-1)%'
               and body like '%IONOS SE%' and body like '%its location is pending%')
           or (slug = 'subprocessors' and version = 3
               and body like '%IONOS SE%' and body like '%This list is not complete yet.%')
           or (slug = 'data-retention' and version = 7
               and body like '%judged when the document is deleted%'))
         and body not like '%UK/EU region **(deployment setting)**%'
         and body not like '%not yet listed%') <> 5 then
    raise exception 'legal hosting: expected five new published, unreviewed versions naming Ireland (eu-west-1) and IONOS SE, with no region marker and no "not yet listed" host';
  end if;
end;
$do$;

drop table legal_hosting_v;
