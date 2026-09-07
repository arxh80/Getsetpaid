// Fixtures for the Playwright suite: two organisations, five signed-in roles,
// and a tenant boundary between them.
//
// ===========================================================================
// WHY THIS BUILDS ITS OWN WORLD RATHER THAN READING THE psql SUITE'S
// ===========================================================================
// `supabase/tests/run-rls-tests.sh` leaves a rich fixture behind, and it is
// tempting to point a browser at it. Two reasons not to:
//
//   1. It refuses to run against a dirty database, so "run the psql suite
//      first" means "reset the database first", which means this suite could
//      never run beside a dev session someone is using.
//   2. Its fixtures are shaped for assertions, not for a walk -- contacts
//      named "Deleted Contact" that are not deleted, and merge rows in two
//      different shapes. THE SECOND HALF OF THAT SENTENCE USED TO READ "ten
//      merges written by hand rather than through `merge_records()`", and
//      Phase 3 Task 1 made it half false: § Z of `rls_phase2_crm.sql` now
//      plants five dedicated pairs and merges them through `merge_records()`
//      for real, so the suite holds hand-written rows (no `<side>.before`
//      snapshot) AND real ones (with it) side by side, on purpose. The
//      hand-written ones were left alone because ~680 assertions are built on
//      them. A golden-path test that depends on any of it is a test that
//      depends on another suite's incidental choices, which is still the
//      point.
//
// So this creates a disposable world with a unique slug per run and deletes it
// afterwards, and it can run against a database anybody is already using.
//
// ===========================================================================
// WHY MEMBERSHIPS ARE NOT WRITTEN THROUGH THE CLIENT PATH
// ===========================================================================
// The obvious path is the real one: `create_organisation()` as the owner, then
// invites, then `accept_invite()`. `tests/integration/rls/support/fixtures.ts`
// does exactly that and it is the right shape THERE, because that suite is
// about the client path.
//
// It cannot be the shape here. `create_organisation()` makes the caller an
// OWNER, MFA is required for owners (`CLAUDE.md` § Session security) and
// enforced in the database, so inviting anybody needs a TOTP enrolment and a
// challenge before the first fixture row exists. That is a lot of machinery in
// front of a test whose subject is a contacts page.
//
// ===========================================================================
// AND WHY SETUP IS `pg`, NOT THE SERVICE-ROLE KEY OVER PostgREST
// ===========================================================================
// The first draft of this file inserted through `/rest/v1/organisations` with
// the service-role key, on the usual assumption that service-role bypasses
// everything. It does not, here, and finding that out was worth the round trip:
//
//   insert organisations failed (403): {"code":"42501",
//     "message":"permission denied for table organisations",
//     "hint":"GRANT INSERT ON public.organisations TO service_role;"}
//
// The default-privileges baseline (`20260827232507`, asserted as invariant D7)
// revoked the stock grants, and `service_role` was never granted back on the
// tenant tables. RLS bypass is irrelevant when the GRANT is missing -- they are
// independent controls (SECURITY.md § 2), which is exactly what invariant D5
// says. So setup connects to Postgres directly as `postgres`, the same way
// `tests/integration/rls/support/fixtures.ts` does for the things no client
// role can perform.
//
// Everything the tests ASSERT on still goes through a real browser, a real
// password sign-in and a real anon-key session, which is where the policies
// actually apply.
//
// LOCAL ONLY. `localStack()` refuses anything that is not loopback.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface LocalStack {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
}

let cachedStack: LocalStack | undefined;

/**
 * Read the local stack's URL and keys from the Supabase CLI at run time.
 *
 * Duplicated from `tests/integration/rls/support/env.ts` rather than imported:
 * that module lives under a `@/` path alias resolved by vitest's config, and
 * Playwright loads its files with its own transform. Copying twelve lines is
 * cheaper than making two runners agree about module resolution, and the
 * loopback refusal below -- the part that matters -- is copied with it.
 */
export function localStack(): LocalStack {
  if (cachedStack) return cachedStack;
  let raw: string;
  try {
    raw = execSync("npx --yes supabase status -o json", { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      "Could not run `supabase status -o json`. Start the local stack " +
        `(\`npx supabase start\`) before running the e2e suite.\n${String(err)}`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, string>;
  const apiUrl = parsed.API_URL;
  const anonKey = parsed.ANON_KEY;
  const serviceRoleKey = parsed.SERVICE_ROLE_KEY;
  const dbUrl = parsed.DB_URL;
  if (!apiUrl || !anonKey || !serviceRoleKey || !dbUrl) {
    throw new Error("`supabase status -o json` returned no API_URL/keys/DB_URL.");
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error(
      `Refusing to run: API_URL "${apiUrl}" is not a local stack. This suite ` +
        "creates and deletes real auth users and must never touch a hosted project.",
    );
  }
  if (!/^postgres(?:ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):/.test(dbUrl)) {
    throw new Error("Refusing to run: DB_URL is not a local Postgres instance.");
  }
  cachedStack = { apiUrl, anonKey, serviceRoleKey, dbUrl };
  return cachedStack;
}

export const PASSWORD = "Test-Passw0rd!-e2e";

/**
 * The names the Task 7 assertions look for, in one place.
 *
 * WRITTEN AS CONSTANTS BECAUSE THEY ARE ASSERTED AS ABSENCES. A
 * `not.toContainText("Manger Night")` typo passes forever and silently, and an
 * absence assertion is exactly the kind that cannot fail loudly on its own --
 * the same reason `expectRefused` asserts a STATUS as well as words.
 */
export const EVENT_NAMES = {
  managerOwned: "Manager Night A",
  standardOwned: "Standard Night A",
  otherTenant: "Other Tenant Secret Event",
  // FIX ROUND 1 (I-1). A FUTURE event that is SOFT-DELETED. It exists for one
  // assertion -- that the workspace home's upcoming block does not show it --
  // and that assertion exists because `loadUpcomingEvents` writes
  // `deleted_at is null` BY HAND (nothing else writes it for that query) and
  // the Task 7 mutation table recorded, correctly, that deleting the clause
  // turned nothing red. It is on the first screen a user sees.
  softDeleted: "Deleted Night A",
  // TASK 8. A PAST event with a `ticket_link` the RENDERER refuses. See the
  // fixture insert for why the value is what it is, and why the obvious value
  // -- `javascript:` -- cannot be planted at all on this table.
  hostileTicket: "Hostile Ticket Night",
} as const;

export const VENUE_NAME = "E2E Warehouse";
/** A SECOND live venue, so "change the venue" is a step the golden path can
 *  actually take. Owned by the MANAGER, where VENUE_NAME is owned by the
 *  standard user -- so the picker on the manager's form is proven to offer
 *  both a record they own and one they only have full-scope access to. */
export const ALT_VENUE_NAME = "E2E Basement";
export const ROOM_NAME = "E2E Main Room";
export const ARTIST_NAME = "E2E Headliner";
/** An artist in the OTHER tenant, on the other tenant's event's bill. */
export const OTHER_ARTIST_NAME = "Other Tenant Headliner";

// ===========================================================================
// PHASE 4 TASK 8: THE OPERATIONS FIXTURE VOCABULARY
// ===========================================================================
// WRITTEN AS CONSTANTS FOR THE SAME REASON `EVENT_NAMES` IS: the tenant-breakout
// and note-visibility assertions are ABSENCES (`not.toContainText(...)`), and a
// typo'd literal in an absence assertion passes forever and silently. The two
// cross-tenant strings in particular are what the operations breakout run proves
// never leak from a browser holding another tenant's session.
export const NOTE_BODIES = {
  /** Authored by the manager, visibility `private`: reaches only its author. */
  managerPrivate: "Manager Private Note — only its author may read this",
  /** Visibility `company`: reaches every viewer in the workspace. */
  company: "Company Note — the whole workspace reads this",
  /** A `private` note in the OTHER tenant. Must appear on no surface here. */
  otherTenant: "Other Tenant Secret Note",
} as const;

export const DOCUMENT_NAMES = {
  /** A `clean` document linked to the manager-owned contact. */
  clean: "Clean Rider.pdf",
  /** A `quarantined` document — no download link, download route 409s. */
  quarantined: "Quarantined Upload.txt",
  /** A `clean` document in the OTHER tenant, linked to its event. */
  otherTenant: "Other Tenant Secret Contract",
} as const;

/**
 * A `ticket_link` that PASSES the column CHECK and that `safeHref()` REFUSES.
 *
 * ===========================================================================
 * WHY NOT `javascript:`, WHICH IS WHAT THE TASK 8 BRIEF ASKED FOR
 * ===========================================================================
 * Because it cannot be stored. `events_ticket_link_is_http`
 * (20260901000000) is `check (ticket_link is null or ticket_link ~* '^https?://')`,
 * it is a validated CHECK rather than `NOT VALID`, and a CHECK binds EVERY
 * writer -- `postgres` included, which is the connection this file uses. There
 * is no `javascript:` row to plant, in this suite or in the product.
 *
 * That is a finding rather than a convenience. The constraint's own comment
 * (20260901000000) calls itself "DEFENCE IN DEPTH, NOT THE CONTROL"; the phrase
 * "a row written before it, by an import, or by a direct PostgREST PATCH is
 * still possible" is the DETAIL PAGE's comment
 * (app/(app)/[orgSlug]/events/[eventId]/page.tsx), not the constraint's.
 * On `public.events` none of those three is possible today -- the table was
 * created WITH the constraint, so there are no older rows, and PostgREST goes
 * through the same CHECK. The sentence describes the shape of the risk
 * correctly and overstates the exposure on this column.
 *
 * ===========================================================================
 * SO WHAT IS ACTUALLY MEASURED HERE
 * ===========================================================================
 * The property that matters is unchanged and is still `safeHref()`'s: the page
 * renders the PARSER's answer or nothing, never the raw column. This value is
 * the smallest thing that separates the two -- `^https?://` matches it, so the
 * CHECK admits it, and `new URL()` throws on the space inside the host, so
 * `safeHref()` returns null and the detail page must render it as inert text.
 * A page that wrote `href={event.ticketLink}` would ship a broken anchor here
 * and a live `javascript:` one the day the CHECK is relaxed or the column is
 * copied to a table without it.
 */
export const HOSTILE_TICKET_LINK = "https://exa mple.com/tickets";

/** Roles this suite signs in as. */
export type E2eRole = "manager" | "standard_user" | "read_only";

export interface E2eUser {
  id: string;
  email: string;
}

export interface E2eWorld {
  /** Slug of the workspace the golden path is walked in. */
  orgSlug: string;
  orgId: string;
  /** A SECOND tenant, for the breakout run. Nobody in `users` belongs to it. */
  otherOrgSlug: string;
  otherOrgId: string;
  /** A contact in the OTHER tenant. Its id is a valid uuid that must 404. */
  otherOrgContactId: string;
  /** A contact in THIS tenant owned by the manager, which the standard user
   *  must not be able to open -- record scope, not tenant scope. */
  managerOwnedContactId: string;
  /** A contact carrying values that a `javascript:`-rejecting form would never
   *  have accepted, planted directly so the RENDER path is what is measured. */
  hostileContactId: string;

  // =========================================================================
  // PHASE 3 TASK 7: THE CROSS-ENTITY EVENT SURFACES
  // =========================================================================
  // A venue with two events at it -- one owned by the manager, one by the
  // standard user -- and an artist on the bill of the manager's. That shape is
  // the minimum that can tell the three failures apart on the new surfaces:
  //
  //   tenant boundary   the other tenant's event must 404 from BOTH slugs
  //   record scope      the standard user's venue page must show THEIR event
  //                     and not the manager's, inside one tenant
  //   non-vacuity       the manager's page must show BOTH, or "it shows
  //                     nothing" would satisfy every assertion above
  //
  // Both events are in the FUTURE, so they are also what the workspace home's
  // upcoming block reads.
  /** A venue in THIS tenant. Its detail page carries the "Events here" list. */
  venueId: string;
  /** A ROOM at that venue. Task 8: the event form's room `<select>` is an
   *  `<optgroup>` over every live room in the workspace (there is no cascade
   *  without JavaScript -- components/crm/event-form.tsx says why), so a
   *  workspace with no rooms renders that control with one option and the
   *  golden path cannot tell "the group is empty" from "the group is gone". */
  venueRoomId: string;
  /** A SECOND live venue in this tenant, owned by the manager. The golden
   *  path's "change the venue" step needs somewhere to change it TO. */
  altVenueId: string;
  /** An event at that venue, owned by the manager. */
  managerOwnedEventId: string;
  /** An event at that venue, owned by the standard user. */
  standardOwnedEventId: string;
  /** An artist in this tenant, on the manager-owned event's lineup. */
  artistId: string;
  /** A FUTURE event in this tenant that is soft-deleted. It must appear on no
   *  surface at all -- the workspace home's upcoming block least of all. */
  softDeletedEventId: string;
  /** A PAST event carrying `HOSTILE_TICKET_LINK`. In the past deliberately, so
   *  it is outside the workspace home's upcoming block and cannot perturb the
   *  five rows that block's assertions count on. */
  hostileEventId: string;
  /** An event in the OTHER tenant. Its id is a valid uuid that must 404. */
  otherOrgEventId: string;
  /** An artist in the OTHER tenant, on that tenant's event's bill. Task 8: the
   *  other tenant's event now has a LINEUP, so "this tenant's event pages show
   *  no other tenant's rows" is a claim about `event_lineup` as well as about
   *  `events` -- `event_lineup_select_via_event` is a separate policy from
   *  `events_select_view_crm` and nothing before this could tell them apart
   *  from a browser. */
  otherOrgArtistId: string;

  // =========================================================================
  // PHASE 4 TASK 8: THE OPERATIONS ROWS
  // =========================================================================
  /** A task in THIS tenant, owned by the manager, LINKED to the manager's
   *  event (`task_links`, entity_type `event`). The operations golden path
   *  completes it and reads `task_completed` on the event's timeline. */
  taskId: string;
  /** A meeting in THIS tenant, owned by the manager. */
  meetingId: string;
  /** A `private` note in THIS tenant, authored by the manager. Reaches only
   *  the manager: the standard user must not see it. */
  privateNoteId: string;
  /** A `company` note in THIS tenant. Reaches every viewer in the workspace. */
  companyNoteId: string;
  /** A `clean` document in THIS tenant, linked to the manager-owned contact
   *  (`document_links`, entity_type `contact`). */
  cleanDocumentId: string;
  /** A `quarantined` document in THIS tenant. Its own fixture row — no test
   *  reuses it, so the quarantine assertions carry no ordering dependency. */
  quarantinedDocumentId: string;
  /** A task in the OTHER tenant. A valid uuid that must 404 from this session. */
  otherOrgTaskId: string;
  /** A `private` note in the OTHER tenant (`Other Tenant Secret Note`). */
  otherOrgNoteId: string;
  /** A `clean` document in the OTHER tenant (`Other Tenant Secret Contract`),
   *  linked to that tenant's event. A valid uuid that must 404 here, and whose
   *  filename must never appear on this tenant's document list. */
  otherOrgDocumentId: string;

  users: Record<E2eRole, E2eUser>;
  /** The OTHER tenant's owner. Nothing signs in as them; they exist so the
   *  second organisation has a member, which is what makes its rows real
   *  rather than orphaned.
   *
   *  RETURNED, AS OF TASK 8, AND THAT IS THE WHOLE OF THE DEFERRED MINOR.
   *  `tearDownWorld` used to find this user by LISTING UP TO 1000 AUTH USERS
   *  and matching an email it re-derived from the slug. Two things were wrong
   *  with it and only one is tidiness: the id was already in hand at creation
   *  time, and on a stack with more than 1000 users the page would not contain
   *  them and the teardown would silently leak a user every run. */
  otherOwner: E2eUser;
}

async function api(
  path: string,
  init: RequestInit & { key: string },
): Promise<Response> {
  const { apiUrl } = localStack();
  const { key, headers, ...rest } = init;
  return fetch(`${apiUrl}${path}`, {
    ...rest,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(headers as Record<string, string> | undefined),
    },
  });
}

async function createUser(email: string): Promise<E2eUser> {
  const { serviceRoleKey } = localStack();
  const res = await api("/auth/v1/admin/users", {
    key: serviceRoleKey,
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string; msg?: string };
  if (!body.id) {
    throw new Error(`Could not create ${email}: ${JSON.stringify(body)}`);
  }
  return { id: body.id, email };
}

let pool: Pool | undefined;

function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: localStack().dbUrl, max: 2 });
  return pool;
}

/**
 * Run one statement as `postgres`.
 *
 * Parameterised rather than interpolated even here, where every value is
 * generated by this file: `CLAUDE.md` § Non-negotiable rules says
 * "no string-concatenated SQL, anywhere", and a fixture that quietly exempts
 * itself is the template the next fixture copies.
 */
async function sql(text: string, params: unknown[] = []): Promise<void> {
  await db().query(text, params);
}

/** Close the pool, or the Playwright process will not exit. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Build the world. Returns everything a test needs to address it by id.
 *
 * The suffix is per-run rather than fixed, so a crashed run leaves rows that
 * cannot collide with the next one -- and `teardown` still removes them by
 * organisation, which cascades.
 */
export async function setUpWorld(): Promise<E2eWorld> {
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const orgSlug = `e2e-${suffix}`;
  const otherOrgSlug = `e2e-other-${suffix}`;

  const users: Record<E2eRole, E2eUser> = {
    manager: await createUser(`e2e-manager-${suffix}@test.local`),
    standard_user: await createUser(`e2e-std-${suffix}@test.local`),
    read_only: await createUser(`e2e-ro-${suffix}@test.local`),
  };
  // The other tenant's owner. Never signed in as -- they exist so the second
  // organisation has a member, which is what makes its rows real rather than
  // orphaned.
  const otherOwner = await createUser(`e2e-otherowner-${suffix}@test.local`);

  await sql(
    `insert into public.organisations (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
    [orgId, `E2E ${suffix}`, orgSlug, otherOrgId, `E2E Other ${suffix}`, otherOrgSlug],
  );

  // NO organisation_subscriptions ROW ON PURPOSE.
  // `private.crm_write_organisations()` treats "no subscription" as "not yet
  // billed, not yet gated" (20260828140000). A Starter row would work too; no
  // row is the state a freshly created workspace is actually in today, so it is
  // the state the golden path should be walked in.
  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'manager','active',now()),
            ($1,$3,'standard_user','active',now()),
            ($1,$4,'read_only','active',now()),
            ($5,$6,'owner','active',now())`,
    [
      orgId,
      users.manager.id,
      users.standard_user.id,
      users.read_only.id,
      otherOrgId,
      otherOwner.id,
    ],
  );

  const otherOrgContactId = randomUUID();
  const managerOwnedContactId = randomUUID();
  const hostileContactId = randomUUID();

  await sql(
    `insert into public.contacts (id, organisation_id, owner_user_id, name, email)
     values ($1,$2,$3,'Other Tenant Secret','secret@other.test'),
            ($4,$5,$6,'Manager Only Contact', null)`,
    [
      otherOrgContactId,
      otherOrgId,
      otherOwner.id,
      managerOwnedContactId,
      orgId,
      users.manager.id,
    ],
  );

  // THE VALUES A FORM WOULD REFUSE, WRITTEN PAST THE FORM.
  //
  // `lib/crm/validate.ts` rejects a `javascript:` website on the way IN, and
  // the browser walk confirms it does. That is the wrong control to rely on:
  // rows predating the validator, rows written by a migration, and rows written
  // by any future admin path all skip it. What has to hold is that the RENDER
  // refuses them -- `safeHref()`, per CLAUDE.md § Non-negotiable rules -- so
  // they go in through Postgres, which is the only way to get them in at all.
  await sql(
    `insert into public.contacts
       (id, organisation_id, owner_user_id, name, website, socials)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      hostileContactId,
      orgId,
      users.manager.id,
      `Hostile Values <img src=x onerror="document.title='XSS-FIRED'">`,
      `javascript:document.title='HREF-FIRED'`,
      JSON.stringify({
        instagram: "javascript:document.title='SOCIAL-FIRED'",
        spotify: "data:text/html,<script>document.title='DATA-FIRED'</script>",
        x: "https://x.com/legitimate",
      }),
    ],
  );

  // =========================================================================
  // PHASE 3 TASK 7'S ROWS
  // =========================================================================
  // `starts_at` is NOT NULL (20260901000000) and both of this tenant's events
  // are in the FUTURE, deliberately: the same two rows are what the venue
  // page's "Events here" list pages and what the workspace home's upcoming
  // block reads, so one fixture serves both and there is no second set of
  // dates to keep in step.
  //
  // `owner_user_id` IS WRITTEN EXPLICITLY rather than left to the column's
  // `default auth.uid()`: this connection is `postgres`, not a session, so the
  // default would return NULL and every event would be a record NOBODY can see
  // -- which would make the record-scope assertion pass for the wrong reason.
  const venueId = randomUUID();
  const venueRoomId = randomUUID();
  const altVenueId = randomUUID();
  const managerOwnedEventId = randomUUID();
  const standardOwnedEventId = randomUUID();
  const softDeletedEventId = randomUUID();
  const hostileEventId = randomUUID();
  const artistId = randomUUID();
  const otherOrgVenueId = randomUUID();
  const otherOrgEventId = randomUUID();
  const otherOrgArtistId = randomUUID();

  await sql(
    `insert into public.venues (id, organisation_id, owner_user_id, name)
     values ($1,$2,$3,$4), ($5,$6,$7,$8), ($9,$2,$10,$11)`,
    [
      venueId,
      orgId,
      // OWNED BY THE STANDARD USER, AND THAT IS THE WHOLE RECORD-SCOPE TEST.
      // Venues are record-scoped like every other top-level entity, so a
      // manager-owned venue 404s for the standard user and the "their venue
      // page shows their event and not the manager's" assertion could never
      // run -- it failed exactly that way on the first e2e run. The MANAGER is
      // full-scope (`private.full_scope_organisations()` excludes only
      // standard_user and read_only), so they still see this venue and both
      // events at it.
      users.standard_user.id,
      VENUE_NAME,
      otherOrgVenueId,
      otherOrgId,
      otherOwner.id,
      "Other Tenant Venue",
      altVenueId,
      users.manager.id,
      ALT_VENUE_NAME,
    ],
  );

  // A ROOM AT THAT VENUE (Task 8). `venue_rooms` carries no `owner_user_id`:
  // record scope follows the venue (20260827232510), so this room is inside
  // the standard user's scope exactly as the venue above is.
  await sql(
    `insert into public.venue_rooms (id, organisation_id, venue_id, name)
     values ($1,$2,$3,$4)`,
    [venueRoomId, orgId, venueId, ROOM_NAME],
  );

  await sql(
    `insert into public.artists (id, organisation_id, owner_user_id, name)
     values ($1,$2,$3,$4), ($5,$6,$7,$8)`,
    [
      artistId,
      orgId,
      users.manager.id,
      ARTIST_NAME,
      otherOrgArtistId,
      otherOrgId,
      otherOwner.id,
      OTHER_ARTIST_NAME,
    ],
  );

  await sql(
    `insert into public.events
       (id, organisation_id, owner_user_id, venue_id, name, starts_at, status)
     values ($1,$2,$3,$4,$5, now() + interval '14 days', 'confirmed'),
            ($6,$2,$7,$4,$8, now() + interval '21 days', 'planned'),
            ($9,$10,$11,$12,$13, now() + interval '10 days', 'confirmed')`,
    [
      managerOwnedEventId,
      orgId,
      users.manager.id,
      venueId,
      EVENT_NAMES.managerOwned,
      standardOwnedEventId,
      users.standard_user.id,
      EVENT_NAMES.standardOwned,
      otherOrgEventId,
      otherOrgId,
      otherOwner.id,
      otherOrgVenueId,
      EVENT_NAMES.otherTenant,
    ],
  );

  // ---- FIX ROUND 1 (I-1): a soft-deleted FUTURE event.
  //
  // SOONER THAN EITHER LIVE ONE (+7 days against +14 and +21), deliberately: if
  // the upcoming block ever stopped filtering `deleted_at`, this row would sort
  // to the TOP of the five rather than to a position a short fixture might not
  // reach. `deleted_at` is set in the same statement, so there is no window in
  // which the world holds a live event nobody meant to create.
  await sql(
    `insert into public.events
       (id, organisation_id, owner_user_id, venue_id, name, starts_at, status,
        deleted_at)
     values ($1,$2,$3,$4,$5, now() + interval '7 days', 'planned', now())`,
    [
      softDeletedEventId,
      orgId,
      users.manager.id,
      venueId,
      EVENT_NAMES.softDeleted,
    ],
  );

  // ---- TASK 8: a PAST event whose ticket link the renderer must refuse.
  //
  // NO VENUE, deliberately: it exists for one assertion on its own detail page
  // and must not appear in the venue page's "Events here" list, where it would
  // be a third row two other tests count on not seeing.
  await sql(
    `insert into public.events
       (id, organisation_id, owner_user_id, name, starts_at, status,
        ticket_link)
     values ($1,$2,$3,$4, now() - interval '30 days', 'completed', $5)`,
    [
      hostileEventId,
      orgId,
      users.manager.id,
      EVENT_NAMES.hostileTicket,
      HOSTILE_TICKET_LINK,
    ],
  );

  // The artist is on the manager-owned event's bill, which is what the artist
  // page's "Event history" reads -- through `event_lineup`, not through a
  // column on `events`.
  //
  // AND A REMOVED SLOT ON THE OTHER EVENT (fix round 1, M-3). `deleted_at` on
  // `event_lineup` is the OTHER hand-written soft-delete clause this task
  // added -- step one of `loadEventsForArtist` -- and it had no test either.
  // With this row, "the artist page does not show Standard Night A" stops
  // being a statement about an artist who was never booked and becomes a
  // statement about one who was UNBOOKED: drop the clause and the event comes
  // back into their history.
  await sql(
    `insert into public.event_lineup
       (organisation_id, event_id, artist_id, position, billing, deleted_at)
     values ($1,$2,$3,0,'headliner', null),
            ($1,$4,$3,1,'support', now())`,
    [orgId, managerOwnedEventId, artistId, standardOwnedEventId],
  );

  // AND A LINEUP IN THE OTHER TENANT (Task 8). Until this row existed, every
  // cross-tenant event assertion in this suite was made against a tenant whose
  // `event_lineup` was EMPTY -- so "the other tenant's lineup does not leak"
  // was satisfied by there being no lineup to leak. `event_lineup` has its own
  // three policies (20260901011000) reached through `event_lineup_select_via_event`,
  // which is a different expression from `events_select_view_crm`, and a
  // browser could not previously tell the two apart.
  await sql(
    `insert into public.event_lineup
       (organisation_id, event_id, artist_id, position, billing)
     values ($1,$2,$3,0,'headliner')`,
    [otherOrgId, otherOrgEventId, otherOrgArtistId],
  );

  // =========================================================================
  // PHASE 4 TASK 8'S OPERATIONS ROWS
  // =========================================================================
  // Setup is `pg` as `postgres` for the same reason every other row here is
  // (§ AND WHY SETUP IS `pg` above): a task/meeting/note write goes through an
  // INSERT policy that needs a session, and this connection is not one. What the
  // tests ASSERT on still goes through a real browser and anon-key session.
  const taskId = randomUUID();
  const meetingId = randomUUID();
  const privateNoteId = randomUUID();
  const companyNoteId = randomUUID();
  const cleanDocumentId = randomUUID();
  const quarantinedDocumentId = randomUUID();
  const otherOrgTaskId = randomUUID();
  const otherOrgNoteId = randomUUID();
  const otherOrgDocumentId = randomUUID();

  // A task in each tenant. The main one is owned by the manager; `completed_at`
  // is null (it is `open`), so the operations golden path is the thing that
  // completes it and produces the `task_completed` timeline row.
  await sql(
    `insert into public.tasks
       (id, organisation_id, owner_user_id, title, status, priority)
     values ($1,$2,$3,'Fixture task — confirm the rider','open','normal'),
            ($4,$5,$6,'Other Tenant Secret Task','open','normal')`,
    [taskId, orgId, users.manager.id, otherOrgTaskId, otherOrgId, otherOwner.id],
  );

  // The main task is LINKED to the manager's event, so the event's related
  // panel shows it before the golden path completes it. Through `task_links`
  // (entity_type `event`), which is a different policy from the task's own.
  await sql(
    `insert into public.task_links
       (organisation_id, parent_id, entity_type, entity_id)
     values ($1,$2,'event',$3)`,
    [orgId, taskId, managerOwnedEventId],
  );

  // A meeting in the main tenant, owned by the manager. `starts_at` is NOT NULL.
  await sql(
    `insert into public.meetings
       (id, organisation_id, owner_user_id, title, starts_at, status)
     values ($1,$2,$3,'Fixture meeting — production call',
             now() + interval '3 days','scheduled')`,
    [meetingId, orgId, users.manager.id],
  );

  // TWO NOTES IN THE MAIN TENANT AND ONE IN THE OTHER, and the pair in the main
  // tenant is the visibility payoff: the `private` one is authored by the
  // manager and reaches only them; the `company` one reaches every viewer. The
  // other tenant's is `private` too, but tenant scope refuses it before
  // visibility is even consulted.
  await sql(
    `insert into public.notes
       (id, organisation_id, owner_user_id, body, visibility)
     values ($1,$2,$3,$4,'private'),
            ($5,$2,$3,$6,'company'),
            ($7,$8,$9,$10,'private')`,
    [
      privateNoteId,
      orgId,
      users.manager.id,
      NOTE_BODIES.managerPrivate,
      companyNoteId,
      NOTE_BODIES.company,
      otherOrgNoteId,
      otherOrgId,
      otherOwner.id,
      NOTE_BODIES.otherTenant,
    ],
  );

  // THREE DOCUMENTS. `scan_status` is set DIRECTLY here rather than through the
  // upload pipeline, because this connection is `postgres` and cannot run the
  // scanner or write to Storage; the real EICAR-stub pipeline (upload -> scan ->
  // quarantine) is walked in a browser by `documents.spec.ts`. `scanned_at` is
  // set for every terminal verdict (`documents_scanned_at_iff_terminal`), and
  // `storage_key` starts with `<organisation_id>/` (`documents_storage_key_shape`).
  // These rows have no bytes in the bucket, which is why the tests that assert on
  // them read the LIST (chip + link presence), never fetch a clean fixture doc's
  // bytes — the download-resolves assertion uses a real uploaded PDF instead.
  await sql(
    `insert into public.documents
       (id, organisation_id, owner_user_id, filename, storage_key, mime_type,
        size_bytes, scan_status, scanned_at)
     values ($1,$2,$3,$4,$5,'application/pdf',1024,'clean',now()),
            ($6,$2,$3,$7,$8,'text/plain',68,'quarantined',now()),
            ($9,$10,$11,$12,$13,'application/pdf',2048,'clean',now())`,
    [
      cleanDocumentId,
      orgId,
      users.manager.id,
      DOCUMENT_NAMES.clean,
      `${orgId}/fixtures/${cleanDocumentId}-clean.pdf`,
      quarantinedDocumentId,
      DOCUMENT_NAMES.quarantined,
      `${orgId}/fixtures/${quarantinedDocumentId}-quarantined.txt`,
      otherOrgDocumentId,
      otherOrgId,
      otherOwner.id,
      DOCUMENT_NAMES.otherTenant,
      `${otherOrgId}/fixtures/${otherOrgDocumentId}-secret.pdf`,
    ],
  );

  // The clean main-tenant document is attached to the manager-owned contact;
  // the other tenant's is attached to its event. `document_links` again is a
  // policy of its own, reached only for a document the caller can already see.
  await sql(
    `insert into public.document_links
       (organisation_id, parent_id, entity_type, entity_id)
     values ($1,$2,'contact',$3),
            ($4,$5,'event',$6)`,
    [
      orgId,
      cleanDocumentId,
      managerOwnedContactId,
      otherOrgId,
      otherOrgDocumentId,
      otherOrgEventId,
    ],
  );

  return {
    orgSlug,
    orgId,
    otherOrgSlug,
    otherOrgId,
    otherOrgContactId,
    managerOwnedContactId,
    hostileContactId,
    venueId,
    venueRoomId,
    altVenueId,
    managerOwnedEventId,
    standardOwnedEventId,
    softDeletedEventId,
    hostileEventId,
    artistId,
    otherOrgEventId,
    otherOrgArtistId,
    taskId,
    meetingId,
    privateNoteId,
    companyNoteId,
    cleanDocumentId,
    quarantinedDocumentId,
    otherOrgTaskId,
    otherOrgNoteId,
    otherOrgDocumentId,
    users,
    otherOwner,
  };
}

/**
 * Delete the world.
 *
 * Deleting the two organisations cascades to every tenant row -- contacts,
 * companies, artists, venues, rooms, links, custom field values, and (since
 * Phase 3 Task 7) events and their lineup rows, both of which carry
 * `organisation_id ... on delete cascade`. Auth users are
 * removed separately, through the Admin API, because nothing cascades into
 * `auth.users` and this suite must not be the thing that teaches the codebase
 * to delete from it by hand.
 */
export async function tearDownWorld(world: E2eWorld): Promise<void> {
  const { serviceRoleKey } = localStack();
  await sql(`delete from public.organisations where id = any($1::uuid[])`, [
    [world.orgId, world.otherOrgId],
  ]);
  // THE OTHER TENANT'S OWNER IS DELETED BY ID, LIKE EVERY OTHER USER
  // (Task 8; the deferred minor this closes).
  //
  // It used to be found by LISTING UP TO 1000 auth users and matching an email
  // this function re-derived from the slug. That was wrong twice over. It was
  // a lookup for an id `setUpWorld` already held and simply did not return --
  // and on a stack whose `auth.users` has grown past a thousand rows (this
  // suite creates four per run and the psql suite creates twelve), the owner
  // would not be on the first page, the `if` would never match, and teardown
  // would leak one auth user per run in silence. `world.otherOwner` is the id,
  // so there is nothing left to search for.
  for (const user of [...Object.values(world.users), world.otherOwner]) {
    await api(`/auth/v1/admin/users/${user.id}`, {
      key: serviceRoleKey,
      method: "DELETE",
    });
  }
  await closeDb();
}
