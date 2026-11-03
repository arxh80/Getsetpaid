-- ===========================================================================
-- Phase 8 Task 3, FIX ROUND 1 (review finding M5): Your Data Protection
-- Rights, version 3.
--
-- Version 2 (20260924002000) is published and therefore immutable, so this is
-- a new version by the same route. Three corrections, all the reviewer's:
--
--   (a) THE PAGE CONTRADICTED ITSELF. "What you write ... is never shown to
--       anyone else" sat two sections above "we pass it to that organisation".
--       Passing a request on necessarily shows that organisation that the
--       person asked, and in practice what they asked. The promise is now the
--       narrow one the product can keep -- never published, never in the
--       security log -- with the one exception stated where it is made, and
--       the fact that we tell the person which business we asked.
--   (b) "EMAIL IS NEVER LIMITED" is a promise about a mailbox this repository
--       does not operate: nothing here can guarantee what an inbox provider
--       does. The sentence now says what IS in our gift -- the form's ten-a-day
--       limit does not apply to email -- which is the whole point of the
--       sentence (the limit can never be the reason a request cannot be made).
--   (c) THE PROCEDURE FOR A NO-ACCOUNT REQUEST IS WRITTEN DOWN, on the page
--       and in SECURITY.md section 8. Version 2 said "We will then verify your
--       identity another way before we act" and left "another way" undefined;
--       email intake is live today by the page's own invitation, so the
--       procedure is owed now rather than when a later task formalises it.
--       What it says follows the ICO's position: ask only for what is
--       necessary and proportionate, disclose nothing until satisfied, and
--       the month runs from the day the identifying information arrives
--       (UK GDPR Art 12(6)).
--
--   (d) AND THE ROUTING SENTENCE MATCHES THE PRODUCT (review finding I7 /
--       Q160b). "we pass it to that organisation" reads as delivery; nothing
--       in GetSetPaid notifies a business that a request exists, so the
--       handover is an email the operator writes by hand. The page says that,
--       and says we tell the person which business was asked.
--
-- WHAT THIS PAGE STILL DOES NOT SAY, because it is not true yet: that an
-- emailed request is tracked the way a form one is. It is not -- no write path
-- into public.data_subject_requests takes a user argument (by design: that is
-- what makes a request unforgeable), so an email request exists only in the
-- support mailbox, with no row, no computed deadline and no overdue alert.
-- SECURITY.md section 8 says so, and DECISIONS-QUEUE Q161 asks what to do
-- about it. The page promises a 30-day answer either way, which is the
-- obligation; the machinery that watches the clock covers only one of the two
-- routes.
--
-- The "[Counsel to confirm: the controller and processor characterisation
-- above.]" gap is KEPT (Q132), as version 2 kept it.
--
-- HOW: exactly as 20260924002000. The new body is the CURRENT published body
-- with four exact passages replaced; a passage that is not found (the operator
-- revised the page on this deployment) fails the migration loudly rather than
-- guessing. Inserted as a draft with no counsel review marker and published by
-- transition, so the page keeps its "draft pending legal review" notice. Not
-- legal advice; not reviewed.
--
--   data-subject-rights  version 2 -> 3
--
-- ADDITIVE. No applied migration or published row is edited except by the one
-- transition the guard permits (published -> superseded).
-- ===========================================================================

create temporary table legal_dsr3 (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  select body into strict v_current
    from public.legal_documents where slug = 'data-subject-rights' and status = 'published';

  -- (b) and the pointer to the new section, (c).
  v_next := replace(v_current,
$t$If you do not have a GetSetPaid account, or you cannot sign in, email {{support_email}} instead. We will then verify your identity another way before we act. The form is limited to ten requests a day; email is never limited, so the limit can never be the reason a request cannot be made.$t$,
$t$If you do not have a GetSetPaid account, or you cannot sign in, email {{support_email}} instead. We will then check who you are another way, as set out in the section below on what happens if you cannot sign in, before we act. The form is limited to ten requests a day. That limit does not apply to email: we do not turn a request away for arriving by email too often, so the limit can never be the reason a request cannot be made.$t$);
  if v_next = v_current then
    raise exception 'legal dsr3: the data-subject-rights page no longer carries version 2 intake paragraph -- correct it through /super/legal';
  end if;

  -- (c) the procedure itself.
  v_next := replace(v_next,
$t$which is why the form is only for people who can sign in.

## What we record about a request$t$,
$t$which is why the form is only for people who can sign in.

## If you cannot sign in

When a request reaches us by email from someone who cannot sign in, we do not act on it until we are satisfied that it comes from the person the data is about, and we ask for as little as we can to be satisfied of that. We:

- reply to the address the request came from and ask which email address or addresses we would hold you under, and enough about the records to find them — for example the business whose workspace they are in;
- tell you nothing about what we hold, or whether we hold anything at all, until we are satisfied who you are;
- prefer a check that uses what we already have, such as a reply from an address already on an account. We do not ask for a copy of an identity document unless nothing less will do; if we do, we ask to see only what we need and we keep no copy of it once the request is answered;
- ask for more only where there is real doubt. Where we have to ask, the month we have to answer in runs from the day we have what we need to be sure who you are, and we tell you which day that is;
- keep a record of what we checked and when, with the request, so that how we satisfied ourselves can be looked at later.

Being satisfied who you are is a judgement we have to make rather than a test you have to pass. If we cannot be satisfied, we tell you so in writing and say why, and you can complain to the ICO about that decision as you can about any other.

## What we record about a request$t$);

  -- (a) the promise the product can actually keep.
  v_next := replace(v_next,
$t$What you write is read by us to answer the request, and is never published, never shown to anyone else, and never copied into our security log.$t$,
$t$What you write is read by us to answer the request. It is never published, and it is never copied into our security log: that log records that a request was made and how long what you wrote was, never the words themselves. There is one exception, and it is the subject of the next section. If your request is about the records a business keeps about you, we have to tell that business that you asked and what you asked for, because it is the one that must answer you — and we tell you which business we asked.$t$);

  -- (d) routing as it really works.
  v_next := replace(v_next,
$t$If you send us the request instead, we pass it to that organisation and record that we did; the organisation, not GetSetPaid, must answer it, and we help it do so.$t$,
$t$If you send us the request instead, we ask that organisation to answer it and record that we did, including which organisation it was and when — we write to it ourselves, because nothing in GetSetPaid tells a business that a request about it exists. We tell you which business we asked. That organisation, not GetSetPaid, must answer you, and we help it do so.$t$);

  insert into legal_dsr3 values ('data-subject-rights', v_next);
end;
$do$;

-- The correction as a DRAFT of the next version, with no review marker.
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_dsr3 v on v.slug = p.slug
 where p.status = 'published';

-- Supersede first, then publish -- as public.publish_legal_document() does.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_dsr3);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_dsr3);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published' and slug = 'data-subject-rights'
         and version = 3
         and counsel_reviewed_at is null
         and body like '%## If you cannot sign in%'
         and body like '%That limit does not apply to email%'
         and body not like '%email is never limited%'
         and body not like '%never shown to anyone else%'
         and body like '%[Counsel to confirm: the controller and processor characterisation above.]%'
         and effective_date = (now() at time zone 'Europe/London')::date) <> 1 then
    raise exception 'legal dsr3: expected data-subject-rights version 3, published, unreviewed, carrying the identity procedure and keeping the counsel gap';
  end if;
end;
$do$;

drop table legal_dsr3;
