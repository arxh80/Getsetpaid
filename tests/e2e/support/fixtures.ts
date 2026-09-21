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
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
// RELATIVE, NOT `@/tests/support/totp`. This file is loaded by Playwright's own
// transform, which does not resolve the `@/` alias vitest's config sets up --
// the same reason `localStack()` below is a copy of the integration suite's env
// helper rather than an import of it.
import { totpCode } from "../../support/totp";

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

// ===========================================================================
// PHASE 5 TASK 5: THE FINANCE FIXTURE VOCABULARY
// ===========================================================================
// CONSTANTS FOR THE SAME REASON `EVENT_NAMES` AND `NOTE_BODIES` ARE: the
// role/tier/tenant breakout assertions are ABSENCES, and a typo'd literal in an
// absence assertion passes forever and silently. The BOOKER assertions in
// tenant-breakout.spec.ts are made against every string below that belongs to
// the Pro org's ledger event, and the cross-tenant one against `otherTenant` --
// those are the strings a browser holding a session without `view_finance` must
// never render.
//
// `formatted` IS THE RENDERED STRING, NOT A SECOND SOURCE OF TRUTH. It is what
// `formatGbp(amountMinor)` produces (lib/format/money.ts, Intl en-GB GBP), so a
// test can assert the money a user actually reads. If the formatter changes,
// these go red naming the amount -- which is the point: money on a page is what
// this phase exists to get right.
export const FINANCE_EVENT_NAMES = {
  /** The GOLDEN PATH's event. Deliberately carries NO planted finance lines:
   *  the walk adds both of them, so the summary it reads afterwards is a
   *  statement about exactly what it wrote and nothing else. */
  goldenPath: "Pro Finance Night",
  /** The Pro org's SECOND event, planted with a full ledger (a budgeted fee, an
   *  actual income and a soft-deleted line). The Booker breakout and the axe
   *  scan read this one, so neither depends on the golden path having run. */
  proLedger: "Pro Ledger Night",
  /** The STARTER org's event. One planted line, which is the Q67 payoff: a
   *  downgraded workspace keeps READING its finance. */
  starter: "Starter Downgrade Night",
} as const;

/** The artist and supplier contact the Pro org's planted lines link, so the
 *  panel's linked-name render path is exercised by a browser (and scanned by
 *  axe) rather than only by a unit test. */
export const PRO_ARTIST_NAME = "E2E Ledger Headliner";
export const PRO_SUPPLIER_NAME = "E2E Ledger Supplier";

interface FinanceLineFixture {
  readonly description: string;
  readonly amountMinor: number;
  /** What `formatGbp(amountMinor)` renders -- the string a user reads. */
  readonly formatted: string;
}

export const FINANCE_LINES: Record<
  "fixtureFee" | "fixtureIncome" | "removed" | "starter" | "otherTenant",
  FinanceLineFixture
> = {
  /** BUDGETED FEE on the Pro ledger event -> the budgeted EXPENSE column. */
  fixtureFee: {
    description: "Fixture Fee Line — headline artist",
    amountMinor: 150000,
    formatted: "£1,500.00",
  },
  /** ACTUAL INCOME on the same event -> the actual GROSS column. */
  fixtureIncome: {
    description: "Fixture Income Line — box office",
    amountMinor: 400000,
    formatted: "£4,000.00",
  },
  /** SOFT-DELETED on the same event. In the "Removed from this list"
   *  disclosure, and in NEITHER summary column -- the view filters
   *  `deleted_at is null`. */
  removed: {
    description: "Fixture Removed Line — cancelled support",
    amountMinor: 25000,
    formatted: "£250.00",
  },
  /** The STARTER org's one line. Readable after the downgrade (Q67), and the
   *  denominator for "the refused write added nothing". */
  starter: {
    description: "Starter Line — readable after a downgrade",
    amountMinor: 99900,
    formatted: "£999.00",
  },
  /** A finance line in the OTHER tenant, on that tenant's event. Must appear on
   *  no surface any session in this suite can reach. */
  otherTenant: {
    description: "Other Tenant Secret Finance Line",
    amountMinor: 777700,
    formatted: "£7,777.00",
  },
};

/** Roles this suite signs in as. */
export type E2eRole =
  | "manager"
  | "standard_user"
  | "read_only"
  // ---- PHASE 5 TASK 5 -----------------------------------------------------
  // `finance` is the FIRST role this suite signs in as that CLAUDE.md
  // § Session security requires MFA for (`private.role_requires_mfa('finance')`
  // is true, so BOTH finance keys are aal2-gated inside has_permission()). Its
  // browser sign-in therefore walks the real per-sign-in TOTP challenge -- see
  // `financeTotpSecret` below and `signIn` in ./sign-in.ts.
  | "finance"
  // `booker` holds view_crm and seven manage_* keys and NOT view_finance
  // (20260903002000), which is exactly the shape the finance render gate has to
  // refuse: a fully-privileged CRM user who may not see the money.
  | "booker"
  // ---- PHASE 7 TASK 7 -----------------------------------------------------
  // THE TWO ROLES NOTHING IN THIS SUITE HAD EVER SIGNED IN AS.
  //
  // Until this task `E2eRole` was `manager | standard_user | read_only |
  // finance | booker`, and sign-in.ts said so outright: "owner and admin are
  // the other two and nothing here is either". The consequence was not a gap
  // in coverage, it was a class of GREEN TESTS THAT MEASURED NOTHING --
  //
  //   * every Owner/Admin-only surface (`manage_custom_fields`,
  //     `manage_members`, `manage_organisation` are the only three
  //     permissions in `role_permissions` held by exactly {owner, admin})
  //     had never been rendered by a session that holds the key, so a scan
  //     or a walk against one was measuring an EMPTY page; and
  //   * the plan's own named case for Task 7 -- "unreachable by a
  //     non-superuser, EVEN AN ORG OWNER" -- could not be written at all,
  //     and the /super refusal probes that exist were all driven by a
  //     manager with the standing note that "an Org Owner is MFA-required,
  //     so an owner probe would be measuring the MFA challenge rather than
  //     the superuser gate".
  //
  // Both are MFA-REQUIRED (`private.role_requires_mfa()`, CLAUDE.md
  // § Session security), so both walk the real per-sign-in TOTP challenge
  // against the live GoTrue verifier, from `ownerTotpSecret`/`adminTotpSecret`
  // below. An owner or admin persona that did NOT walk it would sign in at
  // aal1, hold NEITHER of its two exclusive keys, and refuse everywhere for
  // the MFA reason rather than the reason under test -- which is the same
  // denominator failure this task exists to close, reintroduced by the
  // fixture meant to close it.
  | "owner"
  | "admin";

export interface E2eUser {
  id: string;
  email: string;
}

export interface E2eWorld {
  /** Slug of the workspace the golden path is walked in. */
  orgSlug: string;
  /** Its display NAME -- what a confirmation step shows a person. */
  orgName: string;
  orgId: string;
  /**
   * A SECOND tenant, for the breakout run.
   *
   * CORRECTED IN PHASE 6 TASK 5. This comment used to read "Nobody in `users`
   * belongs to it", and that was true when it was written and is not now: the
   * second tenant has always had `otherOwner`, and Task 5 added `otherMember`
   * -- a manager of it that a browser actually signs in as. The distinction
   * that survives is about `users`, the fixed `E2eRole` record: no persona
   * addressed BY ROLE (`signIn(page, world, "manager")`) belongs to this
   * tenant, and that is what keeps the breakout assertions meaningful. Its two
   * members are addressed by id.
   */
  otherOrgSlug: string;
  otherOrgId: string;
  /** A contact in the OTHER tenant. Its id is a valid uuid that must refuse
   *  (the streamed not-found contract under one's own slug; literal 404 under
   *  the foreign slug -- see tenant-breakout.spec.ts's expectRefused). */
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
  //   tenant boundary   the other tenant's event must refuse from BOTH slugs
  //                     (literal 404 under the foreign slug; the streamed
  //                     not-found contract under one's own)
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
  /** An event in the OTHER tenant. Its id is a valid uuid that must refuse (streamed not-found under one's own slug). */
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
  /** A task in the OTHER tenant. A valid uuid that must refuse from this session. */
  otherOrgTaskId: string;
  /** A `private` note in the OTHER tenant (`Other Tenant Secret Note`). */
  otherOrgNoteId: string;
  /** A `clean` document in the OTHER tenant (`Other Tenant Secret Contract`),
   *  linked to that tenant's event. A valid uuid that must refuse here, and whose
   *  filename must never appear on this tenant's document list. */
  otherOrgDocumentId: string;

  // =========================================================================
  // PHASE 5 TASK 5: THE FINANCE ORGANISATIONS
  // =========================================================================
  // TWO MORE TENANTS, AND THE TIER IS THE WHOLE REASON THEY EXIST.
  //
  // The main organisation carries a real STARTER row (see the insert in
  // `setUpWorld`, added by Phase 7 Task A). Starter's finance_module is
  // false -- so a finance write there is REFUSED, which is a real behavioural
  // flip from before Task A: `private.finance_module_organisations()` itself
  // is untouched by that task (its "no subscription row" escape is a
  // deliberate, separate follow-up -- FOLLOW-UPS.md § "Phase 7 -- superuser
  // dashboard" -- and Starter/Free's finance_module was always false), but
  // the main org used to be the one place that escape was actually exercised:
  // it had NO subscription row before Task A, and that escape ALLOWED finance
  // writes ("not yet billed => not yet gated"). Task A's create_organisation()
  // change gave it a real Starter row instead, which the tier itself refuses.
  // Net effect on this org: finance writes went from ALLOWED (via the escape)
  // to REFUSED (via the tier) -- unexercised by any spec (no `tests/e2e/`
  // spec writes finance against `world.orgSlug`), but worth stating correctly
  // here since this is the exact file a future finance e2e test would read.
  // Either way, a finance write here still proves nothing about the Pro gate
  // -- that is what these two carry their OWN, DIFFERENT subscription rows
  // for:
  //
  //   proOrg      plan_id 'pro',     status 'active'  -> finance_module TRUE
  //   starterOrg  plan_id 'starter', status 'active'  -> finance_module FALSE
  //
  // So the golden path's write is permitted BY THE TIER TERM rather than by an
  // escape hatch, and the Starter org is the Q67 payoff: reads stay open,
  // writes refuse.
  /** The Pro-tier workspace. The finance golden path is walked here. */
  proOrgSlug: string;
  proOrgId: string;
  /** The Starter-tier workspace. Same finance user, no finance module. */
  starterOrgSlug: string;
  starterOrgId: string;
  /** The Pro org's GOLDEN-PATH event: no planted finance lines, so the summary
   *  the walk reads is a statement about the two lines the walk wrote. */
  proEventId: string;
  /** The Pro org's LEDGER event: a budgeted fee, an actual income and a
   *  soft-deleted line, planted. The Booker breakout and the axe scan read it,
   *  so neither depends on the golden path having run. */
  proLedgerEventId: string;
  /** The Starter org's event, carrying one planted line. */
  starterEventId: string;
  /** An artist and a contact in the Pro org, linked from the planted lines so
   *  the panel's linked-name render path is walked in a browser. */
  proArtistId: string;
  proSupplierContactId: string;
  /** The planted lines, by id -- addressable for a targeted assertion. */
  proFeeEntryId: string;
  proIncomeEntryId: string;
  proRemovedEntryId: string;
  starterEntryId: string;
  /** A finance line in the OTHER tenant, on that tenant's event. The
   *  cross-tenant finance assertion's subject. */
  otherOrgFinanceEntryId: string;
  /**
   * The finance user's TOTP secret, base32, as `mfa.enroll()` returned it.
   *
   * NOT A SECRET WORTH PROTECTING: it belongs to a throwaway auth user this run
   * created and `tearDownWorld` deletes. It is here because the finance role is
   * MFA-required, so a browser sign-in has to present a real 6-digit code to
   * the LIVE GoTrue verifier -- ./sign-in.ts generates it from this. Stubbing
   * the challenge instead would prove nothing about the gate that decides
   * whether the finance keys are held at all.
   */
  financeTotpSecret: string;

  /**
   * PHASE 7 TASK 7. The real, verified factors the `owner` and `admin`
   * personas' browser sign-ins walk.
   *
   * Same shape and same non-secrecy as `financeTotpSecret` above: they belong
   * to throwaway accounts this run created and `tearDownWorld` deletes.
   * `signIn()` selects between these three by role -- see TOTP_SECRET_BY_ROLE
   * in ./sign-in.ts, which replaced a single hardcoded `financeTotpSecret`
   * read that would have silently presented the FINANCE user's code at an
   * owner's challenge and failed as "wrong code" rather than as "the fixture
   * does not carry this role's secret".
   */
  ownerTotpSecret: string;
  /** @see ownerTotpSecret */
  adminTotpSecret: string;

  // =========================================================================
  // PHASE 7 TASK 1: THE PLATFORM SUPERUSER
  // =========================================================================
  // Not one of the fixed `E2eRole` personas `signIn()` addresses by role --
  // same reasoning as `otherOwner`/`otherMember`/`freeMember`: superuser
  // status is `public.platform_admins` membership, not an organisation
  // role, so it does not belong in the `users` record every organisation-
  // scoped breakout assertion in this suite reasons about. Signed in by hand
  // in the spec (tests/e2e/audit-log.spec.ts), the same "manual form walk"
  // idiom tenant-breakout.spec.ts's signInAsOtherMember uses -- except this
  // one ALSO walks the TOTP challenge, because the platform superuser is
  // MFA-required (CLAUDE.md § Session security) and
  // has_platform_permission('view_audit_log') is aal2-gated
  // (20260827210000_mfa_aal_permission_gate.sql): a password-only session
  // would find the audit log page render (isSuperuser() is NOT aal-gated,
  // deliberately -- see lib/admin/superuser.ts) but every real query behind
  // it would come back empty, which is exactly the wrong thing for a test
  // that means to prove the CROSS-TENANT READ works.
  superuser: E2eUser;
  /** Same shape and same non-secrecy as `financeTotpSecret` above --
   *  `enrolTotp` gives this account a real, verified TOTP factor so a
   *  browser sign-in walks the genuine per-sign-in challenge rather than
   *  stubbing it. */
  superuserTotpSecret: string;

  // =========================================================================
  // PHASE 7 TASK 2: THE ORGANISATION ADMIN WHO GIVES CONSENT
  // =========================================================================
  // Break-glass impersonation cannot be walked without one. `users` -- the
  // fixed `E2eRole` record -- deliberately contains no Owner or Admin of
  // `orgId` (its three members are a manager, a standard user and a read-only
  // user), and `manage_organisation` is the permission
  // public.accept_impersonation_request() requires. Nobody in the world could
  // accept a request before this account existed, which is the correct
  // product behaviour and a dead end for a test.
  //
  // ADDED TO `orgId`, NOT TO A NEW ORGANISATION, ON PURPOSE: the impersonated
  // workspace has to contain real CRM records for "tenant data is visible"
  // to mean anything, and `orgId` is the one this suite fills with contacts,
  // events, tasks and notes. Nothing else in this directory reads
  // /[orgSlug]/members or counts memberships (grepped), so a fourth member
  // perturbs no existing assertion.
  //
  // MFA-ENROLLED, like `finance` and `superuser` and for the same reason:
  // `admin` is one of the roles private.role_requires_mfa() covers, so an
  // aal1 session of this account holds manage_organisation NOT AT ALL --
  // it could sign in, reach the page, and find the accept button refuse. A
  // stubbed challenge would prove nothing about the gate the consent
  // actually passes through.
  orgAdmin: E2eUser;
  /** @see orgAdmin -- the real, verified factor its browser sign-in walks. */
  orgAdminTotpSecret: string;
  /**
   * TWO PLANTED `audit_events` ROWS, ONE PER TENANT, WITH DISTINCT ACTION
   * STRINGS -- the audit log e2e spec's deterministic fixture data.
   *
   * WHY PLANTED RATHER THAN RELIED ON NATURALLY. `orgId`/`otherOrgId` are
   * inserted directly by SQL below (not through `create_organisation()`),
   * so they write no `organisation.created` row, and nothing else this file
   * does is guaranteed to leave a KNOWN, FILTERABLE action string in a KNOWN
   * organisation by the time the audit-log spec runs -- assertions built on
   * "whatever happens to be in the table" would be non-deterministic and
   * would break the moment an earlier step in this file changed shape.
   * These two rows are `postgres`-inserted directly (the same route
   * `sql()` uses for every other planted fixture row; audit_events has no
   * INSERT grant for any client role at all, by design), each in a
   * DIFFERENT organisation so the spec can prove the superuser's read
   * spans both, and each with a distinct `action` so a filter by exact
   * action string is provably narrowing rather than vacuously matching
   * everything.
   */
  auditProbeAlphaId: string;
  auditProbeBetaId: string;

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

  // =========================================================================
  // PHASE 6 TASK 5: A REAL MEMBER OF THE COUNTERPARTY TENANT
  // =========================================================================
  // THE FIXTURE THE NETWORK-LEAKAGE PROOF NEEDED, AND WHY IT IS NEW WORK.
  //
  // This world could already drive a counterparty in ONE direction: ALPHA's
  // personas looking at `otherOrgId`'s rows and getting refusals. It could not
  // drive the other -- somebody signed in INSIDE the second tenant, looking
  // back at ALPHA -- because the only member of that tenant was `otherOwner`,
  // whom nothing signs in as, and `owner` is MFA-required so a plain browser
  // sign-in would hold no key at all and every refusal would be the MFA gate
  // rather than the tenant boundary.
  //
  // `otherMember` is a `manager`: MFA-optional, so a password sign-in really
  // does hold `view_network` and `view_crm`, which is what makes a refusal on
  // ALPHA's contact a statement about the boundary. It is also UNCONNECTED to
  // ALPHA -- no connection request touches `otherOrgId` -- which is the
  // browser half of the network-leakage matrix's "unconnected" column
  // (`proOrgSlug`'s booker is its "connected" column, through the
  // hand-planted `networkAcceptedRequestId`).
  //
  // Signed in by hand in the spec, like `freeMember`: it is not one of the
  // fixed `E2eRole` personas `signIn()` addresses by role, and deliberately
  // so -- adding it to `users` would put a member of the second tenant inside
  // the record every breakout assertion in this suite reasons about.
  otherMember: E2eUser;

  // =========================================================================
  // PHASE 6 TASK 3: THE DISCOVERY WORLD
  // =========================================================================
  // A FIFTH ORGANISATION, ON A REAL `free` SUBSCRIPTION ROW -- the other four
  // are all either unbilled (orgId, otherOrgId) or paid (proOrgId,
  // starterOrgId), and Free-tier honesty ("Free users SEE the directory in
  // full; only the request control is disabled") needs a workspace that is
  // genuinely on the free plan rather than resting on the no-subscription
  // escape (`entitlementsPermitNetworkPublish` treats "no subscription" as
  // UNGATED -- lib/network/access.ts's own header -- so `orgId` would prove
  // the wrong thing here).
  /** The Free-tier workspace. */
  freeOrgSlug: string;
  freeOrgId: string;
  /** A member of `freeOrgSlug` only, MFA-optional (role `manager`, so it can
   *  also stand in for "any role" -- view_network is held by all nine).
   *  Signed in by hand in the spec file rather than through `signIn()`,
   *  because it is not one of the fixed `E2eRole` personas every other test
   *  in this suite addresses by role. */
  freeMember: E2eUser;

  /** ALPHA's published company profile (`orgId`) -- `city` and `headline` at
   *  `network`, `contact_email` at `connections`. The discovery walk's own
   *  subject: found by name from `proOrgSlug`, opened, and read as exactly
   *  the `network` fields until the accepted request below is planted. */
  networkAlphaProfileId: string;
  /** Its `display_name`, suffixed per run -- see the planting code's own
   *  header for why a network profile name cannot be a bare literal. */
  networkAlphaProfileName: string;
  /** ALPHA's DRAFT profile (`orgId`), never published. Neither masking view
   *  ever carries a draft, so this is what proves a foreign viewer gets the
   *  same refusal a nonexistent id would (status AND document, measured by the parity assertions) -- no existence leak. */
  networkDraftProfileId: string;
  /** Its `display_name`, suffixed per run. */
  networkDraftProfileName: string;
  /** BETA's (`proOrgSlug`) own minimal published profile. It exists only to
   *  satisfy `network_connection_requests.to_network_profile_id`'s NOT NULL
   *  (Q78: a request needs a published profile on each end) -- nothing reads
   *  it directly. */
  networkBetaAnchorProfileId: string;
  /** Its `display_name`, suffixed per run -- added by Task 4 alongside the
   *  other exposed profile names, for tests that need to find it by label
   *  rather than by id (e.g. the requests page's Sent row). */
  networkBetaAnchorProfileName: string;
  /** An ACCEPTED connection between `orgId` and `proOrgId`, hand-planted
   *  (Task 4 -- the real send/accept UI -- does not exist yet). Its existence
   *  is what the "connected" half of the discovery walk asserts: BETA's
   *  booker sees `networkAlphaProfileId`'s `contact_email` (a
   *  `connections`-level field) resolve, where an unconnected viewer would
   *  see it masked to null. */
  networkAcceptedRequestId: string;
  /** ALPHA's published profile carrying values a `javascript:`-rejecting,
   *  XSS-escaping form would never have accepted -- planted directly, so the
   *  RENDER path (ProfileCard's `safeHref()` guard, and React's own escaping
   *  of `display_name`/`headline`/`bio`) is what the walk measures, per the
   *  `hostileContactId` pattern above. Every hostile field is set to
   *  `network` visibility, so it resolves for any viewer without needing the
   *  accepted connection above. */
  networkHostileProfileId: string;
  /** Its hostile `display_name`, suffixed per run -- the marker string
   *  (`NETWORK-NAME-FIRED`) an executed `onerror` would produce is NOT part
   *  of this value; it is what the payload WOULD set `document.title` to if
   *  it fired. */
  networkHostileProfileName: string;

  // =========================================================================
  // PHASE 6 TASK 4: THE REQUEST-TO-CONNECT WORLD
  // =========================================================================
  // Two FRESH BETA (`proOrgId`) profiles, neither reused from Task 3's
  // hand-planted `networkAcceptedRequestId` pair (that pair's live-pair
  // index entry (orgId -> networkBetaAnchorProfileId) is already `accepted`,
  // so sending to it again would 23505 rather than exercise anything). ALPHA
  // sends to each of these from its OWN existing `networkAlphaProfileId` --
  // no new ALPHA profile is needed, since Q78 only requires ONE published
  // profile of the sender's and this world already has it.
  /** BETA's published VENUE profile -- the walk's "accept" target. Carries a
   *  `connections`-level field (`contact_email`) so the walk can prove BOTH
   *  sides resolve the other's connections fields once accepted (Q80). */
  networkBetaVenueProfileId: string;
  networkBetaVenueProfileName: string;
  /** BETA's second published profile -- the walk's "decline, then a fresh
   *  request" target (Q79 as changed 2026-09-07). A separate profile from the
   *  accept target, so the two request lifecycles (accepted vs. declined)
   *  never share one live-pair slot. */
  networkBetaDeclineProfileId: string;
  networkBetaDeclineProfileName: string;
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


/**
 * Give `email` a VERIFIED TOTP factor, and return its secret.
 *
 * ===========================================================================
 * WHY A FIXTURE HAS TO DO THIS AT ALL (PHASE 5 TASK 5)
 * ===========================================================================
 * `finance` is an MFA-required role (CLAUDE.md § Session security), and
 * 20260827210000 puts the requirement INSIDE `public.has_permission()`: a
 * finance membership whose session has not presented a factor holds NEITHER
 * `view_finance` NOR `manage_finance`. So a browser signed in with a password
 * alone would find no finance panel and no finance write, and every assertion
 * in the finance specs would pass or fail for the wrong reason.
 *
 * The fix is to make the FIXTURE realistic rather than to relax anything: a
 * real Finance user holds a real factor, so this one does too. The enrolment
 * runs through the LIVE GoTrue verifier with a real RFC 6238 code -- the same
 * shape `elevateToAal2` in tests/integration/rls/support/fixtures.ts uses, and
 * the opposite of stubbing the challenge.
 *
 * ONLY THE ENROLMENT HAPPENS HERE. The per-sign-in CHALLENGE is walked in the
 * browser, on the real gate screen (components/auth/mfa-challenge-gate.tsx),
 * by `signIn` in ./sign-in.ts -- which is the half that proves a password alone
 * does not reach aal2.
 *
 * MEASURED BEFORE RELYING ON IT: three separate sessions verified with the SAME
 * 30-second window's code against this local stack, and all three reached aal2
 * -- so several browser sign-ins inside one Playwright run do not need to wait
 * out a TOTP step. A hosted GoTrue with replay protection would; nothing here
 * runs against one (`localStack()` refuses anything but loopback).
 */
async function enrolTotp(email: string): Promise<string> {
  const { apiUrl, anonKey } = localStack();
  const client = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error) {
    throw new Error(`Fixture: could not sign in as ${email}: ${signedIn.error.message}`);
  }
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
  if (enrolled.error || !enrolled.data) {
    throw new Error(
      `Fixture: could not enrol TOTP for ${email}: ${enrolled.error?.message}`,
    );
  }
  const secret = enrolled.data.totp.secret;
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: enrolled.data.id,
    code: totpCode(secret),
  });
  if (verified.error) {
    throw new Error(
      `Fixture: TOTP enrolment challenge failed for ${email}: ${verified.error.message}`,
    );
  }
  // Assert the elevation rather than trusting a silent success -- otherwise a
  // regression surfaces as a baffling missing panel two files away.
  const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    throw new Error(
      `Fixture: ${email} is still ${aal?.currentLevel ?? "unknown"} after a successful TOTP challenge`,
    );
  }
  // LOCAL scope: this clears THIS client only. A global sign-out would revoke
  // every session for the user, including one a browser is about to open.
  await client.auth.signOut({ scope: "local" });
  return secret;
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
 * Count this organisation's OWN `network_connection_requests` rows,
 * sender-side. TASK 6, Constraint 12's proof.
 *
 * A stripped-`disabled`-and-submitted form is a claim about the RENDER layer
 * ("the button lied about being disabled"); the interesting failure mode
 * `SECURITY.md` warns against is the two-layer one where the render lied AND
 * the write went through anyway. `authoriseConnections`'s tier term is what
 * the psql/HTTP suites already prove refuses the INSERT; this is the same
 * claim read from the browser's own position, straight out of Postgres as
 * `postgres` (bypassing RLS on purpose, the same as every other fixture
 * helper in this file) rather than through a client that the tier gate could
 * itself be hiding a false positive behind. Sender-side only
 * (`from_organisation_id`) because Constraint 12's scenario is a Free
 * ORGANISATION trying to SEND -- it is never the recipient of anything, so
 * there is no `to_` case to count.
 */
export async function countSentConnectionRequests(
  organisationId: string,
): Promise<number> {
  const result = await db().query<{ count: string }>(
    "select count(*)::text as count from public.network_connection_requests where from_organisation_id = $1",
    [organisationId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * PHASE 7 TASK 1, FIX ROUND 1 (⚠️ 5). Count `audit_log.viewed` self-audit
 * rows for one actor -- the audit-log spec's ground truth for "did viewing
 * the page actually write the row it claims to, and did anything ELSE
 * (a Next.js Link prefetch, a re-render) write a SECOND one it should not
 * have". Same shape as `countSentConnectionRequests` immediately above:
 * straight out of Postgres as `postgres`, bypassing RLS on purpose, so the
 * count is not reading through the very audit_events policy a bug in it
 * could be hiding behind. Scoped to ONE actor (the spec's own throwaway
 * superuser, unique per run) rather than a bare action-string count, so a
 * concurrently-running spec file's own superuser writing the identical
 * action name cannot perturb the number.
 */
export async function countAuditLogViewedRows(
  actorUserId: string,
): Promise<number> {
  const result = await db().query<{ count: string }>(
    "select count(*)::text as count from public.audit_events where actor_user_id = $1 and action = 'audit_log.viewed'",
    [actorUserId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * PHASE 7 TASK 2, FIX ROUND 1 (Important 2). Suspend or reinstate an
 * organisation, as `postgres`.
 *
 * There is no client write path to `organisations.deleted_at` that a test
 * could drive -- suspension is a platform action and an Owner deliberately
 * cannot perform it (DECISIONS-QUEUE consequence P7), which is the whole
 * reason Q98 exists. So the only way to put the browser in front of a
 * suspended workspace is to set the column directly, the same route every
 * other planted fixture in this file uses.
 *
 * THE CALLER MUST REINSTATE IN A `finally`. This suite's specs are serial and
 * share one world; a workspace left suspended would silently turn every later
 * assertion into a suspension assertion.
 */
export async function setOrganisationSuspended(
  organisationId: string,
  suspended: boolean,
): Promise<void> {
  await sql(
    `update public.organisations set deleted_at = $2 where id = $1`,
    [organisationId, suspended ? new Date().toISOString() : null],
  );
}

/**
 * PHASE 7 TASK 4. Simulates a billing/feature override's natural expiry
 * without waiting for real wall-clock time to pass -- the brief's own
 * "(simulated) expiry restores Starter denial". Backdates `expires_at` on
 * whatever ACTIVE (unrevoked) row exists rather than deleting it: expiry is a
 * READ-TIME filter (private.active_billing_override() /
 * private.active_feature_override()), not a delete, and the row's continued
 * existence -- just outside its window -- is exactly what those functions are
 * proven against.
 *
 * Runs as `postgres` (bypasses RLS and the guard trigger), the same route
 * every other direct fixture manipulation in this file uses -- there is no
 * product path that ages a clock forward, by design.
 */
export async function expireBillingOverride(organisationId: string): Promise<void> {
  // starts_at is pushed back FIRST, in the same statement -- see supabase/
  // tests/rls_phase7_overrides.sql § OD's identical fix and comment: a grant
  // made moments ago carries a starts_at close to "now", and backdating only
  // expires_at can push it BEFORE starts_at, tripping
  // organisation_billing_overrides_window (measured: it did, on the first cut
  // of this helper). Widening the whole window first keeps expires_at's
  // move -- across "now" -- the only thing this call is actually testing.
  await sql(
    `update public.organisation_billing_overrides
        set starts_at  = now() - interval '2 hours',
            expires_at = now() - interval '1 minute'
      where organisation_id = $1 and revoked_at is null`,
    [organisationId],
  );
}

/**
 * PHASE 7 TASK 5. Plants one open incident alert so /super/health can be read
 * POPULATED rather than empty.
 *
 * INSERTED AS `postgres`, the same route `auditProbeAlphaId`/`auditProbeBetaId`
 * take and for the identical reason: `public.incident_alerts` has NO INSERT
 * policy and no INSERT grant for any client role at all (20260909020000) --
 * every real writer is a SECURITY DEFINER function behind a trigger or the
 * limiter, so there is no product path a browser could drive to create one.
 *
 * THIS DOES NOT REPLACE PROVING THE TRIGGERS. That the three conditions really
 * do raise a row is measured where it can be: `rls_phase7_rate_limits.sql`
 * § RA (the exactly-once rate-limit crossing), § RQ (the malware quarantine)
 * and § RH (the login lockout), plus `tests/integration/security/
 * rate-limit-network-discovery.test.ts` driving a real crossing through the
 * real page function. What is only observable HERE is that a row, once it
 * exists, renders and can be resolved by the operator -- and an empty-state
 * scan would miss every component this task added.
 *
 * The caller deletes it in a `finally`: these specs are serial and share one
 * world, and a stray open alert would change the "Open incident alerts" count
 * any later assertion reads.
 */
export async function plantIncidentAlert(
  organisationId: string | null,
  summary: string,
): Promise<string> {
  const result = await db().query<{ id: string }>(
    `insert into public.incident_alerts
       (alert_type, organisation_id, summary, details)
     values ('rate_limit_tripped', $1, $2, '{"category":"network_discovery"}'::jsonb)
     returning id`,
    [organisationId, summary],
  );
  return result.rows[0].id;
}

/** Remove a planted alert. See plantIncidentAlert() for why this must run. */
export async function deleteIncidentAlert(id: string): Promise<void> {
  await sql(`delete from public.incident_alerts where id = $1`, [id]);
}

// ===========================================================================
// PHASE 7 TASK 6: IN-APP FEEDBACK
// ===========================================================================

export interface FeedbackRowRead {
  id: string;
  userId: string;
  userEmail: string | null;
  organisationId: string | null;
  organisationRole: string | null;
  route: string;
  category: string;
  status: string;
  screenshotScanStatus: string | null;
  notifiedAt: string | null;
  /** Q121's label, stamped by the trigger from the caller's own session --
   *  read here so the impersonation walk can prove the app EARNED it rather
   *  than a fixture planting it. */
  duringSupportAccess: boolean;
}

/**
 * The row the submit dialog wrote, read STRAIGHT OUT OF POSTGRES. No client
 * role can read `feedback` except the aal2 superuser, and asserting what the
 * trigger stamped (user, email, role, route) through the UI that displays it
 * proves less than reading the table.
 */
export async function feedbackRowByMessage(message: string): Promise<FeedbackRowRead | null> {
  const result = await db().query<{
    id: string; user_id: string; user_email: string | null; organisation_id: string | null;
    organisation_role: string | null; route: string; category: string; status: string;
    screenshot_scan_status: string | null; notified_at: string | null;
    during_support_access: boolean;
  }>(
    `select id, user_id, user_email, organisation_id, organisation_role, route, category, status,
            screenshot_scan_status, notified_at, during_support_access
       from public.feedback where message = $1 order by created_at desc limit 1`,
    [message],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    organisationId: row.organisation_id,
    organisationRole: row.organisation_role,
    route: row.route,
    category: row.category,
    status: row.status,
    screenshotScanStatus: row.screenshot_scan_status,
    notifiedAt: row.notified_at,
    duringSupportAccess: row.during_support_access,
  };
}

/** Audit rows of one action naming one feedback row. `feedback.screenshot_viewed`
 *  is the one the brief cares about: it must be exactly the number of times
 *  the real link was followed. */
export async function countFeedbackAudit(action: string, feedbackId: string): Promise<number> {
  const result = await db().query<{ count: string }>(
    `select count(*)::text as count from public.audit_events
      where target_type = 'feedback' and action = $1 and target_id = $2`,
    [action, feedbackId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * Plant a feedback row as `postgres` (the trigger passes a sessionless writer
 * through, so user/role are supplied here) -- for the scans that need the
 * list POPULATED without walking the dialog again.
 */
export async function plantFeedback(
  userId: string,
  organisationId: string | null,
  organisationRole: string | null,
  message: string,
  /** Q121: the "Sent during support access" label. Planted here rather than
   *  earned through a real impersonation session, because what this fixture
   *  feeds is a RENDER test -- that the operator's list shows the label
   *  instead of "Not inside a workspace". That the label can only be EARNED by
   *  a live impersonating superuser, and cannot be forged by a member, is
   *  supabase/tests/rls_phase7_feedback.sql § FX's job and is proved there
   *  from a real session's claims. */
  duringSupportAccess = false,
  /** The route the submitter was on. Defaults to the planted marker. */
  route = "/planted",
): Promise<string> {
  const result = await db().query<{ id: string }>(
    `insert into public.feedback (user_id, user_email, organisation_id, organisation_role, category, message, route, during_support_access)
     select $1, u.email, $2, $3, 'other', $4, $5, $6 from auth.users u where u.id = $1
     returning id`,
    [userId, organisationId, organisationRole, message, route, duringSupportAccess],
  );
  return result.rows[0].id;
}

/**
 * Spend a user's whole hourly feedback budget in one write, so the NEXT real
 * submission through the dialog is the refused one. The window arithmetic is
 * the database's own (private.rate_limit_window_start), so the row lands in
 * the bin the trigger will read.
 */
export async function fillFeedbackBudget(userId: string): Promise<void> {
  await sql(
    `insert into public.rate_limit_counters (category, subject_scope, subject_id, window_start, request_count)
     select 'feedback', 'user', $1,
            private.rate_limit_window_start(now(), p.window_seconds), p.max_requests
       from public.rate_limit_policies p where p.category = 'feedback'
     on conflict (category, subject_scope, subject_id, window_start)
       do update set request_count = excluded.request_count`,
    [userId],
  );
}

/** How many objects the feedback bucket holds -- read straight out of
 *  storage.objects, so the e2e can assert that a REFUSED submission with a
 *  screenshot attached wrote nothing (Task 6 fix round 1, I1: the upload used
 *  to run before the metered insert). */
export async function countFeedbackScreenshotObjects(): Promise<number> {
  const result = await db().query<{ count: string }>(
    `select count(*)::text as count from storage.objects where bucket_id = 'feedback-screenshots'`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** Everything this feature writes for a set of users: rows, counters, the
 *  crossing alerts, and their audit rows (which would otherwise block the
 *  users' hard delete, the Task 1 teardown rule). */
export async function clearFeedbackState(userIds: string[]): Promise<void> {
  await sql(
    `delete from public.incident_alerts
      where details->>'category' = 'feedback' and details->>'subject_id' = any($1::text[])`,
    [userIds],
  );
  await sql(`delete from public.audit_events where target_type = 'feedback'`);
  await sql(`delete from public.feedback where user_id = any($1::uuid[])`, [userIds]);
  await sql(
    `delete from public.rate_limit_counters where category = 'feedback' and subject_id = any($1::uuid[])`,
    [userIds],
  );
}

/** See expireBillingOverride() -- the feature-override twin, same fix. */
export async function expireFeatureOverride(
  organisationId: string,
  flagKey: string,
): Promise<void> {
  await sql(
    `update public.organisation_feature_overrides
        set starts_at  = now() - interval '2 hours',
            expires_at = now() - interval '1 minute'
      where organisation_id = $1 and flag_key = $2 and revoked_at is null`,
    [organisationId, flagKey],
  );
}

/**
 * PHASE 7 TASK 3. The organisation-lifecycle audit trail, read STRAIGHT OUT OF
 * POSTGRES as `postgres` -- same reasoning as the impersonation reader below:
 * nobody can read audit_events through the app except the platform superuser,
 * and asserting a trail through the very policy a bug in it could be hiding
 * behind proves less than reading the table.
 *
 * Returns `action` and the operator's reason, in order. The reason is the half
 * that cannot be checked anywhere else: CLAUDE.md § Superuser dashboard makes
 * it mandatory, and "mandatory" is only true if what the operator typed in the
 * browser is what landed on the record.
 */
export async function organisationLifecycleAudit(
  organisationId: string,
): Promise<{ action: string; reason: string | null }[]> {
  const result = await db().query<{ action: string; reason: string | null }>(
    `select action, after->>'reason' as reason
       from public.audit_events
      where organisation_id = $1
        and action in ('organisation.suspended','organisation.deleted','organisation.reinstated')
      order by created_at, id`,
    [organisationId],
  );
  return result.rows.map((r) => ({ action: r.action, reason: r.reason }));
}

/**
 * PHASE 7 TASK 2. The impersonation audit trail for one organisation, read
 * STRAIGHT OUT OF POSTGRES as `postgres`.
 *
 * Same shape and same reasoning as `countAuditLogViewedRows` above: bypassing
 * RLS on purpose, so what the spec asserts about the trail is not read back
 * through the very audit_events policy a bug in it could be hiding behind --
 * and, more to the point here, because NOBODY can read this through the app.
 * audit_events is superuser-only, and the impersonating superuser is in the
 * middle of the session being audited.
 *
 * Returns the action strings in order. The e2e assertion that matters is
 * COMPLETENESS -- request, accept, start, at least one page_viewed, end --
 * because the browser walk is the only place a MISSED page access can be
 * observed at all: the psql suite calls the audit RPC directly and therefore
 * proves the RPC works, not that the app reaches it on every page.
 */
export async function impersonationAuditActions(
  organisationId: string,
): Promise<string[]> {
  const result = await db().query<{ action: string }>(
    `select action from public.audit_events
      where organisation_id = $1 and target_type = 'impersonation_session'
      order by created_at, id`,
    [organisationId],
  );
  return result.rows.map((r) => r.action);
}

/**
 * PHASE 7 TASK 2. Every DISTINCT route recorded against this organisation's
 * impersonation page views, in order of first appearance.
 *
 * The spec uses it to prove two things at once: that the routes the browser
 * actually visited are all there, and that nothing beyond a route string
 * reached the audit -- `after` is asserted to have the single key `route` by
 * the psql suite (§ IA6); this reads the values so the browser walk can say
 * WHICH pages it recorded.
 */
export async function impersonationAuditedRoutes(
  organisationId: string,
): Promise<string[]> {
  const result = await db().query<{ route: string }>(
    `select distinct on (after->>'route') after->>'route' as route
       from public.audit_events
      where organisation_id = $1 and action = 'impersonation.page_viewed'
      order by after->>'route'`,
    [organisationId],
  );
  return result.rows.map((r) => r.route);
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
  // The workspace's NAME, not only its slug: since Phase 8 Task 3's fix round
  // the DSR routing form makes the operator confirm a workspace by name
  // before it writes, and the requester is told which business was asked.
  const orgName = `E2E ${suffix}`;
  const otherOrgSlug = `e2e-other-${suffix}`;

  const users: Record<E2eRole, E2eUser> = {
    manager: await createUser(`e2e-manager-${suffix}@test.local`),
    standard_user: await createUser(`e2e-std-${suffix}@test.local`),
    read_only: await createUser(`e2e-ro-${suffix}@test.local`),
    // ---- PHASE 5 TASK 5 ---------------------------------------------------
    // The finance user is a member of BOTH finance organisations (Pro and
    // Starter), which is not a convenience: multi-org membership is an MVP
    // feature (CLAUDE.md § Tenancy model), and one person holding the same
    // role in a Pro and a Starter workspace is the cleanest way to show the
    // tier -- not the role -- is what refuses the Starter write.
    finance: await createUser(`e2e-finance-${suffix}@test.local`),
    booker: await createUser(`e2e-booker-${suffix}@test.local`),
    // ---- PHASE 7 TASK 7 ---------------------------------------------------
    // Members of `orgId`, like manager/standard_user/read_only, so an
    // Owner/Admin-only surface is rendered in the workspace this suite
    // actually fills with records. Their TOTP factors are enrolled below,
    // beside `financeTotpSecret`, and must exist before any browser signs in
    // as them or the app renders the ENROL gate instead of the CHALLENGE gate.
    //
    // DELIBERATELY SEPARATE FROM `orgAdmin`, which is also an admin of
    // `orgId`. `orgAdmin` is the impersonation consent-giver, driven in its
    // own browser context alongside a superuser context in
    // impersonation.spec.ts; pointing the role-addressed `admin` persona at
    // the same account would put two concurrently-driven contexts on one
    // auth user and make an unrelated spec's failure look like this one's.
    // Two admins of one workspace perturbs nothing else -- no spec in this
    // directory reads /[orgSlug]/members or counts memberships (grepped).
    owner: await createUser(`e2e-owner-${suffix}@test.local`),
    admin: await createUser(`e2e-admin-${suffix}@test.local`),
  };
  // The other tenant's owner. Never signed in as -- they exist so the second
  // organisation has a member, which is what makes its rows real rather than
  // orphaned.
  const otherOwner = await createUser(`e2e-otherowner-${suffix}@test.local`);
  // PHASE 6 TASK 5. A real, signed-in-as member of the counterparty tenant --
  // see the `otherMember` field's own header for why an owner could not do
  // this job.
  const otherMember = await createUser(`e2e-othermember-${suffix}@test.local`);

  await sql(
    `insert into public.organisations (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
    [orgId, orgName, orgSlug, otherOrgId, `E2E Other ${suffix}`, otherOrgSlug],
  );

  // A REAL Starter subscription row for both, WHERE THIS USED TO SAY "NO ROW
  // ON PURPOSE". PHASE 7 TASK A (20260908000000) removed private.crm_write_
  // organisations()'s "no subscription row = not yet billed, not yet gated"
  // escape: public.create_organisation() now writes a Starter row for every
  // new organisation at birth, and every real workspace has one from the
  // moment it exists. These two organisations are planted by a direct SQL
  // insert rather than through create_organisation() (see this file's header
  // for why), so they need the same row created explicitly, or the golden
  // path's own CRM writes -- create contact, create event, add artist, add
  // venue, add task -- would now be refused before a single browser action
  // ran. Starter, not Pro: nothing walked against these two organisations
  // needs the finance module (that lives in proOrg/starterOrg below) or an
  // unlimited custom-field count.
  await sql(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
     values ($1,'starter','monthly',3,'active', now() + interval '30 days'),
            ($2,'starter','monthly',3,'active', now() + interval '30 days')`,
    [orgId, otherOrgId],
  );

  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'manager','active',now()),
            ($1,$3,'standard_user','active',now()),
            ($1,$4,'read_only','active',now()),
            ($5,$6,'owner','active',now()),
            ($5,$7,'manager','active',now()),
            ($1,$8,'owner','active',now()),
            ($1,$9,'admin','active',now())`,
    [
      orgId,
      users.manager.id,
      users.standard_user.id,
      users.read_only.id,
      otherOrgId,
      otherOwner.id,
      otherMember.id,
      // PHASE 7 TASK 7. The first Owner and the first role-addressed Admin of
      // `orgId` this suite has ever had -- see the `owner`/`admin` arms of
      // E2eRole for what could not be measured without them.
      users.owner.id,
      users.admin.id,
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
      // manager-owned venue refuses the standard user and the "their venue
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

  // =========================================================================
  // PHASE 5 TASK 5'S FINANCE WORLD
  // =========================================================================
  // TWO ORGANISATIONS THAT EXIST FOR THEIR SUBSCRIPTION ROWS.
  //
  // The main organisation above now carries a real STARTER row (Phase 7 Task
  // A), whose finance_module is false -- so a finance write there is refused
  // by the TIER. That is a REAL FLIP from before Task A, not the same outcome:
  // the main org previously had NO subscription row, and private.finance_
  // module_organisations()'s "not yet billed => not yet gated" escape (still
  // untouched by Task A -- see this file's earlier finance-organisations
  // comment for why) ALLOWED finance writes there, not refused them. Either
  // way it is still not what this section is testing. These two carry real
  // rows -- 'pro' and 'starter',
  // both `active` with a period end in the future, so neither is inside the
  // past_due grace branch -- which makes the Pro gate's OPEN and CLOSED states
  // both reachable from a browser for the first time.
  const proOrgId = randomUUID();
  const starterOrgId = randomUUID();
  const proOrgSlug = `e2e-pro-${suffix}`;
  const starterOrgSlug = `e2e-starter-${suffix}`;

  await sql(
    `insert into public.organisations (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
    [
      proOrgId,
      `E2E Pro ${suffix}`,
      proOrgSlug,
      starterOrgId,
      `E2E Starter ${suffix}`,
      starterOrgSlug,
    ],
  );

  await sql(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status,
        current_period_end)
     values ($1,'pro','monthly',3,'active', now() + interval '30 days'),
            ($2,'starter','monthly',3,'active', now() + interval '30 days')`,
    [proOrgId, starterOrgId],
  );

  // THE FINANCE USER IS IN BOTH; THE BOOKER IS IN THE PRO ONE ONLY.
  // The booker's workspace is the one with a populated ledger, which is what
  // makes "no finance panel" a statement about the render gate rather than
  // about an empty workspace.
  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'finance','active',now()),
            ($1,$3,'booker','active',now()),
            ($4,$2,'finance','active',now())`,
    [proOrgId, users.finance.id, users.booker.id, starterOrgId],
  );

  // The factor, enrolled ONCE per run. Must exist before any browser signs in
  // as this user, or the app renders the ENROL gate instead of the CHALLENGE
  // gate `signIn` walks.
  const financeTotpSecret = await enrolTotp(users.finance.email);

  // PHASE 7 TASK 7. Same reason, same shape, for the two MFA-required roles
  // this suite gained. A stubbed challenge would leave both at aal1, and
  // `has_permission()` refuses an owner/admin membership at aal1
  // (20260827210000) -- so their exclusive keys would be held NOT AT ALL and
  // every Owner/Admin assertion would pass or fail for the MFA reason.
  const ownerTotpSecret = await enrolTotp(users.owner.email);
  const adminTotpSecret = await enrolTotp(users.admin.email);

  // =========================================================================
  // PHASE 7 TASK 1: THE PLATFORM SUPERUSER
  // =========================================================================
  // A throwaway auth user, granted `platform_admins` DIRECTLY BY SQL --
  // exactly the shape `supabase/migrations/20260827210500_seed_platform_
  // superuser.sql`'s own header says granting one requires ("no client path
  // exists at all... done the same way [as a DBA action]"), and the same
  // route `tests/integration/rls/support/fixtures.ts`'s `superuser` persona
  // uses. Enrolled with a real, verified TOTP factor for the same reason
  // `financeTotpSecret` is: the platform superuser is MFA-required
  // (CLAUDE.md § Session security), and a stubbed challenge would prove
  // nothing about the aal2 gate `has_platform_permission()` actually
  // enforces on every cross-tenant read this account makes.
  const superuser = await createUser(`e2e-superuser-${suffix}@test.local`);
  await sql(`insert into public.platform_admins (user_id) values ($1)`, [
    superuser.id,
  ]);
  const superuserTotpSecret = await enrolTotp(superuser.email);

  // PHASE 7 TASK 2. The Admin of `orgId` who accepts (or declines) an
  // impersonation request -- see the `orgAdmin` field's own header for why
  // `users` could not supply one and why this account has to hold a real
  // TOTP factor.
  const orgAdmin = await createUser(`e2e-orgadmin-${suffix}@test.local`);
  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'admin','active',now())`,
    [orgId, orgAdmin.id],
  );
  const orgAdminTotpSecret = await enrolTotp(orgAdmin.email);

  // TWO DETERMINISTIC audit_events ROWS, ONE PER TENANT -- see the
  // `auditProbeAlphaId`/`auditProbeBetaId` fields' own header on E2eWorld
  // for why these are planted rather than relied on to occur naturally.
  // `postgres`-inserted directly, the same route every other planted
  // fixture row in this file uses; audit_events has no INSERT grant for any
  // client role (private.log_audit_event is the sole write path and is
  // granted to nobody).
  const auditProbeAlphaId = randomUUID();
  const auditProbeBetaId = randomUUID();
  await sql(
    `insert into public.audit_events
       (id, organisation_id, actor_user_id, action, target_type, target_id, correlation_id, created_at)
     values
       ($1, $2, $3, 'e2e.audit_probe_alpha', 'probe', gen_random_uuid(), gen_random_uuid(), now()),
       ($4, $5, $6, 'e2e.audit_probe_beta',  'probe', gen_random_uuid(), gen_random_uuid(), now())`,
    [
      auditProbeAlphaId,
      orgId,
      users.manager.id,
      auditProbeBetaId,
      otherOrgId,
      otherOwner.id,
    ],
  );

  const proEventId = randomUUID();
  const proLedgerEventId = randomUUID();
  const starterEventId = randomUUID();
  const proArtistId = randomUUID();
  const proSupplierContactId = randomUUID();

  // NO VENUE ON ANY OF THE THREE. `events.venue_id` is nullable by design
  // (CLAUDE.md § Architecture) and these events exist for their finance panel;
  // giving them venues would add rows to surfaces other tests count.
  await sql(
    `insert into public.events
       (id, organisation_id, owner_user_id, name, starts_at, status)
     values ($1,$2,$3,$4, now() + interval '20 days','confirmed'),
            ($5,$2,$3,$6, now() + interval '25 days','confirmed'),
            ($7,$8,$3,$9, now() + interval '28 days','confirmed')`,
    [
      proEventId,
      proOrgId,
      users.finance.id,
      FINANCE_EVENT_NAMES.goldenPath,
      proLedgerEventId,
      FINANCE_EVENT_NAMES.proLedger,
      starterEventId,
      starterOrgId,
      FINANCE_EVENT_NAMES.starter,
    ],
  );

  await sql(
    `insert into public.artists (id, organisation_id, owner_user_id, name)
     values ($1,$2,$3,$4)`,
    [proArtistId, proOrgId, users.finance.id, PRO_ARTIST_NAME],
  );
  await sql(
    `insert into public.contacts (id, organisation_id, owner_user_id, name)
     values ($1,$2,$3,$4)`,
    [proSupplierContactId, proOrgId, users.finance.id, PRO_SUPPLIER_NAME],
  );

  // FIVE PLANTED LINES, AND EACH ONE IS ANSWERING A QUESTION.
  //
  //   fee      budgeted, on the LEDGER event -> the budgeted EXPENSE cell, and
  //            linked to an artist so `LinkedNames` renders
  //   income   actual,   on the LEDGER event -> the actual GROSS cell, linked
  //            to a supplier contact
  //   removed  SOFT-DELETED on the LEDGER event -> the "Removed from this
  //            list" disclosure, and NEITHER summary cell (the view filters
  //            `deleted_at is null`)
  //   starter  the Starter org's single line -> the Q67 payoff, read after a
  //            downgrade, and the denominator for "the refused write added
  //            nothing"
  //   other    the OTHER tenant's line, on the OTHER tenant's event -> the
  //            cross-tenant assertion's subject
  //
  // The GOLDEN-PATH event gets none: the walk writes its own two lines and
  // reads a summary that is therefore a statement about exactly those.
  //
  // WRITTEN AS `postgres`, like every other row here -- an INSERT policy needs
  // a session and this connection is not one (§ AND WHY SETUP IS `pg`). What
  // the tests ASSERT on still goes through a real browser, a real anon-key
  // session and, for the finance user, a real TOTP challenge.
  const proFeeEntryId = randomUUID();
  const proIncomeEntryId = randomUUID();
  const proRemovedEntryId = randomUUID();
  const starterEntryId = randomUUID();
  const otherOrgFinanceEntryId = randomUUID();

  await sql(
    `insert into public.financial_entries
       (id, organisation_id, event_id, category, status, amount_minor,
        occurred_on, description, artist_id, supplier_contact_id, deleted_at)
     values ($1,$2,$3,'fee','budgeted',$4, current_date - 3, $5, $6, null, null),
            ($7,$2,$3,'income','actual',$8, current_date - 2, $9, null, $10, null),
            ($11,$2,$3,'cost','budgeted',$12, current_date - 1, $13, null, null, now()),
            ($14,$15,$16,'fee','budgeted',$17, current_date - 4, $18, null, null, null),
            ($19,$20,$21,'income','actual',$22, current_date - 5, $23, null, null, null)`,
    [
      proFeeEntryId,
      proOrgId,
      proLedgerEventId,
      FINANCE_LINES.fixtureFee.amountMinor,
      FINANCE_LINES.fixtureFee.description,
      proArtistId,
      proIncomeEntryId,
      FINANCE_LINES.fixtureIncome.amountMinor,
      FINANCE_LINES.fixtureIncome.description,
      proSupplierContactId,
      proRemovedEntryId,
      FINANCE_LINES.removed.amountMinor,
      FINANCE_LINES.removed.description,
      starterEntryId,
      starterOrgId,
      starterEventId,
      FINANCE_LINES.starter.amountMinor,
      FINANCE_LINES.starter.description,
      otherOrgFinanceEntryId,
      otherOrgId,
      otherOrgEventId,
      FINANCE_LINES.otherTenant.amountMinor,
      FINANCE_LINES.otherTenant.description,
    ],
  );

  // =========================================================================
  // PHASE 6 TASK 3's OWN ROWS
  // =========================================================================
  const freeOrgId = randomUUID();
  const freeOrgSlug = `e2e-free-${suffix}`;
  const freeMember = await createUser(`e2e-freemember-${suffix}@test.local`);

  await sql(`insert into public.organisations (id, name, slug) values ($1,$2,$3)`, [
    freeOrgId,
    `E2E Free ${suffix}`,
    freeOrgSlug,
  ]);
  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'manager','active',now())`,
    [freeOrgId, freeMember.id],
  );
  await sql(
    `insert into public.organisation_subscriptions
       (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
     values ($1,'free','monthly',1,'active', now() + interval '30 days')`,
    [freeOrgId],
  );

  const networkAlphaProfileId = randomUUID();
  const networkDraftProfileId = randomUUID();
  const networkBetaAnchorProfileId = randomUUID();
  const networkHostileProfileId = randomUUID();

  // EVERY DISPLAY NAME CARRIES `${suffix}`. The network directory is
  // CROSS-TENANT BY DESIGN (Q86, this phase's own header) -- it is the one
  // list in the product with no per-run tenant boundary to keep two runs'
  // rows apart, so unlike a contact or company name (scoped to its own org
  // and therefore already isolated by `orgId`), a hardcoded network profile
  // name collides with any OTHER run's row of the same name, past or
  // concurrent, and breaks a `getByRole(... { name })` lookup with a "strict
  // mode violation: resolved to 2 elements" the moment two are ever alive at
  // once. Exposed on the returned world (below) so the spec never re-embeds
  // the literal string.
  const networkAlphaProfileName = `Network Discovery Alpha Ltd ${suffix}`;
  const networkDraftProfileName = `Network Discovery Alpha Draft ${suffix}`;
  const networkBetaAnchorProfileName = `Network Discovery Beta Anchor ${suffix}`;
  const networkHostileProfileName = `Hostile Network Venue ${suffix} <img src=x onerror="document.title='NETWORK-NAME-FIRED'">`;

  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, headline, city, contact_email, published_at)
     values ($1,$2,'company',gen_random_uuid(),'published',
             '{"headline":"network","city":"network","contact_email":"connections"}'::jsonb,
             $3,$4,$5,$6, now())`,
    [
      networkAlphaProfileId,
      orgId,
      networkAlphaProfileName,
      "Booking enquiries welcome",
      "Bristol",
      "alpha-connections@example.test",
    ],
  );
  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility, display_name)
     values ($1,$2,'venue',gen_random_uuid(),'draft','{}'::jsonb,$3)`,
    [networkDraftProfileId, orgId, networkDraftProfileName],
  );
  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, published_at)
     values ($1,$2,'company',gen_random_uuid(),'published','{}'::jsonb,$3, now())`,
    [networkBetaAnchorProfileId, proOrgId, networkBetaAnchorProfileName],
  );

  // THE VALUES A FORM WOULD REFUSE, WRITTEN PAST THE FORM -- the
  // `hostileContactId` pattern, applied to a network profile. `[P6]`
  // CLAUDE.md § Non-negotiable rules: "this is the phase where user content
  // becomes cross-tenant" -- a published `website_url` and a published `bio`
  // are written by one organisation and rendered in another's browser. Every
  // hostile field is `network`-visibility, so it needs no connection to
  // resolve for whoever views it.
  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, headline, bio, website_url, published_at)
     values ($1,$2,'venue',gen_random_uuid(),'published',
             '{"headline":"network","bio":"network","website_url":"network"}'::jsonb,
             $3,$4,$5,$6, now())`,
    [
      networkHostileProfileId,
      orgId,
      networkHostileProfileName,
      `<img src=x onerror="document.title='NETWORK-HEADLINE-FIRED'">`,
      `<script>document.title='NETWORK-BIO-FIRED'</script>`,
      `javascript:document.title='NETWORK-HREF-FIRED'`,
    ],
  );

  // THE ACCEPTED CONNECTION -- HAND-PLANTED (Task 4 does not exist yet). Q78's
  // NOT NULL pair needs a published profile on each side; `networkAlpha
  // ProfileId` and `networkBetaAnchorProfileId` are exactly the two this world
  // already has.
  const networkAcceptedRequestId = randomUUID();
  await sql(
    `insert into public.network_connection_requests
       (id, from_organisation_id, from_network_profile_id, to_organisation_id,
        to_network_profile_id, status, requested_at, responded_at)
     values ($1,$2,$3,$4,$5,'accepted', now(), now())`,
    [
      networkAcceptedRequestId,
      orgId,
      networkAlphaProfileId,
      proOrgId,
      networkBetaAnchorProfileId,
    ],
  );

  // =========================================================================
  // PHASE 6 TASK 4's OWN ROWS -- request-to-connect and Gap B
  // =========================================================================
  const networkBetaVenueProfileId = randomUUID();
  const networkBetaVenueProfileName = `Network Discovery Beta Venue ${suffix}`;
  const networkBetaDeclineProfileId = randomUUID();
  const networkBetaDeclineProfileName = `Network Discovery Beta Decline Target ${suffix}`;

  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, headline, contact_email, published_at)
     values ($1,$2,'venue',gen_random_uuid(),'published',
             '{"headline":"network","contact_email":"connections"}'::jsonb,
             $3,$4,$5, now())`,
    [
      networkBetaVenueProfileId,
      proOrgId,
      networkBetaVenueProfileName,
      "Live music every weekend",
      "beta-venue-connections@example.test",
    ],
  );
  await sql(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility, display_name, published_at)
     values ($1,$2,'company',gen_random_uuid(),'published','{}'::jsonb,$3, now())`,
    [networkBetaDeclineProfileId, proOrgId, networkBetaDeclineProfileName],
  );

  return {
    orgSlug,
    orgName,
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
    proOrgSlug,
    proOrgId,
    starterOrgSlug,
    starterOrgId,
    proEventId,
    proLedgerEventId,
    starterEventId,
    proArtistId,
    proSupplierContactId,
    proFeeEntryId,
    proIncomeEntryId,
    proRemovedEntryId,
    starterEntryId,
    otherOrgFinanceEntryId,
    financeTotpSecret,
    ownerTotpSecret,
    adminTotpSecret,
    superuser,
    superuserTotpSecret,
    orgAdmin,
    orgAdminTotpSecret,
    auditProbeAlphaId,
    auditProbeBetaId,
    users,
    otherOwner,
    otherMember,
    freeOrgSlug,
    freeOrgId,
    freeMember,
    networkAlphaProfileId,
    networkAlphaProfileName,
    networkDraftProfileId,
    networkDraftProfileName,
    networkBetaAnchorProfileId,
    networkBetaAnchorProfileName,
    networkAcceptedRequestId,
    networkHostileProfileId,
    networkHostileProfileName,
    networkBetaVenueProfileId,
    networkBetaVenueProfileName,
    networkBetaDeclineProfileId,
    networkBetaDeclineProfileName,
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
  // FIVE ORGANISATIONS SINCE PHASE 6 TASK 3 (`freeOrgId` joins the four from
  // Phase 5 Task 5). Deleting each cascades to every tenant row it owns --
  // `financial_entries.organisation_id` and `network_profiles.organisation_id`
  // alike carry `on delete cascade`, so the finance subscription rows and the
  // network profiles/connection request planted above go with their org.
  await sql(`delete from public.organisations where id = any($1::uuid[])`, [
    [world.orgId, world.otherOrgId, world.proOrgId, world.starterOrgId, world.freeOrgId],
  ]);

  // =========================================================================
  // PHASE 7 TASK 1: audit_events ROWS MUST GO BEFORE THE USERS THEY NAME
  // =========================================================================
  // `audit_events.actor_user_id` deliberately carries NO `ON DELETE
  // CASCADE`/`SET NULL` (20260826151656_foundation_schema.sql's own
  // comment: "audit records must survive an actor account being removed...
  // a hard delete of auth.users is blocked while audit history references
  // it"). Organisation deletion above only SETS NULL on `organisation_id`
  // -- the actor reference survives it -- so by this point every row this
  // run's users ever wrote into audit_events (the two planted probes,
  // AND anything a real action incidentally audited: a document
  // upload/download/delete, a network profile publish, a merge) still
  // names a `users`/`otherOwner`/`otherMember`/`freeMember`/`superuser` id
  // this function is about to hard-delete via the Admin API. Left in
  // place, that DELETE would fail at the database with a foreign-key
  // violation -- silently, because the loop below never checks the Admin
  // API's response -- and the auth user would leak forever. `postgres`
  // (this file's `sql()`) can delete rows from a table with zero client
  // GRANTs the same way it can insert into one; this is the teardown half
  // of the same bypass `setUpWorld` uses to plant them.
  const thisRunsUserIds = [
    ...Object.values(world.users).map((u) => u.id),
    world.otherOwner.id,
    world.freeMember.id,
    world.otherMember.id,
    world.superuser.id,
    // PHASE 7 TASK 2. This account ACCEPTS an impersonation request, and
    // public.accept_impersonation_request() audits that acceptance with the
    // accepting admin as actor_user_id -- so it acquires audit rows that
    // block its own hard delete exactly like every id above it.
    world.orgAdmin.id,
  ];
  await sql(`delete from public.audit_events where actor_user_id = any($1::uuid[])`, [
    thisRunsUserIds,
  ]);

  // THE OTHER TENANT'S OWNER IS DELETED BY ID, LIKE EVERY OTHER USER
  // (Task 8; the deferred minor this closes).
  //
  // It used to be found by LISTING UP TO 1000 auth users and matching an email
  // this function re-derived from the slug. That was wrong twice over. It was
  // a lookup for an id `setUpWorld` already held and simply did not return --
  // and on a stack whose `auth.users` has grown past a thousand rows, the
  // owner would not be on the first page, the `if` would never match, and
  // teardown would leak one auth user per run in silence. `world.otherOwner`
  // is the id, so there is nothing left to search for. `world.freeMember`
  // (Task 3) and `world.otherMember` (Task 5) are the same shape: standalone
  // users, not fixed `E2eRole` personas.
  //
  // THE COUNTS IN THIS PARAGRAPH ARE RE-COUNTED, NOT COPIED. It used to say
  // "this suite creates four per run and the psql suite creates twelve", and
  // both numbers had gone stale: `setUpWorld` creates TWELVE (SEVEN `E2eRole`
  // personas since Phase 7 Task 7 added `owner` and `admin`, `otherOwner`,
  // `freeMember`, `otherMember`, the platform `superuser` from Phase 7 Task 1,
  // and `orgAdmin` from Phase 7 Task 2 -- and the two new personas need no
  // line of their own here or in the loop below, because both are inside
  // `Object.values(world.users)`) and
  // `supabase/tests/run-rls-tests.sh` creates NINETEEN (five in its opening
  // loop, twelve for the Phase 2 suite, and two counterparties for the Phase 6
  // network-leakage suite). The thousand-row argument is unchanged and is why
  // the numbers are worth keeping right rather than dropping.
  for (const user of [
    ...Object.values(world.users),
    world.otherOwner,
    world.freeMember,
    world.otherMember,
    world.superuser,
    world.orgAdmin,
  ]) {
    await api(`/auth/v1/admin/users/${user.id}`, {
      key: serviceRoleKey,
      method: "DELETE",
    });
  }
  await closeDb();
}

// ===========================================================================
// PHASE 8 TASK 1: THE LEGAL DOCUMENT STORE
// ===========================================================================
// The e2e walk drafts, publishes and reviews a real version of one legal
// document. The immutability guard (20260922000000) refuses the undo for
// every role, by design, so restoring the seed is done with triggers off --
// `session_replication_role = replica`, set LOCAL inside one transaction on one
// pooled connection so it cannot leak to another query.

export interface LegalDocumentRow {
  id: string;
  version: number;
  status: string;
  body: string;
  counsel_reviewed_at: string | null;
  counsel_reviewer: string | null;
}

/** Every version of one document, oldest first, read as `postgres`. */
export async function legalDocumentVersions(slug: string): Promise<LegalDocumentRow[]> {
  const result = await db().query<LegalDocumentRow>(
    `select id, version, status, body, counsel_reviewed_at, counsel_reviewer
       from public.legal_documents where slug = $1 order by version`,
    [slug],
  );
  return result.rows;
}

/** The legal audit actions one actor wrote, with their `after` payloads. */
export async function legalAuditRows(
  actorUserId: string,
): Promise<{ action: string; after: string }[]> {
  const result = await db().query<{ action: string; after: string }>(
    `select action, coalesce(after::text, '') as after from public.audit_events
      where target_type = 'legal_document' and actor_user_id = $1
      order by created_at`,
    [actorUserId],
  );
  return result.rows;
}

/**
 * Put one document back to its seeded version 1: delete every later version
 * and every legal audit row this actor wrote, and republish version 1 as it
 * was (unreviewed). Idempotent, so an afterAll can call it unconditionally.
 */
export async function restoreLegalDocumentSeed(slug: string, actorUserId: string): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `delete from public.audit_events where target_type = 'legal_document' and actor_user_id = $1`,
      [actorUserId],
    );
    await client.query(`delete from public.legal_documents where slug = $1 and version > 1`, [slug]);
    await client.query(
      `update public.legal_documents
          set status = 'published', superseded_at = null,
              counsel_reviewed_at = null, counsel_reviewer = null, counsel_review_recorded_by = null
        where slug = $1 and version = 1`,
      [slug],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================
// PHASE 8 TASK 2: THE CONSENT LEDGER
// ===========================================================================
// Read straight out of Postgres as `postgres`, so "the history shows both
// events" is measured in the table rather than through the page that renders
// it. The ledger is append-only for every role (20260923000000), so clearing
// it runs with triggers off, set LOCAL on one pooled connection.

export interface ConsentRowRead {
  action: string;
  policy_slug: string;
  policy_version: number;
  mechanism: string;
  statement: string | null;
  has_granted_at: boolean;
  has_withdrawn_at: boolean;
  withdraws_previous: boolean;
}

/** One person's consent events, oldest first. */
export async function consentEvents(userId: string): Promise<ConsentRowRead[]> {
  const result = await db().query<ConsentRowRead>(
    `select c.action, c.policy_slug, c.policy_version, c.mechanism,
            c.technical_context->>'statement' as statement,
            c.granted_at is not null as has_granted_at,
            c.withdrawn_at is not null as has_withdrawn_at,
            (c.withdraws_id is not null and c.withdraws_id = lag(c.id) over (order by c.seq)) as withdraws_previous
       from public.consents c where c.user_id = $1 order by c.seq`,
    [userId],
  );
  return result.rows;
}

/** The audit actions one person's consent events wrote, oldest first. */
export async function consentAuditActions(userId: string): Promise<string[]> {
  const result = await db().query<{ action: string }>(
    `select action from public.audit_events
      where target_type = 'consent' and actor_user_id = $1 order by created_at, id`,
    [userId],
  );
  return result.rows.map((r) => r.action);
}

/** The current published version of the marketing preferences page. */
export async function marketingPolicyVersion(): Promise<number> {
  const result = await db().query<{ version: number }>(
    `select version from public.legal_documents where slug = 'marketing-preferences' and status = 'published'`,
  );
  return result.rows[0].version;
}

/** Remove these people's consent events, audit rows and grant counters. */
// ---------------------------------------------------------------------------
// Phase 8 Task 3: data subject requests.
// ---------------------------------------------------------------------------

export interface DsrRowRead {
  id: string;
  right_type: string;
  subject_scope: string;
  status: string;
  detail: string;
  rejection_reason: string | null;
  routed_to_organisation_id: string | null;
  routed_to_organisation_name: string | null;
  days_to_due: number;
}

/** One person's requests, oldest first, read straight out of Postgres. */
export async function dataSubjectRequests(userId: string): Promise<DsrRowRead[]> {
  const result = await db().query<DsrRowRead>(
    `select d.id, d.right_type, d.subject_scope, d.status, d.detail, d.rejection_reason,
            d.routed_to_organisation_id, d.routed_to_organisation_name,
            round(extract(epoch from (d.due_by - d.requested_at)) / 86400)::int as days_to_due
       from public.data_subject_requests d where d.user_id = $1 order by d.seq`,
    [userId],
  );
  return result.rows;
}

/** The audit actions one person's requests produced, oldest first. */
export async function dsrAuditActions(userId: string): Promise<string[]> {
  const result = await db().query<{ action: string }>(
    `select a.action from public.audit_events a
       join public.data_subject_requests d on d.id = a.target_id
      where a.target_type = 'data_subject_request' and d.user_id = $1
      order by a.created_at, a.id`,
    [userId],
  );
  return result.rows.map((r) => r.action);
}

/** The operator notes on one request -- nothing in the app may show these to
 *  the requester, so the spec reads them here to prove they EXIST. */
export async function dsrNoteBodies(requestId: string): Promise<string[]> {
  const result = await db().query<{ body: string }>(
    `select body from public.data_subject_request_notes where request_id = $1 order by created_at`,
    [requestId],
  );
  return result.rows.map((r) => r.body);
}

/**
 * Backdate a request so it is overdue.
 *
 * The INSERT trigger forces `requested_at = now()` for every writer, which is
 * exactly what makes the 30-day deadline unforgeable -- and therefore also
 * what stops a fixture from making an old request the ordinary way. Disabling
 * the trigger as the table's owner is the deliberate DBA escape hatch the
 * migration's own header names; it is re-enabled in the same transaction, and
 * the caller asserts the request is overdue afterwards rather than assuming.
 */
export async function backdateDataSubjectRequest(requestId: string, days: number): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query(
      `alter table public.data_subject_requests disable trigger data_subject_requests_before_update`,
    );
    // The AFTER UPDATE audit trigger too: it would log a transition that is
    // not one, from a sessionless connection that log_audit_event refuses.
    await client.query(
      `alter table public.data_subject_requests disable trigger data_subject_requests_audit_transition`,
    );
    await client.query(
      `update public.data_subject_requests set requested_at = now() - make_interval(days => $2) where id = $1`,
      [requestId, days],
    );
    await client.query(
      `alter table public.data_subject_requests enable trigger data_subject_requests_before_update`,
    );
    await client.query(
      `alter table public.data_subject_requests enable trigger data_subject_requests_audit_transition`,
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Run the deadline-alert writer the cron job runs, and say how many it wrote. */
export async function raiseDsrDeadlineAlerts(): Promise<number> {
  const result = await db().query<{ n: number }>(
    `select private.raise_dsr_deadline_alerts() as n`,
  );
  return Number(result.rows[0].n);
}

export async function clearDataSubjectRequestState(userIds: string[]): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `delete from public.incident_alerts where details->>'request_id' in
         (select id::text from public.data_subject_requests where user_id = any($1::uuid[]))`,
      [userIds],
    );
    await client.query(
      `delete from public.audit_events where target_type = 'data_subject_request'
         and target_id in (select id from public.data_subject_requests where user_id = any($1::uuid[]))`,
      [userIds],
    );
    await client.query(
      `delete from public.data_subject_request_notes where request_id in
         (select id from public.data_subject_requests where user_id = any($1::uuid[]))`,
      [userIds],
    );
    await client.query(`delete from public.data_subject_requests where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  await sql(
    `delete from public.rate_limit_counters where category = 'data_subject_request' and subject_id = any($1::uuid[])`,
    [userIds],
  );
}

export async function clearConsentState(userIds: string[]): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `delete from public.audit_events where target_type = 'consent' and actor_user_id = any($1::uuid[])`,
      [userIds],
    );
    await client.query(`delete from public.consents where user_id = any($1::uuid[])`, [userIds]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  await sql(
    `delete from public.rate_limit_counters where category = 'consent_grant' and subject_id = any($1::uuid[])`,
    [userIds],
  );
}

// ===========================================================================
// PHASE 8 TASK 4 -- DATA EXPORTS
// ===========================================================================

export interface ExportJobRead {
  id: string;
  kind: string;
  organisation_id: string | null;
  status: string;
  storage_key: string | null;
  byte_size: string | null;
  row_count: string | null;
  failure_reason: string | null;
}

/** One person's export jobs, newest first, read straight out of Postgres. */
export async function exportJobsFor(userId: string): Promise<ExportJobRead[]> {
  const result = await db().query<ExportJobRead>(
    `select id, kind, organisation_id, status, storage_key, byte_size, row_count, failure_reason
       from public.export_jobs where requested_by = $1 order by seq desc`,
    [userId],
  );
  return result.rows;
}

/** How many downloads have been audited, for the "no audit row, no URL" check. */
export async function countExportDownloadAudit(jobId: string): Promise<number> {
  const result = await db().query<{ n: string }>(
    `select count(*)::text as n from public.audit_events
      where action = 'export_job.downloaded' and target_id = $1`,
    [jobId],
  );
  return Number(result.rows[0]?.n ?? "0");
}

/**
 * Age an archive past its read-time expiry.
 *
 * NEEDS THE UPDATE TRIGGER OUT OF THE WAY, and that is itself the evidence
 * that a finished job is immutable for every writer, postgres included
 * (private.export_jobs_before_update()). Disabling a trigger as the table's
 * owner is the deliberate DBA escape hatch; it is re-enabled in the same
 * statement batch.
 */
export async function expireExportArchive(jobId: string): Promise<void> {
  // Three statements, not one: a PARAMETERISED query may carry only a single
  // command, and the middle one has to be parameterised.
  await db().query(`alter table public.export_jobs disable trigger export_jobs_before_update`);
  try {
    await db().query(
      `update public.export_jobs set expires_at = now() - interval '1 day' where id = $1`,
      [jobId],
    );
  } finally {
    await db().query(`alter table public.export_jobs enable trigger export_jobs_before_update`);
  }
}

/** Remove every export job these people made, between specs. */
export async function clearExportState(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db().query(
    `delete from public.audit_events
      where action in ('export_job.requested','export_job.downloaded')
        and target_id in (select id from public.export_jobs where requested_by = any($1::uuid[]))`,
    [userIds],
  );
  await db().query(`delete from public.export_jobs where requested_by = any($1::uuid[])`, [userIds]);
  await db().query(
    `delete from public.rate_limit_counters where category in ('exports','account_export')`,
  );
}

// ===========================================================================
// PHASE 8 TASK 5 -- ERASURE.
// ===========================================================================
// A DISPOSABLE ACCOUNT, and the reason it is disposable rather than one of the
// world's: the spec's second test DELETES it. Erasing `world.users.manager`
// would leave every later assertion in that run reading a database the
// fixtures no longer describe, and tearDownWorld would be deleting an account
// that is already gone. So the account this suite destroys is one it made.

export async function createDisposableUser(label: string): Promise<E2eUser> {
  return createUser(`e2e-erase-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`);
}

/** Does this account still exist? The only fact the erasure e2e needs. */
export async function accountStillExists(userId: string): Promise<boolean> {
  const { rows } = await db().query<{ n: string }>(
    `select count(*)::text as n from auth.users where id = $1`,
    [userId],
  );
  return rows[0].n !== "0";
}

export interface ErasureJobRead {
  readonly id: string;
  readonly status: string;
  readonly failureReason: string | null;
}

/**
 * The erasure jobs for a subject.
 *
 * `subject_user_id` goes NULL by the foreign key when the erasure succeeds,
 * so this stops returning a completed job -- which is the register keeping
 * what happened and losing whose it was. A test that wants "did it finish"
 * asks accountStillExists() instead, and that asymmetry is the feature.
 */
export async function erasureJobsFor(userId: string): Promise<ErasureJobRead[]> {
  const { rows } = await db().query<{ id: string; status: string; failure_reason: string | null }>(
    `select id, status, failure_reason from public.erasure_jobs
      where subject_user_id = $1 order by requested_at desc`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, failureReason: r.failure_reason }));
}

/** How many erasure jobs exist at all -- the count a refusal must not move. */
export async function countErasureJobs(): Promise<number> {
  const { rows } = await db().query<{ n: string }>(
    `select count(*)::text as n from public.erasure_jobs`,
  );
  return Number(rows[0].n);
}

export async function clearErasureState(userIds: string[]): Promise<void> {
  await db().query(
    `delete from public.audit_events
      where action in ('erasure_job.requested','account.erased')`,
  );
  await db().query(`delete from public.erasure_jobs`);
  await db().query(`delete from public.rate_limit_counters where category = 'account_erasure'`);
  if (userIds.length > 0) {
    await db().query(`delete from auth.users where id = any($1::uuid[])`, [userIds]);
  }
}
