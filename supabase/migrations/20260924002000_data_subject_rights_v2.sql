-- ===========================================================================
-- Phase 8 Task 3: Your Data Protection Rights, version 2.
--
-- Version 1 (20260922001000) was written before the workflow existed. It said
-- "Email {{support_email}} ... A self-service request form is being built."
-- The form is built (/account/data-requests), the 30 days is a deadline the
-- database computes and alerts on rather than an intention, and the
-- controller/processor split is a column on the request rather than a
-- description of how we would behave.
--
-- What version 2 says, and why each sentence is true of the code:
--   * where the form is, and that being signed in IS the identity check
--     (private.data_subject_requests_before_insert() stamps the requester from
--     the session; no write path takes a user argument);
--   * that a person with no account, or who cannot sign in, emails instead --
--     the only other intake, and it is deliberately not a form;
--   * what we record about a request, and that we never publish it or put it
--     in the security log (the audit payloads carry lengths, not text);
--   * that a request can be withdrawn at any time, in one press;
--   * that a request about a business's records is passed to that business,
--     naming it as the controller (Q132);
--   * that the form is limited to ten requests a day and email never is.
--
-- The "[Counsel to confirm: the controller and processor characterisation
-- above.]" gap is KEPT: shipping the routing does not settle the legal
-- characterisation, and Q132 still says counsel confirms it.
--
-- HOW: exactly as 20260923001000. The new body is the CURRENT published body
-- with two exact passages replaced; a passage that is not found (the operator
-- revised the page on this deployment) fails the migration loudly rather than
-- guessing. Inserted as a draft with no counsel review marker and published by
-- transition, so the page keeps its "draft pending legal review" notice. Not
-- legal advice; not reviewed.
--
--   data-subject-rights  version 1 -> 2
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_dsr2 (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  select body into strict v_current
    from public.legal_documents where slug = 'data-subject-rights' and status = 'published';

  v_next := replace(v_current,
$t$## How to make a request

Email {{support_email}} from the address on your account, saying which right you want to use. A self-service request form is being built.

## Checking it is you

We only act on a request once we are satisfied it comes from the person the data is about. Usually that means the request comes from the email address on the account; if it does not, we will ask you to confirm through the account.$t$,
$t$## How to make a request

Sign in and go to [your data protection requests](/account/data-requests). Choose which right you want to use, tell us what you are asking for, and send it. The page then shows the request, the date we must answer by, and what happened to it. You can withdraw a request at any time before it is answered, in one press and with nothing else to confirm.

If you do not have a GetSetPaid account, or you cannot sign in, email {{support_email}} instead. We will then verify your identity another way before we act. The form is limited to ten requests a day; email is never limited, so the limit can never be the reason a request cannot be made.

## Checking it is you

Being signed in is how we know the request is yours. A request is recorded against the account it was made from and the email address on that account, and neither can be typed in or changed — which is why the form is only for people who can sign in.

## What we record about a request

We keep: the account that made it and its email address; which right you are exercising; whether it is about your account or about a business's records; what you wrote; the date we received it and the date we must answer by; and what we did and when. What you write is read by us to answer the request, and is never published, never shown to anyone else, and never copied into our security log.$t$);
  if v_next = v_current then
    raise exception 'legal dsr2: the data-subject-rights page no longer carries its version 1 "How to make a request" section -- correct it through /super/legal';
  end if;

  v_next := replace(v_next,
$t$- **Records an organisation keeps about you** (for example, you are a contact or an artist in a promoter's workspace): that organisation is the controller and we process the records on its behalf. Ask the organisation. If you contact us instead, we will tell you which organisation to approach and help it respond.$t$,
$t$- **Records an organisation keeps about you** (for example, you are a contact or an artist in a promoter's workspace): that organisation is the controller and we process the records on its behalf. Ask the organisation. If you send us the request instead, we pass it to that organisation and record that we did; the organisation, not GetSetPaid, must answer it, and we help it do so.$t$);

  insert into legal_dsr2 values ('data-subject-rights', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_dsr2 v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_dsr2);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_dsr2);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published' and slug = 'data-subject-rights'
         and version = 2
         and counsel_reviewed_at is null
         and body like '%(/account/data-requests)%'
         and body like '%[Counsel to confirm: the controller and processor characterisation above.]%'
         and effective_date = (now() at time zone 'Europe/London')::date) <> 1 then
    raise exception 'legal dsr2: expected data-subject-rights version 2, published, unreviewed, naming the form and keeping the counsel gap';
  end if;
end;
$do$;

drop table legal_dsr2;
