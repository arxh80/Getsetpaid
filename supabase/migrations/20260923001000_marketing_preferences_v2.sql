-- ===========================================================================
-- Phase 8 Task 2: Marketing and Communications Preferences, version 2.
--
-- Version 1 (20260922001000) was written before the control existed. It said,
-- in the future tense, that "the preference controls [will be] added to your
-- account" and that "we will record when and how consent was given". Both now
-- exist (20260923000000 and /account/privacy), and a consent row records the
-- version of THIS page it was given against -- so the page a person agrees
-- under should describe the control they are using and what the record holds.
--
-- What version 2 says, and why each sentence is true of the code:
--   * where the control is, and that agreeing and withdrawing are one button
--     each (components/account/marketing-consent-form.tsx);
--   * that NO marketing email is sent today, whatever the choice
--     (lib/email/send.ts is transactional only; there is no marketing
--     sender, and tests/unit/consent/marketing-sender-census.test.ts makes a
--     future one call the consent check);
--   * exactly what a consent record holds, and that it holds no IP address
--     and no browser/device details (the columns of public.consents);
--   * that records are kept while the account exists, with the post-erasure
--     period left as a counsel gap (Task 5 decides the mechanism; the period
--     is counsel's).
--
-- HOW: exactly as 20260922005000 / 20260922006000. The new body is the
-- CURRENT published body with one exact passage replaced; a passage that is
-- not found (the operator revised the page on this deployment) fails the
-- migration loudly rather than guessing. Inserted as a draft with no counsel
-- review marker and published by transition, so the page keeps its "draft
-- pending legal review" notice. Not legal advice; not reviewed.
--
--   marketing-preferences  version 1 -> 2
--
-- ADDITIVE. No applied migration or published row is edited except by the
-- one transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_mp2 (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  -- -------------------------------------------------- marketing-preferences
  select body into strict v_current
    from public.legal_documents where slug = 'marketing-preferences' and status = 'published';

  v_next := replace(v_current,
$t$## If we start sending marketing

We will only send marketing messages to people who have opted in, and we will never make opting in a condition of using the service. Every marketing message will include a one-click way to unsubscribe, and withdrawing consent will be as easy as giving it. We will record when and how consent was given.

This page will be updated, and the preference controls added to your account, before any marketing message is sent.$t$,
$t$## Your marketing preference

You can agree to marketing email, or withdraw that agreement, on the [Privacy and communications](/account/privacy) page of your account. Agreeing and withdrawing are each a single button, and withdrawing never asks more of you than agreeing did. The choice belongs to your account, not to a workspace, and agreeing is never a condition of using the service.

**No marketing email is sent today, whatever you choose.** If that changes, only people whose current choice is to agree will receive it, every message will include a one-click way to unsubscribe, and this page will say so first.

## What we record when you choose

Each time you agree or withdraw, we keep a record of: your account; what the choice was about (marketing email); whether you agreed or withdrew; the date and time; the version of this page in force; that the choice was made on your account's privacy page; and which wording was shown next to the button. We do not record your IP address or any details of your browser or device for this.

We keep every record, earlier ones included, while your account exists, so that we can show when and on what terms you agreed. Your own history is shown on the same page.

[Counsel to confirm: how long consent records are kept after an account is closed or erased.]$t$);
  if v_next = v_current then
    raise exception 'legal mp2: the marketing-preferences page no longer carries its version 1 "If we start sending marketing" section -- correct it through /super/legal';
  end if;
  insert into legal_mp2 values ('marketing-preferences', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_mp2 v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_mp2);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_mp2);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published' and slug = 'marketing-preferences'
         and version = 2
         and counsel_reviewed_at is null
         and effective_date = (now() at time zone 'Europe/London')::date) <> 1 then
    raise exception 'legal mp2: expected marketing-preferences version 2, published and unreviewed';
  end if;
end;
$do$;

drop table legal_mp2;
