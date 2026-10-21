-- ===========================================================================
-- Phase 8 Task 1, fix round 1: version 2 of four legal pages -- corrections
-- to statements version 1 made that the codebase does not establish.
--
-- A PUBLISHED VERSION IS IMMUTABLE (20260922000000), and so is the migration
-- that seeded it (20260922001000). So the correction is what the product
-- intends for any correction: a NEW version, published, which supersedes the
-- old one. Like the seed, each new version is inserted as a draft with no
-- counsel-review marker and published by transition -- so every one of these
-- pages still shows the "draft pending legal review" notice. Nothing here is
-- legal advice or has been reviewed.
--
-- WHAT EACH VERSION CORRECTS
--
--   security (I2) -- version 1 said, unconditionally, that two-factor
--     authentication "is checked at every sign-in", that "you are signed out
--     after 30 minutes without activity", that failed password attempts lock
--     password sign-in "and the account holder is emailed", and that the
--     hosting provider "encrypts stored data and serves all connections over
--     TLS". SECURITY.md § 15 says the first three exist on a deployment only
--     once hand-set hosted configuration is in place (the lockout hook fails
--     SILENTLY if it is never enabled), and the fourth is a vendor's claim
--     nobody here has verified -- while the same page left out the 12-hour
--     limit for exactly the § 15 reason. Version 2 applies ONE rule to every
--     sentence: a control that depends on deployment configuration is marked
--     "(deployment setting)"; a provider's claim is attributed to the
--     provider and said to be unverified; nothing unverified is stated as
--     fact. "We monitor the alerts above" (a process claim) is gone, and the
--     12-hour limit is back, marked like its siblings.
--
--   privacy, data-processing-addendum (M1) -- version 1 said "We do not
--     transfer personal data outside the UK and EEA" and "The only
--     subprocessor outside the UK is in the EEA". Neither is established: no
--     application host appears in the subprocessor register although the
--     application servers see every request (FOLLOW-UPS.md implies Vercel),
--     and the database provider is Supabase, Inc., incorporated in the United
--     States, with no data processing agreement signed. Version 2 replaces
--     the assertion with a bracketed "[Counsel to confirm: ...]" gap naming
--     exactly those two facts. No vendor is added to the register here -- a
--     vendor joins it in the change that first sends it personal data
--     (DECISIONS-QUEUE Q142 holds the hosting-provider question).
--
--   data-retention (M2) -- version 1 said audit records are "searchable by
--     our operator for 30 days" and afterwards stay "outside the default
--     view". Neither the audit-log policy nor /super/audit-log applies any
--     time window: every row is searchable for as long as it exists. Version
--     2 states the 30-day / 1-year periods as the target and says plainly
--     that neither limit is applied yet (the Phase 8 retention job, Task 6,
--     is what will apply them).
--
-- HOW. Each new body is the CURRENT published body with exact passages
-- replaced (security is rewritten whole). If a passage is not found -- the
-- page was revised by the operator on this deployment since the seed -- the
-- migration fails loudly rather than guessing; that deployment needs a human
-- to make the same correction through /super/legal. The same happens if a
-- draft of one of these pages is open (one draft per document).
--
-- The effective date is the day this migration runs, in London, as the
-- seed's was. Not audited: like the seed, a migration has no acting user,
-- and this file is the record.
--
-- ADDITIVE. No previously applied migration or published row is edited
-- except by the one transition the guard permits (published -> superseded).
-- ===========================================================================

-- A scratch table for the four new bodies, dropped at the end of this file.
create temporary table legal_v2 (slug text primary key, body text not null);

do $do$
declare
  v_current text;
  v_next    text;
begin
  -- Each step replaces one exact passage and refuses if it was not found.
  -- ---------------------------------------------------------------- privacy
  select body into strict v_current
    from public.legal_documents where slug = 'privacy' and status = 'published';

  v_next := replace(v_current,
$t$Our database and file storage are hosted in the UK/EU region. Transactional email is sent through a provider in France, which is covered by the UK's adequacy regulations. We do not transfer personal data outside the UK and EEA.$t$,
$t$Our database and file storage are hosted in a UK/EU region. Transactional email is sent through a provider in France, which is covered by the UK's adequacy regulations.

[Counsel to confirm: whether any personal data is transferred outside the UK and EEA, and on what basis. Two facts are not settled yet: our database provider, Supabase, Inc., is incorporated in the United States and its data processing agreement has not been signed; and the provider that hosts the application servers, which handle every request to the service, is not yet listed as a subprocessor.]$t$);
  if v_next = v_current then
    raise exception 'legal v2: the privacy notice no longer carries the version 1 transfer sentence -- correct it through /super/legal';
  end if;
  v_current := v_next;

  v_next := replace(v_current,
$t$- **Our service providers** process data on our behalf under contract; they are listed on the [Subprocessors](/legal/subprocessors) page.$t$,
$t$- **Our service providers** process data on our behalf under contract. The providers assessed so far are listed on the [Subprocessors](/legal/subprocessors) page; see the note under "Where it is stored".$t$);
  if v_next = v_current then
    raise exception 'legal v2: the privacy notice no longer carries the version 1 service-provider sentence -- correct it through /super/legal';
  end if;
  insert into legal_v2 values ('privacy', v_next);

  -- ------------------------------------------------ data-processing-addendum
  select body into strict v_current
    from public.legal_documents where slug = 'data-processing-addendum' and status = 'published';

  v_next := replace(v_current,
$t$Customer data is hosted in the UK/EU region. The only subprocessor outside the UK is in the EEA, covered by the UK's adequacy regulations.$t$,
$t$Customer data is hosted in a UK/EU region. Transactional email is sent through a subprocessor in France, which is covered by the UK's adequacy regulations.

[Counsel to confirm: whether any transfer outside the UK and EEA takes place, and the safeguards for it. Our database provider, Supabase, Inc., is incorporated in the United States and its data processing agreement has not been signed; and the provider that hosts the application servers is not yet listed on the Subprocessors page.]$t$);
  if v_next = v_current then
    raise exception 'legal v2: the DPA no longer carries the version 1 transfer sentence -- correct it through /super/legal';
  end if;
  insert into legal_v2 values ('data-processing-addendum', v_next);

  -- ---------------------------------------------------------- data-retention
  select body into strict v_current
    from public.legal_documents where slug = 'data-retention' and status = 'published';

  v_next := replace(v_current,
$t$- **Security audit records:** searchable by our operator for 30 days and kept for up to 1 year in total, then deleted. We do not yet have a separate archive store; for the rest of that year the records stay in our database outside the default view.$t$,
$t$- **Security audit records:** the target is that they are searchable by our operator for 30 days and kept for up to 1 year in total, then deleted. Neither limit is applied yet: today every record stays in our database, and searchable by our operator, for as long as it is stored. There is no separate archive store.$t$);
  if v_next = v_current then
    raise exception 'legal v2: the retention policy no longer carries the version 1 audit sentence -- correct it through /super/legal';
  end if;
  insert into legal_v2 values ('data-retention', v_next);

  -- ---------------------------------------------------------------- security
  -- Rewritten whole: the rule applies to every sentence, not to a passage.
  perform 1 from public.legal_documents where slug = 'security' and status = 'published';
  if not found then
    raise exception 'legal v2: no published security page';
  end if;
  insert into legal_v2 values ('security', $t$
## Our approach

This page describes the security measures GetSetPaid has in place today, and says which of them depend on how a deployment is set up.

Some protections are written into the service itself and apply wherever it runs. Others are settings in our hosting and authentication providers' dashboards: they are on our pre-launch checklist, but the service's code cannot switch them on or tell that they are off, so each is marked **(deployment setting)** below. What our providers say about their own security is attributed to them; we have not verified it independently.

## Keeping workspaces separate

- Every request for data is checked in the database itself, using row-level security, against the signed-in user and their workspace memberships, so one workspace's records are not returned to another. Our automated tests check this across every kind of record.
- Network profiles are shown through a separate path that exposes only the fields an organisation chose to publish. Private records are never joined into it.

## Signing in

- You can sign in with a password or an emailed link. Google sign-in is available where it is enabled for the deployment **(deployment setting)**.
- Owners, admins and finance users must use two-factor authentication. The database refuses their protected actions until a second factor has been verified in the current session, and that check is part of the service. Enrolling and verifying the factor relies on our authentication provider's two-factor settings being switched on **(deployment setting)**.
- Sensitive operator actions ask you to confirm your identity again first.
- The service signs you out in your browser after 30 minutes without activity. The limits that end a session on the server, after 30 minutes without activity or 12 hours in total, are settings of our authentication provider **(deployment setting)**.
- After repeated failed password attempts, password sign-in to that account is locked for a period. This relies on a sign-in check being enabled in our authentication provider **(deployment setting)**, and the email that tells the account holder relies on our email provider being set up **(deployment setting)**.

## Limiting abuse

- Searches and network browsing in the app, connection requests and feedback are rate limited.
- Rate-limit breaches and blocked uploads are recorded as alerts for our operator, and so are repeated failed sign-ins where the sign-in check above is enabled. Alerts are shown to our operator in the service, and emailed to them where email delivery is set up **(deployment setting)**.

## Files

- Uploaded files are kept in private storage and are never publicly addressable.
- Files are checked by their contents, not their names, against an allowlist of document and image types. Executables and macro-enabled Office files are refused.
- Downloads are authorised first, logged, and served through links that expire after 60 seconds.
- Every upload passes through a scanning step, and a file it flags is held back and never served. The scanning step does not yet detect real malware; see below.

## Accountability

- Significant actions are recorded in an append-only audit log with the actor, time, action and target.
- Our operator cannot browse customer records. Support access to a workspace requires that workspace's owner or admin to approve a request; access is read-only, lasts at most 60 minutes, and every page viewed is logged.

## Where data lives

- Our database and file storage are hosted by Supabase in a UK/EU region. The region is chosen in our hosting account **(deployment setting)**.
- Supabase states that it encrypts stored data and that connections to it use TLS. We rely on that statement; we have not verified it ourselves.
- [Counsel to confirm: the provider that hosts the application servers, which handle every request, with its location and transfer basis. It is not yet listed on our Subprocessors page.]
- Our current subprocessors are listed on the [Subprocessors](/legal/subprocessors) page.

## Incidents

We will notify the Information Commissioner's Office of a notifiable personal data breach without undue delay and, where feasible, within 72 hours of becoming aware of it, and tell affected customers without undue delay.

## What is not in place yet

- **Malware detection.** The production malware-scanning engine is not connected yet, so the scanning step above does not yet detect real malware.
- **Independent testing.** We have not yet had an independent penetration test. It is planned before launch.
- **A formal incident runbook** and on-call rota are still being written.
- **Proof of the deployment settings.** The settings marked above are on our pre-launch checklist. This page does not by itself show that they are switched on for the service you are using.

## Reporting a vulnerability

See our [Vulnerability Disclosure Policy](/legal/vulnerability-disclosure).
$t$);
end;
$do$;

-- Each correction as a DRAFT of the next version, with no review marker (the
-- guard refuses an insert that carries one).
insert into public.legal_documents (slug, version, title, effective_date, body)
select p.slug, p.version + 1, p.title, (now() at time zone 'Europe/London')::date, v.body
  from public.legal_documents p
  join legal_v2 v on v.slug = p.slug
 where p.status = 'published';

-- Supersede FIRST (one published version per slug is checked per statement),
-- then publish -- exactly as public.publish_legal_document() does. No
-- published_by: a migration has no user.
update public.legal_documents d
   set status = 'superseded', superseded_at = now()
 where d.status = 'published'
   and d.slug in (select slug from legal_v2);

update public.legal_documents d
   set status = 'published', published_at = now()
 where d.status = 'draft'
   and d.slug in (select slug from legal_v2);

do $do$
begin
  if (select count(*) from public.legal_documents
       where status = 'published' and slug in ('privacy', 'data-processing-addendum', 'data-retention', 'security')
         and counsel_reviewed_at is null
         and effective_date = (now() at time zone 'Europe/London')::date) <> 4 then
    raise exception 'legal v2: expected four newly published, unreviewed versions';
  end if;
end;
$do$;

drop table legal_v2;
