-- ===========================================================================
-- Phase 8 Task 1, fix round 2: make the public site say ONE thing about where
-- data is hosted and whether it leaves the UK.
--
-- After fix round 1 (20260922005000) the site contradicted itself:
--
--   * /legal/subprocessors (still version 1) said, as fact, "We add a
--     provider here before it receives any personal data". That is false: the
--     provider hosting the application servers already sees every request and
--     is not listed (DECISIONS-QUEUE Q142). Its generated table also said
--     Supabase, Inc. involved "No international transfer" -- the exact point
--     Privacy v2 and DPA v2 now call unsettled. (The table is code, not
--     stored text: lib/legal/sub-processors.ts is corrected in the same
--     change, with docs/sub-processors.md, so the drift test stays green.)
--
--   * Security v2 marks "hosted in a UK/EU region" as a (deployment setting)
--     -- the region is chosen in the hosting account and nothing in this
--     repository enforces it -- while Privacy v2 and DPA v2 stated it flat.
--
-- ONE TREATMENT, EVERYWHERE: the region is stated with the same bold
-- "(deployment setting)" marker the Security page uses, with a sentence
-- saying what that means on the two pages that do not otherwise define it;
-- the transfer position is a "[Counsel to confirm: ...]" gap, never a
-- statement either way.
--
--   subprocessors            version 1 -> 2
--   privacy                  version 2 -> 3
--   data-processing-addendum version 2 -> 3
--
-- HOW: exactly as 20260922005000. Each new body is the CURRENT published body
-- with exact passages replaced; a passage that is not found (the operator
-- revised the page on this deployment) fails the migration loudly rather
-- than guessing. Each new version is inserted as a draft with no counsel-
-- review marker and published by transition, so every page still carries the
-- "draft pending legal review" notice. Not legal advice; not reviewed.
--
-- ADDITIVE. No applied migration or published row is edited except by the
-- one transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_v3 (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  -- ---------------------------------------------------------- subprocessors
  select body into strict v_current
    from public.legal_documents where slug = 'subprocessors' and status = 'published';

  v_next := replace(v_current,
$t$These are the third parties that process personal data on GetSetPaid's behalf. We add a provider here before it receives any personal data.$t$,
$t$These are the third parties we have assessed so far that process personal data on GetSetPaid's behalf. **This list is not complete yet.**

[Counsel to confirm: the provider that hosts the application servers, with its location and transfer basis. Those servers handle every request to the service, so that provider already processes personal data, and it is not listed below. For our database provider, whether its incorporation in the United States involves a transfer of personal data outside the UK, and the safeguards for it, is also still to be confirmed.]

Where the table says a provider hosts data in a region **(deployment setting)**, the region is chosen in our account with that provider rather than written into the service: it is on our pre-launch checklist, and this page does not by itself show that it is set for the service you are using.$t$);
  if v_next = v_current then
    raise exception 'legal v3: the subprocessors page no longer carries the version 1 completeness sentence -- correct it through /super/legal';
  end if;
  insert into legal_v3 values ('subprocessors', v_next);

  -- ---------------------------------------------------------------- privacy
  select body into strict v_current
    from public.legal_documents where slug = 'privacy' and status = 'published';

  v_next := replace(v_current,
$t$Our database and file storage are hosted in a UK/EU region. Transactional email$t$,
$t$Our database and file storage are hosted by Supabase in a UK/EU region **(deployment setting)**. A deployment setting is chosen in our account with a provider rather than written into the service: it is on our pre-launch checklist, and this notice does not by itself show that it is set for the service you are using. Transactional email$t$);
  if v_next = v_current then
    raise exception 'legal v3: the privacy notice no longer carries the version 2 hosting sentence -- correct it through /super/legal';
  end if;
  insert into legal_v3 values ('privacy', v_next);

  -- ------------------------------------------------ data-processing-addendum
  select body into strict v_current
    from public.legal_documents where slug = 'data-processing-addendum' and status = 'published';

  v_next := replace(v_current,
$t$Customer data is hosted in a UK/EU region. Transactional email$t$,
$t$Customer data is hosted by Supabase in a UK/EU region **(deployment setting)**. A deployment setting is chosen in our account with a provider rather than written into the service: it is on our pre-launch checklist, and this addendum does not by itself show that it is set for your deployment. Transactional email$t$);
  if v_next = v_current then
    raise exception 'legal v3: the DPA no longer carries the version 2 hosting sentence -- correct it through /super/legal';
  end if;
  insert into legal_v3 values ('data-processing-addendum', v_next);
end;
$do$;

-- Each correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_v3 v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_v3);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_v3);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published' and slug in ('subprocessors', 'privacy', 'data-processing-addendum')
         and counsel_reviewed_at is null
         and effective_date = (now() at time zone 'Europe/London')::date) <> 3 then
    raise exception 'legal v3: expected three newly published, unreviewed versions';
  end if;
end;
$do$;

drop table legal_v3;
