-- ===========================================================================
-- PHASE 8 TASK 4: THE THREE LEGAL PAGES THAT NOW SAY SOMETHING FALSE.
--
-- Shipping a feature makes prose about it out of date, and the published
-- versions are immutable, so each correction is a new version by the same
-- route 20260925004000 used. Three pages, and each had one sentence that this
-- task makes untrue or incomplete:
--
--   (a) DATA PROCESSING ADDENDUM, "Deletion and return": "A self-service
--       export is being built." It is built. Art 28(3)(g) is about returning
--       or deleting the customer's data at the end of the service, and the
--       customer can now take a machine-readable copy of everything in a
--       workspace themselves, during the 60-day window and not only before
--       it. The replacement says who may do it, what it contains, and the one
--       thing a reader would otherwise get wrong -- that an archive is built
--       with the ACCESS RIGHTS of whoever asked for it, so an Owner's copy is
--       not automatically everything the workspace holds.
--
--   (b) YOUR DATA PROTECTION RIGHTS, "How to make a request": the page
--       offered exactly one route to a copy of your data -- the statutory
--       form -- and the product now has a self-service one beside it. A page
--       that keeps quiet about the easier route makes the statutory one look
--       compulsory, which is the opposite of what a rights page is for. The
--       new paragraph also says the thing a person most wants to know and
--       that the form cannot tell them: what is and is not in the file.
--
--   (c) DATA RETENTION POLICY, "Retention periods": the list did not mention
--       export archives, which are a new class of stored personal data with
--       their own (much shorter) clock -- and an honest retention policy that
--       omits a store is worse than one that admits an unfinished one. It
--       also repeats the standing caveat that automated deletion is not built
--       (Task 6), because an archive is UNREACHABLE after seven days and its
--       bytes are still stored until that job lands, and those are not the
--       same thing.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. Each lands as a new version with no
-- counsel review marker, so every page keeps its "draft pending legal review"
-- notice -- which the database will not let a migration claim otherwise.
--
-- HOW: the new body is the CURRENT published body with exact passages
-- replaced; a passage that is not found (the operator revised the page on
-- this deployment) fails the migration loudly rather than guessing.
--
--   data-processing-addendum  version 3 -> 4
--   data-subject-rights       version 3 -> 4
--   data-retention            version 2 -> 3
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_export_v (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  -- ---- (a) the DPA's return-of-data clause ------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-processing-addendum' and status = 'published';

  v_next := replace(v_current,
$t$When a workspace is closed, its data is kept for 60 days, during which the workspace can be reopened, and then deleted in line with the [Data Retention Policy](/legal/data-retention). A self-service export is being built.$t$,
$t$When a workspace is closed, its data is kept for 60 days, during which the workspace can be reopened, and then deleted in line with the [Data Retention Policy](/legal/data-retention).

You can take a copy of a workspace's data yourself at any time, including while it is suspended or closed and within that 60-day window, from Settings in the workspace. Only an Owner or an Admin can start one. The archive is a zip holding one machine-readable JSON file for each kind of record, deleted records included and marked as deleted, together with the files themselves; a file that did not pass our malware scan is listed with its status and its contents are left out, and the archive says so. It is prepared in the background, only the person who asked for it can download it, and it is kept for seven days and then removed.

One thing about it is worth stating plainly, because it is not what most people assume: the archive is built with the ACCESS RIGHTS OF THE PERSON WHO ASKED FOR IT, not with the workspace's. Anything they cannot see in the product -- another member's private notes, for example -- is not in their copy either.$t$);
  if v_next = v_current then
    raise exception 'legal export: the data-processing-addendum no longer carries the version 3 deletion-and-return paragraph -- correct it through /super/legal';
  end if;
  insert into legal_export_v values ('data-processing-addendum', v_next);

  -- ---- (b) the rights page's "how to make a request" ---------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-subject-rights' and status = 'published';

  v_next := replace(v_current,
$t$## How to make a request

Sign in and go to [your data protection requests](/account/data-requests).$t$,
$t$## How to make a request

**For a copy of your account data, you do not need to make a formal request at all.** Sign in and go to [a copy of your data](/account/exports), and we prepare one for you. It holds what we hold about your account: your profile, the workspaces you belong to and your role in each, your marketing choices, your data protection requests, feedback you have sent us, the support-access sessions you accepted or declined, and the record of what you did in the product. It does not hold the records a business keeps about you inside its own workspace -- that business decides what it keeps and why, and the section above on who to ask explains how to reach it. Only you can download the file, and we keep it for seven days.

The formal route below is still open, and using it is what starts the 30-day clock and the record that goes with it. If you ask for access or portability that way, this is the file we answer you with.

Sign in and go to [your data protection requests](/account/data-requests).$t$);
  if v_next = v_current then
    raise exception 'legal export: the data-subject-rights page no longer carries the version 3 request heading -- correct it through /super/legal';
  end if;
  insert into legal_export_v values ('data-subject-rights', v_next);

  -- ---- (c) the retention policy's schedule -------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';

  v_next := replace(v_current,
$t$- **Documents** follow the record they belong to.$t$,
$t$- **Documents** follow the record they belong to.
- **Export archives** (a copy of your account data, or of a workspace's records, that someone asked us to prepare): 7 days from when the file is ready. After that nobody can download it. Its contents are a copy of records that are themselves kept under the rules above.$t$);
  if v_next = v_current then
    raise exception 'legal export: the data-retention page no longer carries the version 2 documents line -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$**Automated deletion is still being built.** Until it runs, some data past these periods may still be stored, although much of it is already hidden from every screen.$t$,
$t$**Automated deletion is still being built.** Until it runs, some data past these periods may still be stored, although much of it is already hidden from every screen. An export archive is an example of the difference: after seven days nobody can download it, and it is not offered on any screen, but the file itself is still stored until that automated deletion runs.$t$);
  if v_next = v_current then
    raise exception 'legal export: the data-retention page no longer carries the version 2 automated-deletion paragraph -- correct it through /super/legal';
  end if;
  insert into legal_export_v values ('data-retention', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_export_v v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_export_v);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_export_v);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published'
         and counsel_reviewed_at is null
         and effective_date = (now() at time zone 'Europe/London')::date
         and ((slug = 'data-processing-addendum' and version = 4
               and body like '%ACCESS RIGHTS OF THE PERSON WHO ASKED FOR IT%'
               and body not like '%A self-service export is being built%')
           or (slug = 'data-subject-rights' and version = 4
               and body like '%you do not need to make a formal request at all%'
               and body like '%(/account/exports)%')
           or (slug = 'data-retention' and version = 3
               and body like '%**Export archives**%'
               and body like '%the file itself is still stored%'))) <> 3 then
    raise exception 'legal export: expected three new published, unreviewed versions describing the export';
  end if;
end;
$do$;

drop table legal_export_v;
