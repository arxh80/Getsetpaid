-- ===========================================================================
-- Phase 8 Task 1: version 1 of the fifteen legal pages -- ENGINEERING DRAFTS.
--
-- Written from PRD §12's content list for each page and from what this
-- codebase actually does at 20260922000000, not from generic boilerplate.
-- NONE OF THIS IS LEGAL ADVICE and none of it has been reviewed: every row is
-- inserted as a draft with no counsel-review marker (the guard in
-- 20260922000000 refuses an insert that carries one) and then published, so
-- every public page shows the "draft pending legal review" notice until the
-- platform superuser records counsel's review of a version at /super/legal.
--
-- Bracketed text -- "[Counsel to confirm: ...]" -- marks a statement only
-- counsel or the founder can supply (the company's legal identity, liability
-- terms, governing law). It is deliberately visible on the public page rather
-- than papered over with plausible wording.
--
-- Contact addresses are NEVER written here: the {{support_email}} placeholder
-- is filled from SUPPORT_CONTACT_EMAIL at render time (lib/legal/contact.ts).
-- The Cookie Policy and Subprocessors tables are generated from
-- lib/legal/storage-inventory.ts and lib/legal/sub-processors.ts through
-- their placeholders, so the prose here cannot drift from those lists.
--
-- The effective date is the day this migration runs, in London -- the day the
-- text first became visible on that deployment.
-- ===========================================================================

insert into public.legal_documents (slug, version, title, effective_date, body) values

('privacy', 1, 'Privacy Notice', (now() at time zone 'Europe/London')::date, $body$
## About this notice

This notice explains how GetSetPaid handles personal data: what we collect, why, who we share it with, how long we keep it and what rights you have. It applies to everyone who uses the service and to people whose details our customers store in it.

**Who we are.** [Counsel to confirm: the company's legal name, registered number and registered address.] You can reach us at {{support_email}}.

## The two roles we play

GetSetPaid is sold to organisations in the live events industry. We handle personal data in two different capacities, and the difference decides who you should ask about it.

- **We are the controller** of the data we need to run your account: your login, your profile, the workspaces you belong to and your role in them, the feedback you send us and the security and audit records the service keeps.
- **We are a processor** for the records a customer organisation keeps in its own workspace about other people, such as contacts, artists, agencies and venue staff. The customer organisation is the controller of those records and decides what is stored and why. If you want to know what an organisation holds about you, ask that organisation; we will help them answer. See [Your Data Protection Rights](/legal/data-subject-rights).

## What we collect

- **Account details:** your name, email address, how you sign in (password, an emailed link or Google) and, if you set one up, a two-factor authentication factor. Your password is stored only as a salted hash by our authentication provider; nobody at GetSetPaid can read it.
- **Workspace membership:** which workspaces you belong to, your role in each and who invited you.
- **Security and audit records:** a record of significant actions (who did what, to which record, and when). These records name records by identifier and do not copy their content. We also keep counters used for rate limiting and alerts raised by repeated failed sign-ins.
- **Feedback you send us:** your message and category, the page you were on (without any search terms), your browser's user-agent string, your email address and role, and a screenshot if you choose to attach one.
- **Network profiles:** only the fields your workspace chooses to publish to the GetSetPaid network.
- **Technical data:** our authentication provider records technical details of sign-in requests, such as IP address, for security.

We do not collect special category data, we do not use analytics or advertising trackers, and we do not sell personal data.

## Why we use it

- **To provide the service you signed up for** (contract): your account, your workspaces, the CRM and the network.
- **To keep the service and your account secure** (legitimate interests): audit records, rate limits, sign-in lockout, alerts and two-factor authentication.
- **To handle feedback you send us** (legitimate interests).
- **To meet legal obligations** (legal obligation): answering rights requests, notifying breaches and keeping financial records for the required period.
- **Consent** is used only where the law requires it: marketing messages and non-essential cookies. We send no marketing messages and set no non-essential cookies today; see [Marketing and Communications Preferences](/legal/marketing-preferences) and the [Cookie Policy](/legal/cookies).

We make no decisions about you by automated means.

## Who can see it

- **People in your workspaces** see your name, email address and role.
- **Other organisations on the network** see only the profile fields your workspace published. Fields published for connections only become visible after both organisations accept a connection request.
- **Our service providers** process data on our behalf under contract; they are listed on the [Subprocessors](/legal/subprocessors) page.
- **Our operator** sees platform-level information such as workspace names and record counts. Looking inside a workspace is possible only after that workspace's owner or admin approves a time-limited support-access request, and every page viewed is logged.
- **Authorities** where the law requires us to disclose information.

## Where it is stored

Our database and file storage are hosted in the UK/EU region. Transactional email is sent through a provider in France, which is covered by the UK's adequacy regulations. We do not transfer personal data outside the UK and EEA.

## How long we keep it

See the [Data Retention Policy](/legal/data-retention).

## Your rights

You can ask for access to, correction of, or deletion of your data, and in some cases restriction, objection or portability. See [Your Data Protection Rights](/legal/data-subject-rights).

## Complaints

Please contact us first at {{support_email}}. You can also complain to the Information Commissioner's Office: [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/). See [Contact and Complaints](/legal/contact).

## Changes to this notice

Every version of this notice is kept. The version number and effective date are shown at the top of the page.
$body$),

('cookies', 1, 'Cookie Policy', (now() at time zone 'Europe/London')::date, $body$
## Summary

GetSetPaid uses a small number of cookies and browser storage items. Every one of them is strictly necessary to provide the service you asked for, so the law does not require your consent for them and we do not show a cookie banner.

We do not use analytics, advertising, social media or other third-party cookies, tracking pixels or device fingerprinting.

## What we store in your browser

This is the complete list. It is generated from the same list the service itself is checked against.

{{storage_inventory}}

## Your choices

You can delete these items at any time in your browser's settings. Deleting the sign-in cookie signs you out; deleting the others only resets what they remember.

## If this changes

If we ever want to use a cookie or similar technology that is not strictly necessary, such as analytics, we will ask for your consent before setting it and update this policy first.
$body$),

('data-retention', 1, 'Data Retention Policy', (now() at time zone 'Europe/London')::date, $body$
## About this policy

This policy sets out how long GetSetPaid keeps different kinds of data and what happens when that period ends.

**These periods are working defaults.** They are pending review by qualified legal counsel and may change before launch. [Counsel to confirm: each retention period below.]

## Retention periods

- **Financial records** (event budgets and actuals): 7 years.
- **Inactive account data:** 2 years from last use.
- **In-app feedback,** including any screenshot: 2 years from submission.
- **Security audit records:** searchable by our operator for 30 days and kept for up to 1 year in total, then deleted. We do not yet have a separate archive store; for the rest of that year the records stay in our database outside the default view.
- **A suspended or closed workspace:** 60 days from suspension or closure, during which it can be reopened.
- **Documents** follow the record they belong to.

## How deletion works

Most records are soft-deleted first: they disappear from the service but can be restored until the retention period ends. When a period ends, the data is permanently deleted or anonymised.

**Automated deletion is still being built.** Until it runs, some data past these periods may still be stored, although much of it is already hidden from every screen.

## Legal holds

We may keep data for longer where the law requires it, or where it is needed to establish, exercise or defend a legal claim.

## Backups

Our database is backed up by our hosting provider. Backups expire on the provider's schedule; data deleted from the service leaves the backups when they expire. [Counsel to confirm: the backup retention period to state here.]

## Customer records

For records a customer organisation keeps in its own workspace, the organisation decides how long to keep them within these limits.
$body$),

('data-subject-rights', 1, 'Your Data Protection Rights', (now() at time zone 'Europe/London')::date, $body$
## Your rights

Under UK and EU data protection law you can ask us to:

- give you a copy of your personal data (access);
- correct data that is wrong (rectification);
- delete your data (erasure);
- limit how we use it (restriction);
- stop using it for a purpose based on our legitimate interests (objection);
- give you your data in a portable format (portability).

These rights apply to you as an individual even though GetSetPaid is sold to organisations.

## Who to ask: controller or processor

- **Your own account** (your login, profile, workspace memberships, feedback and audit records): GetSetPaid is the controller. Ask us.
- **Records an organisation keeps about you** (for example, you are a contact or an artist in a promoter's workspace): that organisation is the controller and we process the records on its behalf. Ask the organisation. If you contact us instead, we will tell you which organisation to approach and help it respond.

[Counsel to confirm: the controller and processor characterisation above.]

## How to make a request

Email {{support_email}} from the address on your account, saying which right you want to use. A self-service request form is being built.

## Checking it is you

We only act on a request once we are satisfied it comes from the person the data is about. Usually that means the request comes from the email address on the account; if it does not, we will ask you to confirm through the account.

## How long it takes

We aim to respond within 30 days of receiving your request. If a request is complex, we may extend this by up to two further months and will tell you why within the first 30 days.

## If you are not satisfied

You can complain to the Information Commissioner's Office: [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/).
$body$),

('marketing-preferences', 1, 'Marketing and Communications Preferences', (now() at time zone 'Europe/London')::date, $body$
## What we send today

GetSetPaid does not send marketing email or text messages.

The only messages the service sends are ones needed to run it:

- sign-in, sign-up and password emails from our authentication provider;
- a notice to an account holder when password sign-in to their account has been locked after repeated failed attempts;
- operational alerts and feedback receipts to our own support contact.

These are service messages, not marketing, and they cannot be switched off while you have an account.

## If we start sending marketing

We will only send marketing messages to people who have opted in, and we will never make opting in a condition of using the service. Every marketing message will include a one-click way to unsubscribe, and withdrawing consent will be as easy as giving it. We will record when and how consent was given.

This page will be updated, and the preference controls added to your account, before any marketing message is sent.

## Questions

Contact us at {{support_email}}.
$body$),

('subprocessors', 1, 'Subprocessors', (now() at time zone 'Europe/London')::date, $body$
## Who processes data for us

These are the third parties that process personal data on GetSetPaid's behalf. We add a provider here before it receives any personal data.

{{subprocessors}}

## Data processing agreements

A signed data processing agreement with each provider is required before launch. The table shows which are in place today.

## Not subprocessors

No third-party malware-scanning service receives your files today: the production scanning engine has not been chosen yet. When one is, it will be listed here before it receives any file.
$body$),

('terms', 1, 'Terms of Service', (now() at time zone 'Europe/London')::date, $body$
## About these terms

These terms govern use of GetSetPaid, a customer relationship management service for the live events industry. [Counsel to confirm: the contracting entity's legal name and registered address.]

**This is an engineering draft.** The sections marked for counsel are placeholders, not agreed terms.

## Accounts and eligibility

- GetSetPaid is for businesses and people acting for a business. You must be at least 18 and able to agree to these terms for your organisation.
- Keep your sign-in details secure. Owners, admins and finance users must use two-factor authentication.
- You are responsible for the activity of the people you invite to your workspace.

## Plans and payment

- The service is offered on a Free plan and paid Starter and Pro plans, priced per seat in pounds sterling, monthly or annually.
- Paid billing is not yet live. [Counsel to confirm: payment terms, renewal, cancellation and refunds once a payment provider is chosen.]
- If you move to a lower plan, features may become read-only or limited. We will not delete your data because of a downgrade.

## Your data

- You keep ownership of the data you put into your workspace. You give us permission to host and process it to provide the service.
- We process it as your processor under the [Data Processing Addendum](/legal/data-processing-addendum).
- You must have a lawful basis for the personal data you store about other people.

## Acceptable use

You must follow the [Acceptable Use Policy](/legal/acceptable-use) and the [Network Community Guidelines](/legal/community-guidelines).

## The network

Profiles you publish are visible to other organisations on the network, at the visibility level you choose for each field. You are responsible for what you publish.

## Intellectual property

We own the service and its software. You may not copy, modify or reverse engineer it except where the law allows.

## Availability

We aim for 99.9% availability, excluding planned maintenance. [Counsel to confirm: whether this is a target or a commitment, and any service credits.]

## Suspension and closure

- We may suspend a workspace that breaches these terms or is not paid for. A suspended workspace becomes read-only; nothing in it is deleted.
- A suspended or closed workspace is kept for 60 days and can be reopened during that time. See the [Data Retention Policy](/legal/data-retention).

## Warranties and liability

[Counsel to draft: warranty disclaimers and limitation of liability.]

## Governing law

[Counsel to confirm: governing law and jurisdiction.]

## Changes to these terms

Every version of these terms is kept. The version number and effective date are shown at the top of the page.

## Contact

See [Contact and Complaints](/legal/contact).
$body$),

('acceptable-use', 1, 'Acceptable Use Policy', (now() at time zone 'Europe/London')::date, $body$
## About this policy

This policy lists what you must not do with GetSetPaid. It applies to everyone using the service and forms part of the [Terms of Service](/legal/terms).

## You must not

- **Harass or abuse** anyone, including through repeated or unwanted connection requests.
- **Impersonate** another person, business, artist, venue or agency, or publish a network profile for an entity you do not represent.
- **Scrape or bulk-harvest** the network directory or any other part of the service, or use automated means to get around rate limits.
- **Store or publish unlawful content,** including content that infringes someone else's rights or that you have no lawful basis to hold.
- **Upload malicious files,** including malware or files designed to exploit other users' devices.
- **Test the security of the service** without following our [Vulnerability Disclosure Policy](/legal/vulnerability-disclosure).
- **Send spam** or use the service to send unsolicited marketing.
- **Misuse the network,** for example by using connection requests to gather information for purposes unrelated to working together.
- **Access another organisation's data,** or try to, without its permission.
- **Interfere with the service,** including by overloading it.

## What happens if you do

We may remove content, refuse a request, limit your use or suspend your workspace. Suspension makes a workspace read-only and deletes nothing. Where the law requires, we may report unlawful activity to the authorities.

## Reporting misuse

Report misuse to {{support_email}}.
$body$),

('data-processing-addendum', 1, 'Data Processing Addendum', (now() at time zone 'Europe/London')::date, $body$
## About this addendum

This addendum applies when GetSetPaid processes personal data on behalf of a customer organisation, and forms part of the [Terms of Service](/legal/terms). [Counsel to draft: the full contractual wording, including the UK GDPR Article 28 terms.]

## Roles

- **The customer** is the controller of the personal data it stores in its workspace.
- **GetSetPaid** is the processor of that data and processes it only on the customer's documented instructions, which are given by using the service.

## Confidentiality

Everyone at GetSetPaid who can access customer data is bound by confidentiality. Access to a customer's workspace for support happens only after that workspace's owner or admin approves a time-limited request, and is logged.

## Security

We apply the measures described on the [Security and Trust](/legal/security) page.

## Subprocessors

The customer authorises the subprocessors on the [Subprocessors](/legal/subprocessors) page. We will update that page before adding a new one. [Counsel to confirm: the notice period and objection right.]

## Helping with rights requests

We will help the customer respond to requests from people whose data it holds. Requests we receive directly about customer records are passed to the customer. See [Your Data Protection Rights](/legal/data-subject-rights).

## Personal data breaches

We will tell the customer without undue delay after becoming aware of a breach affecting its data, with the information it needs to meet its own obligations.

## Deletion and return

When a workspace is closed, its data is kept for 60 days, during which the workspace can be reopened, and then deleted in line with the [Data Retention Policy](/legal/data-retention). A self-service export is being built.

## International transfers

Customer data is hosted in the UK/EU region. The only subprocessor outside the UK is in the EEA, covered by the UK's adequacy regulations.

## Audits

[Counsel to draft: audit and information rights.]
$body$),

('community-guidelines', 1, 'Network Community Guidelines', (now() at time zone 'Europe/London')::date, $body$
## How the network works

The GetSetPaid network lets promoters, venues, agencies and artists find each other while each organisation's own records stay private.

- **Publishing is opt-in, field by field.** Nothing from your workspace appears on the network unless you publish it, and you choose for each field whether it is visible to the whole network or only to organisations you are connected with.
- **Connecting is mutual.** Connections-only fields become visible only after one organisation sends a connection request and the other accepts it. Accepting a request never shares your notes, finances, documents, events or other private records.
- **There are no public profiles.** Only signed-in users of GetSetPaid can see the network.
- **Ratings are private.** Any rating an organisation gives stays inside that organisation and is never shown on the network.
- **Profiles are not verified.** GetSetPaid does not currently check that a profile belongs to the entity it names, so use your own judgement before relying on one.

## What we expect

- Publish only accurate information about entities you represent.
- Send connection requests for genuine working reasons, and respect a declined request.
- Do not use the network to harvest contact details or for unsolicited marketing.
- Follow the [Acceptable Use Policy](/legal/acceptable-use).

## Reporting and takedown

To report a profile that is inaccurate, impersonates someone or breaks these guidelines, email {{support_email}} with the profile name. There is no in-app report button yet. We may ask the publishing organisation to correct the profile, or suspend the workspace that published it.
$body$),

('ai-use', 1, 'AI Use Policy', (now() at time zone 'Europe/London')::date, $body$
## GetSetPaid does not use AI

The service has no artificial intelligence or machine learning features. We do not use your data, or the data in your workspace, to train or run AI models, and we do not send it to AI providers.

## If this changes

If we introduce an AI feature, we will update this policy before it launches, explaining what the feature does, what data it uses, which providers are involved and what choices you have.
$body$),

('security', 1, 'Security and Trust', (now() at time zone 'Europe/London')::date, $body$
## Our approach

This page describes the security measures GetSetPaid has in place today. It lists only controls that are already built.

## Keeping workspaces separate

- Every request for data is checked in the database itself, using row-level security, against the signed-in user and their workspace memberships. A workspace's records cannot be read by another workspace.
- Network profiles are shown through a separate path that exposes only published fields, and private records are never joined into it.

## Signing in

- Sign in with a password, an emailed link or Google.
- Two-factor authentication is required for owners, admins and finance users, and is checked at every sign-in and again in the database for protected actions.
- Sensitive operator actions require you to confirm your identity again first.
- You are signed out after 30 minutes without activity.
- Repeated failed password attempts lock password sign-in to that account for a period, and the account holder is emailed.

## Limiting abuse

- Searches, network browsing, connection requests and feedback are rate limited.
- Repeated failed sign-ins, rate-limit breaches and blocked uploads raise alerts for our operator.

## Files

- Uploaded files are kept in private storage and are never publicly addressable.
- Files are checked by their contents, not their names, against an allowlist of document and image types. Executables and macro-enabled Office files are refused.
- Downloads are authorised first, logged, and served through links that expire after 60 seconds.
- Every upload passes through a scanning step, and a file it flags is held back and never served.

## Accountability

- Significant actions are recorded in an append-only audit log with the actor, time, action and target.
- Our operator cannot browse customer records. Support access to a workspace requires that workspace's owner or admin to approve a request; access is read-only, lasts at most 60 minutes, and every page viewed is logged.

## Where data lives

Data is hosted in the UK/EU region with our hosting provider, which encrypts stored data and serves all connections over TLS. See [Subprocessors](/legal/subprocessors).

## Incidents

We monitor the alerts above. We will notify the Information Commissioner's Office of a notifiable personal data breach without undue delay and, where feasible, within 72 hours of becoming aware of it, and tell affected customers without undue delay.

## What is not in place yet

- **Malware detection.** The production malware-scanning engine is not connected yet, so the scanning step above does not yet detect real malware.
- **Independent testing.** We have not yet had an independent penetration test. It is planned before launch.
- **A formal incident runbook** and on-call rota are still being written.

## Reporting a vulnerability

See our [Vulnerability Disclosure Policy](/legal/vulnerability-disclosure).
$body$),

('vulnerability-disclosure', 1, 'Vulnerability Disclosure Policy', (now() at time zone 'Europe/London')::date, $body$
## Reporting a vulnerability

If you believe you have found a security vulnerability in GetSetPaid, please tell us at {{support_email}}.

This is our single contact address for support, privacy and security. There is no separate security address or security.txt file yet.

## What to include

- a description of the issue and where it is;
- the steps needed to reproduce it;
- what an attacker could achieve;
- how we can contact you.

## Please

- Test only against your own account and your own workspace.
- Do not access, change or delete data belonging to anyone else. If you reach someone else's data by accident, stop and tell us.
- Do not degrade the service, for example by load testing or denial of service.
- Do not use social engineering, phishing or physical attacks.
- Give us reasonable time to fix the issue before telling anyone else.

## What we will do

- Acknowledge your report and keep you informed as we investigate.
- Fix confirmed issues, prioritising by severity.
- Credit you for the finding if you would like.

[Counsel to confirm: whether, and on what terms, we can commit not to pursue legal action against good-faith research that follows this policy.]

We do not currently run a paid bug bounty.
$body$),

('accessibility', 1, 'Accessibility Statement', (now() at time zone 'Europe/London')::date, $body$
## Our commitment

We want everyone to be able to use GetSetPaid. We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA.

## What we do

- Automated accessibility checks run against the main screens of the service as part of our test suite.
- The service can be used with a keyboard alone, including a skip-to-content link on every page and a keyboard-driven command menu.
- Colours are chosen to meet contrast requirements, and status is never shown by colour alone.

## Known limitations

- The service is designed for desktop and laptop screens first; some screens are harder to use on a small phone.
- We have tested with automated tools and keyboard-only journeys, but not yet with a full range of screen readers or with disabled users.

## Feedback and contact

If you find something you cannot use, tell us at {{support_email}} or through the Feedback button inside the service. Tell us the page and what went wrong.

## How we respond

We will acknowledge your message, tell you whether and when we expect to fix the problem, and help you get what you need in the meantime.

## Enforcement

If you are not happy with our response, you can contact the Equality Advisory and Support Service (EASS).

[Counsel to confirm: the enforcement wording for a business-to-business service.]
$body$),

('contact', 1, 'Contact and Complaints', (now() at time zone 'Europe/London')::date, $body$
## How to reach us

GetSetPaid currently has a single contact address for everything: {{support_email}}

Use it for:

- **support** with the service;
- **privacy** questions and data protection requests;
- **security** reports (please also read our [Vulnerability Disclosure Policy](/legal/vulnerability-disclosure));
- **complaints**.

Signed-in users can also send us feedback through the Feedback button in the service.

[Counsel to confirm: the company's legal name and postal address for correspondence.]

## Complaints

Tell us what happened and what you would like us to do. We will acknowledge your complaint, investigate it and reply with what we found.

## If you are still not satisfied

For a complaint about how we handle personal data, you can contact the Information Commissioner's Office: [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/).

If you are in the European Union, you can also contact the data protection authority where you live.
$body$);

-- Published by transition, exactly as public.publish_legal_document() does it
-- (the guard refuses an INSERT that is not a draft). No published_by: a
-- migration has no user. No counsel review: none has happened.
update public.legal_documents
   set status = 'published',
       published_at = now()
 where version = 1
   and status = 'draft'
   and published_at is null;
