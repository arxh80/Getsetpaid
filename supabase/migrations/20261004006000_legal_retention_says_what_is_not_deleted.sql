-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDINGS I3 AND m4; Q183 AT ITS
-- RECOMMENDED DEFAULT.
--
-- /legal/data-retention v5 -> v6: THE PAGE SAYS PLAINLY WHAT IS *NOT*
-- AUTOMATICALLY DELETED.
--
-- 20261003009000 (v5) replaced "Automated deletion is still being built" with
-- "Automated deletion runs." That sentence was the shield over two others on
-- the same page, and removing it left both as live promises on a published,
-- world-readable page:
--
--   "Inactive account data: 2 years from last use."
--       NOTHING SWEEPS THIS. Q180 is queued and its recommended default is
--       explicitly NOT to build it; every such table is classified
--       `retained_with_workspace` in private.retention_subjects().
--
--   "Most records are soft-deleted first ... When a period ends, the data is
--    permanently deleted or anonymised."
--       FALSE for every `retained_with_workspace` table -- contacts,
--       companies, artists, agencies, venues, rooms, events, tasks, meetings,
--       notes, financial entries. A soft-deleted contact is kept, restorable,
--       for as long as the workspace exists. By design.
--
-- And a third, which the review did not name and the sentence-by-sentence
-- check below found: "Financial records: 7 years" read as a deletion date.
-- `financial_entries` is `retained_with_workspace` too. The `financial` class
-- deletes exactly one thing -- the FILE of a deleted document attached to an
-- event that carries money. Seven years is how long the records are expected
-- to be needed, not a date anything applies to them.
--
-- Q183: "should the page state that a workspace's own soft-deleted CRM
-- records, and inactive account data, are NOT automatically deleted today?"
-- RECOMMENDED DEFAULT YES, taken: it is true, and a page that overclaims
-- deletion is a worse failure than one that admits a gap.
--
-- CHECKED SENTENCE BY SENTENCE against private.retention_periods() (eleven
-- classes) and private.retention_subjects() (the treatment of every table),
-- and the same check is a test: rls_phase8_retention.sql § RL binds every
-- period the page states to the declaration, and every table the roll calls
-- `retained_with_workspace` to the page's list of what is NOT deleted -- so
-- counsel's answer to Q133 (one reissue of one function) reds the page until
-- it is corrected too, and so does a new tenant table nobody told the page
-- about.
--
--   financial 7y            the FILE of a deleted document on a money-carrying
--                           event; stated as that, and as NOT a deletion date
--                           for the records themselves
--   operational 2y          the FILE of any other deleted document; the ROW
--                           stays, marked, and cannot be restored
--   feedback 2y             rows and screenshots
--   audit_hot 30d           the default view only; nothing is deleted
--   audit_total 1y          deleted
--   workspace 60d           hard purge; closing a suspended one restarts it
--   rate_limit_counter 7d   NEW on the page
--   incident_alert 1y       NEW on the page; from RESOLUTION, never while open
--   erasure_job_failed 90d  NEW on the page -- the review named this omission:
--                           a row that names a person and says why their
--                           statutory deletion did not happen
--   stuck_job 1h            NEW on the page, and stated as NOT a deletion
--   storage_orphan 1d       NEW on the page
--   (export archive 7d      private.export_limits(), not a retention class --
--                           unchanged)
--
-- It also says what the job does when it cannot safely run, which is new
-- this round and is now true: it deletes NOTHING and alerts the operator
-- (20261004002000, 20261004004000).
--
-- m4: v5's migration published EVERY `draft` of the slug:
--
--   update ... set status = 'published' where status = 'draft' and slug in (...)
--
-- so if counsel had a second unpublished draft of data-retention open through
-- /super/legal, it would have been promoted too. The closing guard counted
-- published rows, so the failure would have been loud rather than silent --
-- but the statement should name the version it inserted. This one publishes
-- BY ID, and refuses to run at all unless the published version is exactly
-- the one this text was written against (5): if the page has moved, the
-- correction belongs in /super/legal, not in a body built on an assumption.
--
-- WRITTEN WHOLE rather than as replacements, because more of the page changes
-- than stays.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. It lands as a new published version with
-- no counsel review marker, so the page keeps its "draft pending legal
-- review" notice.
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

do $do$
declare
  v_current public.legal_documents%rowtype;
  v_new_id  uuid;
  v_body    text := $t$
## About this policy

This policy sets out how long GetSetPaid keeps different kinds of data, what deletes it when that period ends, and -- just as important -- what is **not** deleted automatically today.

**These periods are working defaults.** They are pending review by qualified legal counsel and may change before launch. [Counsel to confirm: each retention period below.]

## What is deleted automatically, and when

A scheduled job deletes each of these once its period has passed.

- **The file behind a deleted document:** 2 years after the document was deleted -- or 7 years if the document is attached to an event that carries financial entries. It is the file that is deleted. The document's record (its name, size and dates) stays with the workspace, marked to show that the file was removed under this policy, and a document whose file has been removed can no longer be restored.
- **In-app feedback,** including any screenshot: 2 years from submission.
- **Security audit records:** searchable by our operator for 30 days, kept for up to 1 year in total, then deleted. Both limits are applied. **"Archived" here means less than it sounds like, and we would rather say so:** after 30 days the record is still in the same database and our operator can still find it by setting a date -- it simply stops appearing in their default view. There is no separate archive store. At one year the record is deleted.
- **A suspended or closed workspace:** 60 days from suspension or closure, during which it can be reopened. Closing a workspace that was already suspended starts the 60 days again. After that the workspace and everything in it -- its records, its documents and their files -- is permanently deleted.
- **Export archives** (a copy of your account data, or of a workspace's records, that someone asked us to prepare): 7 days from when the file is ready. After that nobody can download it, and the file is deleted. Its contents are a copy of records that are themselves kept under the rules on this page.
- **Security alerts raised for our operator:** 1 year after the alert was resolved. An alert that has not been resolved is not deleted at any age.
- **The record of an account deletion that failed:** 90 days after it failed. That record names the person and says why the deletion did not happen. The record of a deletion that succeeded is kept: it no longer identifies anyone, and it is the evidence that the deletion was carried out.
- **Rate-limit counters** (how many requests an account or a workspace made in a recent window): 7 days after that window closed.
- **Stored files that no record refers to** (for example, left behind by an upload that did not complete): 1 day.

One step of that job is not a deletion. An export, or an account deletion, that has been stuck "in progress" for more than 1 hour is marked as failed so that the person can ask again. Nothing is deleted by that step.

## What is not deleted automatically

We would rather say this plainly than let the list above imply otherwise.

- **Records a workspace has deleted** -- contacts, companies, artists, agencies, venues and venue rooms, events, tasks, meetings, notes and financial entries. Deleting one of these hides it and lets the workspace restore it. **No period removes it after that.** It stays, restorable, for as long as the workspace exists, and is permanently deleted only when the workspace itself is (above). One exception: a person's private notes are deleted with their account -- see [Data Subject Rights](/legal/data-subject-rights).
- **Financial records** (event budgets and actuals): our working default is to keep them for 7 years. **Nothing deletes them when the 7 years end.** The 7 years is how long we expect to need to be able to produce them, not a deletion date that anything applies today. [Counsel to confirm: whether financial records must be deleted at the end of the period, and if so from what date the period runs.]
- **Inactive account data:** our working default is 2 years from last use. **No automated process applies it today:** an account that is not used is not deleted, and neither is its data. [Counsel to confirm: whether to delete inactive accounts and workspaces, and the notice to give before doing so.]
- **Consent records and the register of data subject requests** are kept. They are the evidence that a choice was recorded, or that a request was answered on time. A consent record is deleted with the account it belongs to; a request survives an account deletion with the person's details removed.
- **Published versions of these legal pages** are kept permanently, so that what we said on a given date can always be shown.
- **The record of each run of the deletion job** -- what it removed and what it refused to, as counts only -- is kept.

## A deleted account

**A deleted account:** the account itself is removed immediately and cannot be restored. What remains is the security audit record of what that person did, with their identity replaced by a shared "erased user" marker, and financial records with their name removed. The [Data Subject Rights](/legal/data-subject-rights) page lists all of it.

## How deletion works

Deleting a record in a workspace hides it, and it can be restored. As the section above says, that is not the start of a countdown: nothing permanently deletes a workspace's own deleted records while the workspace exists.

**Deleting an account is the exception, and it is deliberate.** When someone asks for their account to be deleted, it is removed at once rather than hidden first: there is no restore, no waiting period and no way for us to bring it back. It either completes in full or it does not happen at all -- we never delete part of an account -- and if anything stops it, nothing is changed and the person is told why.

**Automated deletion runs.** A scheduled job goes through the periods under "What is deleted automatically" and deletes what has passed them. **It is not instant, and we would rather be exact than reassuring.** It runs about once an hour, and only one run happens at a time; each run is deliberately bounded, so a large backlog is cleared over several runs rather than all at once; and a deletion that fails is tried again rather than forgotten. So a record can outlive its period by hours, and in an unusual case by longer -- what does not happen is that it is quietly kept indefinitely. Every run is recorded, including what it removed and anything it refused to.

**If the job cannot safely run, it deletes nothing.** Before it touches anything it checks that every kind of data we store has been given a rule on this page's terms, and that the dates it works from cannot be set by the people whose data it deletes. If either check fails it stops before deleting a single file or record, and our operator is alerted. We would rather the job stop than delete part of what it should.

## Legal holds

We may keep data for longer where the law requires it, or where it is needed to establish, exercise or defend a legal claim.

## Backups

Our database is backed up by our hosting provider. Backups expire on the provider's schedule; data deleted from the service leaves the backups when they expire. [Counsel to confirm: the backup retention period to state here.]

## Customer records

For records a customer organisation keeps in its own workspace, the organisation is responsible for deciding what to keep. It can delete a record, which hides it, and it can ask us to close the workspace, which leads to permanent deletion after 60 days. **The service does not currently offer a way to permanently delete a single record.** [Counsel to confirm: whether one is required before launch.]
$t$;
begin
  select * into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';

  -- THIS TEXT WAS WRITTEN AGAINST VERSION 5. If the page has moved -- counsel
  -- has published through /super/legal -- a body built here is built on an
  -- assumption, and the correction belongs in the editor.
  if v_current.version <> 5 then
    raise exception 'legal retention v6: the published data-retention page is version %, not the version 5 this correction was written against -- make it through /super/legal', v_current.version;
  end if;

  -- The correction as a DRAFT of the next version, with no review marker.
  insert into public.legal_documents (slug, version, title, effective_date, body)
  values (v_current.slug, v_current.version + 1, v_current.title,
          (now() at time zone 'Europe/London')::date, v_body)
  returning id into v_new_id;

  -- Supersede first, then publish -- as public.publish_legal_document() does.
  update public.legal_documents d
     set status = 'superseded', superseded_at = now()
   where d.id = v_current.id;

  -- m4: BY ID. v5's migration published every `draft` of the slug, which would
  -- have promoted a second draft counsel had open in the editor.
  update public.legal_documents d
     set status = 'published', published_at = now()
   where d.id = v_new_id;

  if (select count(*) from public.legal_documents
       where slug = 'data-retention'
         and status = 'published'
         and version = 6
         and counsel_reviewed_at is null
         and body like '%## What is not deleted automatically%'
         and body like '%**No period removes it after that.**%'
         and body like '%**No automated process applies it today:**%'
         and body like '%**Nothing deletes them when the 7 years end.**%'
         and body like '%90 days after it failed%'
         and body like '%There is no separate archive store.%'
         and body not like '%When a period ends, the data is permanently deleted or anonymised%'
         and body not like '%still being built%') <> 1 then
    raise exception 'legal retention v6: expected exactly one published, unreviewed Data Retention version 6 that says what is NOT deleted, states the 90-day failed-deletion period, and no longer promises that every period ends in deletion';
  end if;
end;
$do$;
