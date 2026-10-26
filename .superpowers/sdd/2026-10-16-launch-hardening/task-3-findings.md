# Task 3 findings: the anon-key RLS audit (`supabase-audit-rls`)

Run 2026-10-23 at branch `launch-hardening`, tip `53a2e5d`, against the LOCAL
stack only (`http://127.0.0.1:54321`), after `npx supabase db reset --local`
from this worktree. Every request carried the **anon key** (`apikey`) and,
where a principal is named, that principal's own GoTrue access token. The
service-role key was never passed to the skill or to any request.

**Result: no bypass reproduced. Zero Critical, zero High. No migration.**
Eight reports came out of the run; each is below with the request that
confirmed or refuted it.

## Set-up

- **Fixtures (as `postgres`, local only):** the founder test logins (tenant A
  `test-promotions`, Pro: owner, manager, finance, read_only; tenant B
  `second-venue`, Starter: owner, manager). Then one row of every tenant-owned
  table in BOTH tenants, each value tagged `SECRET ... <slug>`: company,
  contact, contact_companies, agency, artist, representation, fee history,
  venue, room, event, lineup, financial entry, task/meeting/note (company and
  private) plus their links, document plus link, custom field definition and
  value, a **published** network profile (`headline` network-level; `bio` and
  `contact_email` connections-level) plus its private `network_links` row, a
  feedback row and a DSR. A second tenant-A contact and a pending tenant-A
  invite were added for pass 2, and in pass 4 an accepted B->A connection.
- **Principals:** `anon` (no JWT); `outsider` (signed up, confirmed, no
  workspace); `manager-b` (tenant B, aal1); `owner-b(aal2)` (tenant B, TOTP
  enrolled and verified through GoTrue); positive controls `owner-A(aal2)` and
  `manager-A`.
- **Leak test:** a response is a leak if any byte of it contains tenant A's
  organisation id or slug when read by a tenant-B or tenantless principal.
  Writes were scored by `return=representation` row counts and, for RPCs, by
  an md5 fingerprint of every `public` table taken before and after each call.
- **Volume:** pass 1, 1428 table requests (60 relations from the OpenAPI
  document x 5 principals x select, `or=` filter bypass, every FK embed, and
  insert/update/delete aimed at tenant A) plus 159 empty-argument RPC calls;
  pass 2, 188 typed RPC calls (47 functions x 4 principals, each aimed at
  tenant A's ids) and 17 anon/storage/schema probes; pass 3, 6 RPC positive
  controls; pass 4, 40 targeted writes and connected reads; pass 5, 12 embeds
  off the two definer views.
- **Gitignore:** `.sb-pentest-context.json` and `.sb-pentest-audit.log` were
  already ignored; `.sb-pentest-evidence/` was not, and was added in
  `53a2e5d` before the run.

## Positive controls (the refusals below are not vacuous)

- `owner-A(aal2)` `GET /rest/v1/<table>?select=*` returned tenant A's seeded
  row on every seeded table (contacts 1, notes 2, financial_entries 1,
  network_profiles 1, organisation_memberships 4, ...).
- `owner-A(aal2)` `POST /rest/v1/rpc/has_permission {p_org_id:A,p_permission:"view_crm"}`
  -> `true`; `screen_for_duplicates(A,'contact',<A contact>)` -> 200
  `{"flagged": 2}`; `consume_rate_limit('exports', A)` -> 200 `allowed`.
- The same three calls by `manager-b`: `false`, 403 42501, 403 42501 ("not a
  member of that organisation").
- `storage.objects` held a fixture row `documents/<A>/<doc>`; it answered 404
  `NoSuchKey` to anon, `owner-b(aal2)` **and** `owner-A(aal2)` alike, which
  is the client fence (`documents_deny_client_*`, all RESTRICTIVE) working as
  designed: the app reads files with the server key after authorising.

## What held (no report)

- **anon:** 401 42501 on 59 of 60 relations; the 60th is
  `subscription_plans` (the public price list, `using (true)`, by design).
  `has_function_privilege('anon', ...)` is false for every function in
  `public`; every one of the 53 RPCs answered anon 401 42501 with typed
  arguments (47 in pass 2, the three zero-argument ones in pass 1, and
  `create_organisation`, `record_consent`, `submit_data_subject_request` by
  curl afterwards). The 401 on `legal_documents` is only for `select=*` (R4).
- **Cross-tenant reads:** `outsider` saw 0 rows on every tenant table;
  `manager-b` and `owner-b(aal2)` saw only tenant B's rows on every table,
  with `or=(id.not.is.null,id.is.null)` and with every FK embed. The only
  tenant-A bytes anywhere were R1 (by design).
- **Cross-tenant writes:** insert/update/delete with `organisation_id=eq.<A>`
  on every table: 403 42501 (RLS WITH CHECK or missing grant), 200 with 0
  rows, or 400 (no such column). Targeted writes in pass 4 (organisations,
  profiles, DSRs, feedback, network_profiles, connection requests forged
  FROM A or born `accepted`, export/erasure jobs for A, audit_events, an
  Owner membership in A, a subscription for A, B's own plan to `pro`): all
  refused; `psql` confirmed no `pwn` value and both plans unchanged.
- **Cross-tenant RPCs:** 47 functions aimed at tenant A by `outsider`,
  `manager-b` and `owner-b(aal2)`: every one refused with its own business
  refusal (42501 / 22023), never with an argument error, and the fingerprint
  of every `public` table (bar the meters and `audit_events`) was unchanged
  after every call; 0 audit rows were written into tenant A.
- **Other surfaces:** `Accept-Profile`/`Content-Profile` for `auth`,
  `storage`, `net` -> 406 PGRST106 (only `public`, `graphql_public`
  exposed); `pg_graphql` is not enabled (`/graphql/v1` answers "extension is
  not enabled"); anon `POST /storage/v1/bucket` -> 403 "new row violates
  row-level security policy".

## Findings

Severity rubric (Task 2's): Critical = demonstrated or plausible tenant
breakout / private-network leak / auth bypass / data loss; High = a promised
control missing or bypassable; Medium = defence-in-depth gap on a control
otherwise enforced; Low = hygiene; Info = by design.

| R | Severity | Report | Verdict | The request that decided it |
|---|---|---|---|---|
| R1 | Info | `network_directory` returns tenant A's row to tenant B (leak heuristic matched the slug) | **Refuted (by design).** The row is A's published profile: `id`, `entity_kind`, `display_name`, network-level `headline`; `bio` and `contact_email` (connections-level) are `null`, and no `organisation_id` or `entity_id` column exists on the view. Embeds off the view reach only the caller's own `network_links` (A's row embeds `[]`); `network_profiles`, `organisations`, `companies` embeds are PGRST200. | `GET /rest/v1/network_directory?select=*` as `manager-b` -> 2 rows, A's with `"bio":null,"contact_email":null`; `GET /rest/v1/network_directory?select=id,display_name,network_links(*)` -> A's `"network_links":[]` |
| R2 | Info | `feedback_budget_remaining`, `is_platform_admin`, `my_erasure_blockers` answer 200 to any signed-in caller with no arguments | **Refuted.** Self-scoped: they read only `auth.uid()`'s own state; anon gets 401. | `POST /rest/v1/rpc/is_platform_admin {}` as `outsider` -> `false`; as anon -> 401 42501 |
| R3 | Info | `has_permission`, `data_subject_request_note_counts`, `data_subject_request_recent_notes` answer 200 when given tenant A's ids | **Refuted.** They answer for the caller: `false` / `[]`; the positive control (`owner-A(aal2)`) gets `true`. | `POST /rest/v1/rpc/data_subject_request_note_counts {"p_request_ids":["<A owner's DSR>"]}` as `owner-b(aal2)` -> `[]` |
| R4 | Info | anon holds column SELECT on `legal_documents` | **Refuted (by design: the public legal pages).** The policy `legal_documents_select_current_published` returns exactly the published rows; drafts and the ungranted columns (`status`, `created_by`) are refused. | `GET /rest/v1/legal_documents?select=slug,version,title,published_at,counsel_reviewed_at` as anon -> 15 rows, `psql` published = 15 of 38; `?select=status,created_by` -> 401 42501 |
| R5 | Info | anon holds full table privileges on `storage.objects` and `storage.buckets` (Supabase's platform default) | **Refuted.** Every bucket is private and every client path is fenced by RESTRICTIVE policies with no permissive policy, so no client role reaches a row. | `GET /storage/v1/object/documents/<A>/<doc>` as anon -> 404 NoSuchKey with the object present (`psql`), same for `owner-A(aal2)`; `POST /storage/v1/bucket {"id":"pwn","public":true}` as anon -> 403 RLS |
| R6 | Low | anon holds EXECUTE on `pg_net`'s `net.http_get` / `http_post` / `http_delete` (Supabase's extension default) | **Refuted as a bypass; recorded as a residual.** `net` is not an exposed schema and anon executes no `public` function, so no anon or authenticated request reaches it. It would matter only if `net` were added to `[api] schemas` or a client-callable function ever passed a caller-chosen URL through. Not revoked: the grant is the platform's, and the database-webhook path uses it. | `POST /rest/v1/rpc/http_get {"url":"http://example.invalid"}` with `Content-Profile: net` as anon -> 406 PGRST106 "Invalid schema: net" |
| R7 | Low | A connection-request row shows each side the other organisation's `organisation_id` and the responding user's id (`responded_by`) | **Refuted as a leak (by design, Q83: the bi-tenant request table, both org ids visible to both parties).** Identifiers only: no RLS path or RPC accepts them from a non-member (pass 2), and the user id resolves to nothing. | `GET /rest/v1/network_directory?select=id,network_connection_requests!to_network_profile_id(*)` as `manager-b` -> B's own accepted request with `to_organisation_id` = A and `responded_by` = A's owner; `GET /rest/v1/profiles?id=eq.<A owner>` -> `[]` |
| R8 | Info | `PATCH organisation_subscriptions` answers 200 for tenant B's Owner (a self-upgrade attempt) | **Refuted.** 200 with 0 rows (the RLS USING excludes it), and `psql` shows B still `starter`. | `PATCH /rest/v1/organisation_subscriptions?organisation_id=eq.<B> {"plan_id":"pro"}` with `Prefer: return=representation` as `owner-b(aal2)` -> `[]` |

No row reproduced, so none takes a psql assertion, an HTTP check or a
migration. The anon census that would catch a regression already exists:
`tests/integration/security/phase7-permission-matrix.test.ts` counts `anon`
in both its relation and function censuses, and `schema_invariants.sql` D6
asserts anon holds nothing on a tenant table.

## Not covered

- Realtime: no table is in the `supabase_realtime` publication
  (`pg_publication_tables` is empty), so `postgres_changes` has nothing to
  stream; broadcast/presence channels were not probed.
- The read-meter residual (a direct PostgREST GET is unmetered, Q107) is
  known and unchanged; this run did not measure it.
- Only the founder roles listed above. The per-role matrix (Booker, Venue
  Manager, Marketing, Standard User, Read Only record scope) is the
  permission matrix's job, not this run's.
