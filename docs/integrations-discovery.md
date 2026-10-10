# Integrations discovery: the first post-launch connector

Research only. No code, no schema, no live provider. This feeds Phase 9's
`private.integration_providers()` (every row `live = false`) and DECISIONS-QUEUE
Q232.

**Method.** Every fact below carries its source URL and "checked 2026-10-09".
Where a vendor publishes nothing, the text says "not published" and stops. I
did not infer. Where I could only reach a third-party summary, it is labelled
as such and is not a basis for a decision. This is not legal advice; transfer
bases are for counsel (`CLAUDE.md` § Legal and regulatory compliance).

**What each integration is for** (PRD § 13): Gmail / Microsoft 365 mail
(OAuth, scoped permissions, token encryption, sync status); Google / Microsoft
calendar (create, read, update events with explicit consent and conflict
handling); Skiddle / Fatsoma (only where documented APIs and licensing permit;
import ticket URLs initially); Xero / QuickBooks (scoped OAuth, financial
reconciliation model).

---

## 1. Gmail

**Documented public API.** Yes. Gmail API scope reference:
https://developers.google.com/workspace/gmail/api/auth/scopes (checked 2026-10-09).

**Auth model and narrowest scopes.** OAuth 2.0 (Google identity platform).
Per the scope page (checked 2026-10-09):
- `gmail.metadata` (headers and labels, no body) is the narrowest general read
  scope. It is classed **restricted**.
- `gmail.readonly` is restricted. `gmail.compose` (drafts and send) is
  restricted. `gmail.send` (send only) is **sensitive**, not restricted.
- The non-sensitive add-on scopes (`gmail.addons.current.*`) work only while a
  Gmail add-on is running, so they do not fit a background sync.
- So any mail *sync* the PRD describes needs a restricted scope. A
  send-only connector could use the sensitive `gmail.send`.

**Partner or licensing gates.** Restricted scopes require a security
assessment by a Google-empanelled assessor for apps that store or transmit
restricted data on servers, repeated at least every 12 months after the Letter
of Assessment date, and verification "can potentially take several weeks".
Google's page states no fee
(https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification,
checked 2026-10-09). Cost of the assessment: not published on that page.

**Data residency / transfer basis.** Google's Cloud Data Processing Addendum
incorporates the UK Addendum to the EU SCCs for UK GDPR transfers (per Google's
cloud blog and help page, reached through search summaries, not the CDPA text
itself: https://cloud.google.com/blog/products/identity-security/evolving-google-clouds-data-processing-commitments
and https://support.google.com/cloud/answer/6329727, checked 2026-10-09).
Where Gmail API data is processed for a third-party app: not published on a
page I could reach. A customer-admin "data regions" setting exists for some
Workspace editions (https://knowledge.workspace.google.com/admin/compliance/data-covered-by-data-regions,
checked 2026-10-09), but that is the customer's tenancy, not our server.
Whether Google also offers the standalone IDTA: not found.

**Sub-processor row.** Yes. Mail bodies and headers are third-party personal
data of people who never signed up to GetSetPaid. A "Google LLC" row would be
needed in the same change that first sends data, with a signed DPA (the
register's rule, `docs/sub-processors.md`). Note the direction: for a read
connector the data flows *from* Google *to* us (Supabase), so the new
processor relationship is mainly that we hold Google-origin data and must meet
Google's API data policy; whether Google is a sub-processor of ours for an
inbound-only read is a question for counsel. Flagged, not decided.

## 2. Google Calendar

**Documented public API.** Yes. Scope and auth page:
https://developers.google.com/workspace/calendar/api/auth (checked 2026-10-09).

**Auth model and narrowest scopes.** OAuth 2.0. The scope list includes
`calendar.events.owned` (create, change, delete events on calendars the user
owns), `calendar.events.owned.readonly`, and `calendar.app.created` (only
secondary calendars the app itself creates, the narrowest of all)
(same page, checked 2026-10-09). For the PRD's "create/read/update events",
`calendar.app.created` is the narrowest write, `calendar.events.owned` the
narrowest that touches the user's own existing calendar.

**Partner or licensing gates.** Google says a public app using scopes that
permit access to certain user data "must complete a verification process"
(same page). The pages I could read do **not** label each Calendar scope as
sensitive or restricted, so whether Calendar scopes need the CASA security
assessment: not confirmed. The restricted-scope page above ties the assessment
to *restricted* scopes; the Gmail list is the only one I could confirm
carries that label. To be checked in the Cloud Console consent-screen scope
picker before committing.

**Data residency / transfer basis.** Same as Gmail (Google CDPA with the UK
Addendum to the SCCs; sources in § 1).

**Sub-processor row.** Yes, same Google row as § 1 (one row covers both).
Calendar data carries attendee names and emails, so it is third-party
personal data too.

## 3. Microsoft 365 mail and calendar (Microsoft Graph)

**Documented public API.** Yes. Permissions reference:
https://learn.microsoft.com/en-us/graph/permissions-reference (checked 2026-10-09).

**Auth model and narrowest scopes.** OAuth 2.0 on the Microsoft identity
platform. Delegated `Calendars.Read`, `Calendars.ReadWrite` and
`Calendars.ReadWrite.Shared` are listed with admin consent **not** required;
`Calendars.ReadBasic` also exists (same page, checked 2026-10-09). For mail,
`Mail.ReadBasic` (no body, preview or attachments) is the narrow read, and
`Mail.Send` is separate (https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac,
which lists the application-permission equivalents, checked 2026-10-09). On the
permissions-reference page, read in a later chunk, the delegated
`AdminConsentRequired` value is "No" for `Mail.Read`, `Mail.ReadBasic`,
`Mail.ReadWrite` and `Mail.Send` (https://learn.microsoft.com/en-us/graph/permissions-reference,
checked 2026-10-10, via a page-reading tool's quotation of the table, not a
visual read). That is the default only: a search summary of a Microsoft Q&A
thread quoting Message Center notice MC1163922 says Microsoft-managed consent
policy may require admin approval for third-party apps reading Exchange content,
possibly including `Mail.ReadBasic`; Microsoft had not published a definitive
list there (checked 2026-10-10, third-party/community, unconfirmed). A tenant's
own consent settings can also force admin approval.
For a customer that wants to restrict an app to named mailboxes, Exchange
Online "RBAC for Applications" scopes Graph application permissions per
mailbox (same Exchange page).

**Partner or licensing gates.** Publisher verification (a verified Microsoft
Cloud Partner Program account tied to the app registration) is aimed at
multitenant apps; per a search summary of Microsoft's docs, newly registered
unverified multitenant apps cannot get end-user consent when risk-based
step-up consent is on, and verification has no cost
(https://learn.microsoft.com/en-ca/entra/identity-platform/publisher-verification-overview,
checked 2026-10-09; the "no cost" and consent details came via a third-party
summary and need confirming on Microsoft's page). No equivalent of Google's
annual third-party security assessment was found in what I read: not
published on pages reached, which is not the same as not existing.

**Data residency / transfer basis.** Microsoft's EU Data Boundary commits to
store and process Customer Data in EU/EFTA datacentres for in-scope services
including Microsoft 365; the page's country list is EU and EFTA states and
does not name the UK (https://learn.microsoft.com/en-us/privacy/eudb/eu-data-boundary-learn,
checked 2026-10-09). It says the commitment has limited exceptions and is still
being extended. Which UK-GDPR transfer mechanism Microsoft's DPA uses: not
read; for counsel.

**Sub-processor row.** Yes: a Microsoft row (same reasoning as § 1).

## 4. Skiddle

**Documented public API.** Yes, in beta: https://www.skiddle.com/api/
(checked 2026-10-09). Free key by application; event search and event detail
over HTTPS (query-string `api_key`); listings only (public event data).

**Auth model and narrowest scopes.** API key. No OAuth and no scopes. The
use case (import ticket URLs / event listings) is read-only public data,
which is all the API appears to expose.

**Partner or licensing gates.** The page states: "The API is for
non-commercial use only." Commercial use needs prior written approval by
emailing dev@skiddle.com. GetSetPaid is a paid SaaS, so commercial approval is
required before any production use. The page says Skiddle may rate-limit or
block excessive use and that the API is "still in Beta" (same URL, checked
2026-10-09).

**Data residency / transfer basis.** Not published on the API page; it links
to a privacy policy I did not read. Event listings are not our users'
personal data, so the transfer question is small, but not confirmed.

**Sub-processor row.** Probably no. We would only fetch public event
listings, sending Skiddle an API key and search terms, not personal data.
That is a judgement for counsel, not something Skiddle states.

## 5. Fatsoma

**Documented public API.** Not published. The Fatsoma homepage footer lists
customer, organiser (dashboard, help) and company links with no API,
developer, integrations or partners page
(https://www.fatsoma.com, checked 2026-10-09). The terms page does not mention
an API or third-party developer access
(https://www.fatsoma.com/policies, checked 2026-10-09). A web search for
Fatsoma developer documentation returned nothing relevant (checked
2026-10-09). I make no claim that no private partner API exists.

**Auth model and narrowest scopes.** Not published.

**Partner or licensing gates.** Not published. The only route is to ask
Fatsoma.

**Data residency / transfer basis.** Not published for an API. The terms say
a Data Processor "will not transfer the Personal Data outside of the UK or
European Economic Area" absent stated conditions (clause 11.7.8,
https://www.fatsoma.com/policies, checked 2026-10-09); that is a term about
processors, not a statement of where Fatsoma stores data.

**Sub-processor row.** Not determinable without an API to evaluate.

## 6. Xero

**Documented public API.** Yes: https://developer.xero.com/ (pricing page
reached: https://developer.xero.com/pricing, checked 2026-10-09).

**Auth model and narrowest scopes.** OAuth 2.0 with granular scopes. The
scopes page returned only its title to my fetch on 2026-10-09 and again on
2026-10-10 (https://developer.xero.com/documentation/guides/oauth2/scopes/), and
Xero's developer blog post on the change
(https://devblog.xero.com/upcoming-changes-to-xero-accounting-api-scopes-705c5a9621a0)
returned HTTP 403 (2026-10-10). So the following comes from Apideck's write-up
(https://www.apideck.com/blog/xero-scopes, third-party, checked 2026-10-10) and
is unconfirmed against Xero: apps created on or after 2 March 2026 have no
access to the broad `accounting.transactions` scope and must use granular
scopes, each with a `.read` variant: `accounting.invoices.read` for invoices,
`accounting.banktransactions.read` for bank transactions. Contacts stay on
`accounting.contacts` with no `.read` variant listed. Older apps have until
about September 2027 to migrate. Per the same source, the journals endpoint is
gated behind the Advanced tier plus a security assessment and Xero approval.
Confirm all of it on Xero's scopes page before relying on it.

**Partner or licensing gates.** Since 2 March 2026 Xero prices API use by
tier (third-party summaries, including
https://developers.apideck.com/apis/accounting/xero/overview, checked
2026-10-09). Xero's own pricing page lists: Starter, max 5 connections, no
charge; Core, 50 connections, $35 AUD per month; Plus, 1000, $245 AUD; Advanced,
10,000, $1445 AUD; Enterprise, no limit, price on application. Paid tiers
require a payment method. It lists App Certification and an initial and annual
Security Assessment as prerequisites, but the flattened table does not show
which tiers need which (https://developer.xero.com/pricing, checked
2026-10-09). The connection cap for an uncertified app: sources conflict
(25 and 5 appear in third-party summaries; the Xero page says nothing).
Do not plan around either figure until confirmed with Xero.

**Data residency / transfer basis.** Xero's UK privacy notice says its
headquarters are in New Zealand and Xero (UK) Limited is its EU
representative (https://www.xero.com/uk/legal/privacy/, checked 2026-10-09).
Where API data is hosted and which UK transfer mechanism applies: not found in
what I could read.

**Sub-processor row.** Yes if we pull invoices or contacts (customer names
and bank detail on invoices are personal data). A Xero row, DPA first.

## 7. QuickBooks (Intuit)

**Documented public API.** Yes: Intuit's developer scopes page exists at
https://developer.intuit.com/app/developer/qbo/docs/learn/scopes but renders
without content to my fetch (retried 2026-10-10: page title only), so I relied
on search summaries (checked 2026-10-09 and 2026-10-10).

**Auth model and narrowest scopes.** OAuth 2.0. The accounting scope is
`com.intuit.quickbooks.accounting`; there is a separate
`com.intuit.quickbooks.payment` scope. Changing scopes forces
re-authorisation (third-party summaries, e.g.
https://developers.apideck.com/connectors/quickbooks/docs/application_owner+oauth_credentials,
checked 2026-10-09). A finer-grained scope than the single accounting scope:
not found. A search summary of an Intuit developer-support answer
(https://help.developer.intuit.com/s/question/0D5TR00001FvXDB0A3/how-can-i-give-an-api-read-access-only,
checked 2026-10-10, community, unconfirmed against Intuit's docs) says the
accounting scope has no read-only variant; the suggested workaround is GET-only
code or a view-only QuickBooks user role, neither enforced by the scope. Other
scopes for specific features (e.g. `sales.sales-order.read`) are mentioned by
community posts as limited to higher developer tiers (same caveat).

**Partner or licensing gates.** Production keys require completing an app
assessment questionnaire; apps on the app store and apps with over 500
connections get an annual review (same summary, third-party; confirm on
Intuit's own page).

**Data residency / transfer basis.** Intuit's UK data processor terms restrict
transfers outside the EEA and list examples of safeguards, naming EU SCCs and a
now-invalid Privacy Shield; they do not name the IDTA or UK Addendum
(https://www.intuit.com/legal/terms/en-gb/quickbooks/payroll-data-processing/,
checked 2026-10-09, via search summary). That document covers payroll data
processing, not the API. Current API data location: not published on pages
reached.

**Sub-processor row.** Yes if invoice data is pulled; an Intuit row, DPA first.

---

## Comparison

| Candidate | Public API | Auth | Hardest gate | Third-party personal data | New sub-processor row |
|---|---|---|---|---|---|
| Google Calendar | Yes | OAuth, event-level scopes | Verification; assessment need unconfirmed for Calendar scopes | Attendees | Yes (Google) |
| Microsoft Graph calendar and mail | Yes | OAuth, admin consent not required for Calendars.* delegated | Publisher verification (MPN account) | Attendees, mail parties | Yes (Microsoft) |
| Gmail | Yes | OAuth | Restricted scope plus annual third-party security assessment | Mail bodies and headers | Yes (Google) |
| Xero | Yes | OAuth | Tiered API pricing, certification and security assessment | Invoice contacts | Yes |
| QuickBooks | Yes | OAuth | Production assessment questionnaire | Invoice contacts | Yes |
| Skiddle | Yes (beta) | API key | Non-commercial only without written approval | None expected | Probably not |
| Fatsoma | Not published | Not published | Unknown | Unknown | Unknown |

## Ranked recommendation

1. **Google Calendar** (first connector).
2. Microsoft Graph calendar.
3. Skiddle ticket-URL import, once commercial approval is in writing.
4. Xero.
5. QuickBooks.
6. Gmail, then Microsoft mail.
7. Fatsoma, blocked until Fatsoma says whether an API exists.

**Reasoning.** Calendar is the smallest honest step on the PRD's own list: it
asks only for explicit consent and conflict handling, it needs event-level
scopes (`calendar.events.owned`, or `calendar.app.created` if we write only to
a calendar we create), and it never reads mail bodies, so it avoids the one
gate that is certain and heavy, Google's restricted-scope annual security
assessment that mail sync triggers. It also fits the product's core workflow
(holds and shows on a date) better than accounting does. Google first rather
than Microsoft is a close call, not a finding: the only gate I could confirm
for Google is on the Gmail (mail) scopes, which Calendar does not need, and I
did not confirm how Google labels the Calendar scopes; Microsoft's calendar
scopes need no admin consent by default (subject to the unconfirmed tenant
consent-policy caveat in § 3) and I found no assessment, though that is not
proof none exists. Neither source shows one is easier. Google is ranked
first as a judgement call, not on a documented difference, and the founder
chose it (Q232). Two uncertainties could reorder this and
both are cheap to settle before building: whether Calendar scopes trigger the
Google assessment, and what the audience actually uses (ask the first ten
customers which calendar they live in). Xero is held back by tiered API fees
and certification; Skiddle by its non-commercial clause; Fatsoma because no
public API or developer docs were found (a private partner API is not
excluded).

## Founder pre-work list

None of this needs code, and Q232 is answered: Google Calendar first.

1. Ask ten prospective customers which calendar and mail they use (Google vs
   Microsoft); that decides rank 1 versus 2 more than any doc.
2. Create a Google Cloud project and OAuth consent screen under a company
   Google account (not personal). Add the Calendar scopes in the scope picker
   and read the label Google shows (sensitive or restricted). That settles the
   open assessment question.
3. Register the Microsoft Entra multitenant app and start Microsoft Cloud
   Partner Program verification (publisher verification takes calendar time;
   needs a verified domain).
4. Sign the Google Cloud Data Processing Addendum (and Microsoft's DPA if
   Microsoft goes next); ask each vendor in writing for its UK-GDPR transfer
   mechanism. Add the vendor row to `docs/sub-processors.md` and
   `lib/legal/sub-processors.ts` in the same change as the first live call.
5. Email dev@skiddle.com for written commercial-use approval; email Fatsoma
   asking whether a partner API exists. Both emails can go today.
6. Ask Xero and Intuit for their current UK data location, transfer mechanism
   and, for Xero, the uncertified-app connection cap. Park until the calendar
   connector ships.
7. Counsel: DPIA addendum for third-party attendee data, and whether an
   inbound-only read makes the provider a sub-processor of ours.
