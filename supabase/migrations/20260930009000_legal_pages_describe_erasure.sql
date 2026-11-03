-- ===========================================================================
-- PHASE 8 TASK 5: THE TWO LEGAL PAGES THAT NOW SAY TOO LITTLE.
--
-- Shipping erasure makes prose about it out of date, and published versions
-- are immutable, so each correction is a new version by the route
-- 20260925004000 and 20260927008000 used.
--
--   (a) YOUR DATA PROTECTION RIGHTS, version 4 -> 5. The page lists "delete
--       your data (erasure)" as a right and then says nothing about what
--       happens when you exercise it. Everything Task 5 actually does is the
--       sort of thing a person is entitled to know BEFORE they press the
--       button and cannot know afterwards: that we keep the audit trail with
--       their name taken off it, that financial records stay for seven years,
--       that the request itself is kept as the evidence we answered it, and
--       that being the last owner of a workspace stops the deletion until
--       somebody else owns it. The page also gains the self-service route,
--       exactly as version 4 gained the self-service export.
--
--       THE HONEST-ABOUT-WHAT-SURVIVES REQUIREMENT IS THE BRIEF'S, and the
--       wording below is deliberately specific rather than reassuring: "we
--       keep a record of what happened and remove who did it" is a claim a
--       reader can check against the product, and "we delete everything" is
--       not, because it would be false.
--
--   (b) DATA RETENTION POLICY, version 3 -> 4. Two gaps. The schedule has no
--       line for what an account erasure leaves behind, and "How deletion
--       works" says most records are soft-deleted first -- which is true of
--       everything EXCEPT this one path: an erasure is a hard delete, in one
--       transaction, with no restore.
--
-- THE PRIVACY NOTICE IS DELIBERATELY NOT REISSUED. Its rights section points
-- at the Data Subject Rights page rather than restating what each right does
-- (measured on the live body), so nothing in it became false; a version whose
-- only change is a cross-reference to a page that already answers the
-- question is a version counsel has to read for no benefit. The brief names
-- it as a candidate, not a requirement, and this is the reason it is not
-- taken.
--
-- NOT LEGAL ADVICE AND NOT REVIEWED. Each lands as a new version with no
-- counsel review marker, so every page keeps its "draft pending legal review"
-- notice -- which the database will not let a migration claim otherwise.
--
-- HOW: the new body is the CURRENT published body with exact passages
-- replaced; a passage that is not found (the operator revised the page on
-- this deployment) fails the migration loudly rather than guessing.
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_erasure_v (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  -- ---- (a) the rights page ----------------------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-subject-rights' and status = 'published';

  v_next := replace(v_current,
$t$## Checking it is you$t$,
$t$## Deleting your account, and what survives it

You can delete your GetSetPaid account yourself: sign in and go to [delete your account](/account/erase). The page says what goes and what stays before anything is pressed, and asks you to type a phrase to confirm. **It cannot be undone.** If you would rather make a formal request, the route below does the same thing and starts the 30-day clock.

What is deleted: your sign-in (your email address, your password and any two-factor factors), your profile, your membership of every workspace, your private notes, your marketing choices, the feedback you have sent us and any screenshots with it, and any copies of your data you asked us to prepare.

What we keep, and why:

- **A workspace's own records** -- its contacts, artists, events, documents and finances -- belong to the business that keeps them, not to your account. They stay, and they stop being attributed to you. If you are a contact in a business's workspace, that business is the controller of that record and the section above on who to ask explains how to reach it.
- **Notes you marked as visible to a workspace** stay with that workspace, with your name removed. Notes you marked private go with you.
- **The security audit record.** We keep what happened and remove who did it: every entry of yours is re-pointed at a single shared "erased user" identity that nobody can sign in as, and any description of the change is dropped. We keep it because it is the evidence that this product did what it says it does, and because we are obliged to be able to show that.
- **Financial records** are kept for seven years, as the law requires. Your name comes off them.
- **Your data protection requests, including the one that asked for this.** The request is kept without your email address and without anything you wrote in it. It is the evidence that we answered you inside the legal deadline, and deleting it would destroy the record of the very thing you asked for.

Two consequences worth knowing before you start. If you are the **only owner of a workspace that still has other people or records in it**, we cannot delete your account yet: doing so would leave that workspace with nobody able to manage it. Make somebody else an owner, or close the workspace, and then ask again -- the page tells you which workspaces are in the way. And if you are the only person in a workspace and there is nothing in it, that workspace is deleted with you.

**Take a copy first if you want one.** Once your account is gone we cannot give you one, because there is no longer an account to give it to.

## Checking it is you$t$);
  if v_next = v_current then
    raise exception 'legal erasure: the data-subject-rights page no longer carries the version 4 identity heading -- correct it through /super/legal';
  end if;
  insert into legal_erasure_v values ('data-subject-rights', v_next);

  -- ---- (b) the retention policy ------------------------------------------
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';

  v_next := replace(v_current,
$t$- **Export archives** (a copy of your account data, or of a workspace's records, that someone asked us to prepare): 7 days from when the file is ready. After that nobody can download it. Its contents are a copy of records that are themselves kept under the rules above.$t$,
$t$- **Export archives** (a copy of your account data, or of a workspace's records, that someone asked us to prepare): 7 days from when the file is ready. After that nobody can download it. Its contents are a copy of records that are themselves kept under the rules above.
- **A deleted account:** the account itself is removed immediately and cannot be restored. What remains is the security audit record of what that person did, with their identity replaced by a shared "erased user" marker, and financial records for their seven years with their name removed. The [Data Subject Rights](/legal/data-subject-rights) page lists all of it.$t$);
  if v_next = v_current then
    raise exception 'legal erasure: the data-retention page no longer carries the version 3 export-archives line -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$Most records are soft-deleted first: they disappear from the service but can be restored until the retention period ends. When a period ends, the data is permanently deleted or anonymised.$t$,
$t$Most records are soft-deleted first: they disappear from the service but can be restored until the retention period ends. When a period ends, the data is permanently deleted or anonymised.

**Deleting an account is the exception, and it is deliberate.** When someone asks for their account to be deleted, it is removed at once rather than hidden first: there is no restore, no waiting period and no way for us to bring it back. It either completes in full or it does not happen at all -- we never delete part of an account -- and if anything stops it, nothing is changed and the person is told why.$t$);
  if v_next = v_current then
    raise exception 'legal erasure: the data-retention page no longer carries the version 3 soft-delete paragraph -- correct it through /super/legal';
  end if;
  insert into legal_erasure_v values ('data-retention', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_erasure_v v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_erasure_v);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_erasure_v);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published'
         and counsel_reviewed_at is null
         and ((slug = 'data-subject-rights' and version = 5
               and body like '%erased user%'
               and body like '%(/account/erase)%'
               and body like '%only owner of a workspace%')
           or (slug = 'data-retention' and version = 4
               and body like '%A deleted account:%'
               and body like '%never delete part of an account%'))) <> 2 then
    raise exception 'legal erasure: expected two new published, unreviewed versions describing erasure';
  end if;
end;
$do$;

drop table legal_erasure_v;
