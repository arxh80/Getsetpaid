-- ===========================================================================
-- PHASE 8 TASK 6 -- /legal/data-retention v4 -> v5: THE AUTOMATED DELETION
-- STOPPED BEING SOMETHING WE WERE STILL BUILDING.
--
-- Two paragraphs of the CURRENT PUBLISHED page are now false, and a published
-- page is a promise: it is not enough to correct SECURITY.md and CLAUDE.md
-- and leave the public one saying something the product no longer does.
--
--   (a) "Security audit records: ... Neither limit is applied yet: today every
--       record stays in our database, and searchable by our operator, for as
--       long as it is stored. There is no separate archive store."
--
--       HALF OF THAT IS NOW WRONG AND HALF IS STILL RIGHT, which is exactly
--       why it has to be rewritten rather than deleted. Both limits ARE
--       applied now: the operator's audit viewer defaults to the last 30 days
--       (Q135) and the purge deletes at a year. There is STILL no separate
--       archive store, and the new text keeps saying so -- "archived" means
--       the record stays in the same database and falls out of the default
--       view, which is a weaker thing than the phrase suggests and the page
--       should not let it suggest otherwise.
--
--   (b) "**Automated deletion is still being built.** Until it runs, some data
--       past these periods may still be stored..." with the export archive as
--       its worked example.
--
--       It runs. The worked example is the one that changed most: an expired
--       archive's bytes were the thing the paragraph pointed at as still
--       stored, and they are now deleted by the same job.
--
-- WHAT THE NEW TEXT DOES NOT CLAIM. It does not say deletion is instant: the
-- job runs about hourly, it is bounded per run so a large backlog drains over
-- several, and a file whose deletion fails is retried rather than forgotten.
-- Saying "we delete it the moment the period ends" would be a promise the
-- implementation does not make, and this page's whole value is that a reader
-- can check it against the product.
--
-- HOW: the new body is the CURRENT published body with two exact passages
-- replaced, read out of the database rather than retyped, and the migration
-- RAISES if either passage is not found -- so if counsel has edited the page
-- through /super/legal in the meantime, this fails loudly instead of
-- publishing a body built from an assumption.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. It lands as a new published version with
-- no counsel review marker, so the page keeps its "draft pending legal
-- review" notice.
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_retention_v (slug text primary key, body text);

do $do$
declare v_current text; v_next text;
begin
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';

  v_next := replace(v_current,
$t$- **Security audit records:** the target is that they are searchable by our operator for 30 days and kept for up to 1 year in total, then deleted. Neither limit is applied yet: today every record stays in our database, and searchable by our operator, for as long as it is stored. There is no separate archive store.$t$,
$t$- **Security audit records:** searchable by our operator for 30 days, kept for up to 1 year in total, then deleted. Both limits are applied. **"Archived" here means less than it sounds like, and we would rather say so:** after 30 days the record is still in the same database and our operator can still find it by setting a date -- it simply stops appearing in their default view. There is no separate archive store. At one year the record is deleted.$t$);
  if v_next = v_current then
    raise exception 'legal retention: the data-retention page no longer carries the version 4 audit-records line -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$**Automated deletion is still being built.** Until it runs, some data past these periods may still be stored, although much of it is already hidden from every screen. An export archive is an example of the difference: after seven days nobody can download it, and it is not offered on any screen, but the file itself is still stored until that automated deletion runs.$t$,
$t$**Automated deletion runs.** A scheduled job goes through these periods and deletes what has passed them: the files behind deleted documents, feedback and its screenshots, expired export archives, our own security and operational records, and a workspace that has been closed for 60 days. **It is not instant, and we would rather be exact than reassuring.** It runs about once an hour; each run is deliberately bounded, so a large backlog is cleared over several runs rather than all at once; and a deletion that fails is tried again rather than forgotten. So a record can outlive its period by hours, and in an unusual case by longer -- what does not happen is that it is quietly kept indefinitely. Every run is recorded, including what it removed and anything it refused to.$t$);
  if v_next = v_current then
    raise exception 'legal retention: the data-retention page no longer carries the version 4 automated-deletion paragraph -- correct it through /super/legal';
  end if;

  insert into legal_retention_v values ('data-retention', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_retention_v v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_retention_v);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_retention_v);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published'
         and counsel_reviewed_at is null
         and slug = 'data-retention'
         and body like '%Automated deletion runs.%'
         and body like '%Both limits are applied.%'
         and body like '%There is no separate archive store.%'
         and body not like '%still being built%') <> 1 then
    raise exception 'legal retention: expected one new published, unreviewed Data Retention version that says the job runs, still says there is no archive store, and no longer says the job is being built';
  end if;
end;
$do$;

drop table legal_retention_v;
