// Phase 6 (Network), Task 4: the three assertions the brief names by name,
// against a REAL local Supabase stack.
//
//   1. THE ACCEPT-UNLOCK ASSERTION -- "the most important test in the task".
//      Accept flips exactly the two views' resolution and NOTHING ELSE:
//      before/after, the connected caller's readable field set over the
//      counterparty's profile grows by exactly the count of fields the
//      publisher marked `connections` (denominator >= 1), and by ZERO rows of
//      any of the fourteen private tables CLAUDE.md names as unreachable by
//      construction -- each with a positive control that the OWNING org can
//      read it, so a "0 rows" result is a finding and not a vacuity.
//   2. createNetworkLinkAction against a DRAFT profile is refused; a
//      published one succeeds -- the positive control.
//   3. Q82: BETA cannot read ALPHA's network_links rows even after accepting
//      a connection between the two organisations; ALPHA reading its own is
//      the positive control.
//
// SAME MOCKING SHAPE AS tests/integration/network/publish-editor-flow.test.ts
// (Task 2): only the Next.js request-context seams (next/cache, @/lib/auth's
// getCurrentUser/getCurrentOrg, @/lib/supabase/server's createClient) are
// mocked, each resolving to a REAL signed-in supabase-js client. Every read
// and write below goes through the REAL RLS-scoped client over real HTTP to
// the local PostgREST instance -- `hasPermission`, `getOrganisationEntitlements`
// and every policy this task relies on are exercised for real, not mocked.
//
// FIXTURE SUBSCRIPTIONS: createFixtures() already gives org A 'pro' and org B
// 'starter' (its own step 7) -- both permit network_publish, so nothing here
// has to touch organisation_subscriptions.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

const current = vi.hoisted(() => ({
  userId: "",
  client: null as unknown,
  orgs: new Map<
    string,
    { id: string; name: string; slug: string; role: string; isSuspended: boolean }
  >(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: async () =>
      current.userId ? { id: current.userId, email: null, fullName: null } : null,
    getCurrentOrg: async (slug: string) => current.orgs.get(slug) ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

// Imported AFTER the mocks (vi.mock is hoisted above imports by vitest).
import {
  sendConnectionRequestAction,
  acceptConnectionRequestAction,
} from "@/lib/network/connections";
import { createNetworkLinkAction } from "@/lib/network/links";

let fx: RlsFixtures;
let pool: Pool;

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
}, 180_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

function registerOrg(slug: string, id: string, role: string, isSuspended = false) {
  current.orgs.set(slug, { id, name: slug, slug, role, isSuspended });
}
function actAs(persona: { userId: string; client: unknown }) {
  current.userId = persona.userId;
  current.client = persona.client;
}
function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
}

/**
 * THE EXPLICIT PROBE LIST -- verbatim from the brief. `activity_events` is a
 * VIEW with no rows of its own; it derives from the other thirteen, so
 * planting rows in them is what gives it something to (fail to) leak.
 */
const PROBE_TABLES = [
  "contacts",
  "companies",
  "artists",
  "venues",
  "agencies",
  "notes",
  "documents",
  "financial_entries",
  "events",
  "event_lineup",
  "tasks",
  "meetings",
  "custom_field_values",
  "activity_events",
] as const;

/**
 * Plant one row in each of the thirteen real tables of the probe list, for
 * one organisation -- as `postgres`, bypassing every policy and permission,
 * because setting up a KNOWN fixture row is not the thing under test. What is
 * under test is whether a FOREIGN caller can read any of them, which the
 * assertions below drive through the real RLS-scoped client.
 */
async function plantProbeRows(pool: Pool, orgId: string): Promise<void> {
  const contact = await pool.query<{ id: string }>(
    `insert into public.contacts (organisation_id, name) values ($1, 'Probe Contact') returning id`,
    [orgId],
  );
  await pool.query(`insert into public.companies (organisation_id, name) values ($1, 'Probe Company')`, [orgId]);
  const artist = await pool.query<{ id: string }>(
    `insert into public.artists (organisation_id, name) values ($1, 'Probe Artist') returning id`,
    [orgId],
  );
  await pool.query(`insert into public.venues (organisation_id, name) values ($1, 'Probe Venue')`, [orgId]);
  await pool.query(`insert into public.agencies (organisation_id, name) values ($1, 'Probe Agency')`, [orgId]);
  await pool.query(
    `insert into public.notes (organisation_id, body) values ($1, 'Probe note body')`,
    [orgId],
  );
  await pool.query(
    `insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes)
     values ($1, 'probe.pdf', $2, 'application/pdf', 1024)`,
    [orgId, `${orgId}/probe.pdf`],
  );
  const event = await pool.query<{ id: string }>(
    `insert into public.events (organisation_id, name, starts_at)
     values ($1, 'Probe Night', now() + interval '30 days') returning id`,
    [orgId],
  );
  await pool.query(
    `insert into public.event_lineup (organisation_id, event_id, artist_id) values ($1, $2, $3)`,
    [orgId, event.rows[0]!.id, artist.rows[0]!.id],
  );
  await pool.query(
    `insert into public.financial_entries (organisation_id, event_id, category, amount_minor)
     values ($1, $2, 'fee', 50000)`,
    [orgId, event.rows[0]!.id],
  );
  await pool.query(
    `insert into public.tasks (organisation_id, title) values ($1, 'Probe task')`,
    [orgId],
  );
  await pool.query(
    `insert into public.meetings (organisation_id, title, starts_at)
     values ($1, 'Probe meeting', now() + interval '7 days')`,
    [orgId],
  );
  const definition = await pool.query<{ id: string }>(
    `insert into public.custom_field_definitions (organisation_id, entity_type, key, label, field_type)
     values ($1, 'contact', 'probe_field', 'Probe field', 'text') returning id`,
    [orgId],
  );
  await pool.query(
    `insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
     values ($1, $2, 'contact', $3, '"probe value"'::jsonb)`,
    [orgId, definition.rows[0]!.id, contact.rows[0]!.id],
  );
}

/**
 * For each of the fourteen probe tables: `callerClient` reading rows scoped
 * to `ownerOrgId` must be EMPTY, and `ownerClient` reading the same must be
 * NON-EMPTY (the positive control -- Constraint 14, "every count assertion
 * needs a denominator").
 */
async function assertProbeBoundary(
  callerClient: RlsFixtures["ownerA"]["client"],
  ownerClient: RlsFixtures["ownerA"]["client"],
  ownerOrgId: string,
  when: string,
): Promise<void> {
  for (const table of PROBE_TABLES) {
    const asCaller = await callerClient
      .from(table)
      .select("id")
      .eq("organisation_id", ownerOrgId);
    expect(
      asCaller.error,
      `${when}: unexpected error reading ${table} as the caller: ${asCaller.error?.message}`,
    ).toBeNull();
    expect(asCaller.data ?? [], `${when}: caller must read ZERO rows of ${table}`).toHaveLength(0);

    const asOwner = await ownerClient
      .from(table)
      .select("id")
      .eq("organisation_id", ownerOrgId);
    expect(
      (asOwner.data ?? []).length,
      `${when}: DENOMINATOR -- the owning org must itself read at least one row of ${table}, or the caller's 0 is vacuous`,
    ).toBeGreaterThan(0);
  }
}

describe("THE ACCEPT-UNLOCK ASSERTION (the most important test in this task)", () => {
  let companyAId: string;
  let companyBId: string;
  let profileAId: string;
  let profileBId: string;
  let requestId: string;

  const PUBLISHABLE = [
    "headline",
    "bio",
    "city",
    "region",
    "country",
    "website_url",
    "contact_email",
  ] as const;

  beforeAll(async () => {
    await plantProbeRows(pool, fx.orgA.id);

    const compA = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Alpha Unlock Co') returning id`,
      [fx.orgA.id],
    );
    companyAId = compA.rows[0]!.id;
    const compB = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Beta Unlock Co') returning id`,
      [fx.orgB.id],
    );
    companyBId = compB.rows[0]!.id;

    // A's profile carries EXACTLY ONE `connections`-level field
    // (contact_email) and one `network`-level field (headline) -- a clean
    // denominator of 1 for the growth assertion below.
    registerOrg(fx.orgA.slug, fx.orgA.id, "owner");
    actAs(fx.ownerA);
    const sendFrom = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name,
          headline, contact_email, field_visibility, published_at)
       values ($1, 'company', $2, 'published', 'Alpha Unlock Co',
               'Booking enquiries', 'unlock@alpha.test',
               '{"headline":"network","contact_email":"connections"}'::jsonb, now())
       returning id`,
      [fx.orgA.id, companyAId],
    );
    profileAId = sendFrom.rows[0]!.id;

    // B's profile carries NO connections-level fields, so the growth this
    // test measures is unambiguously A's alone.
    const sendTo = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
       values ($1, 'company', $2, 'published', 'Beta Unlock Co', '{}'::jsonb, now())
       returning id`,
      [fx.orgB.id, companyBId],
    );
    profileBId = sendTo.rows[0]!.id;

    // THE REAL SERVER ACTION, not a raw insert -- A sends to B.
    const sent = await sendConnectionRequestAction(
      {},
      formData({ orgSlug: fx.orgA.slug, fromProfileId: profileAId, toProfileId: profileBId }),
    );
    expect(sent.error, sent.error).toBeUndefined();

    const { rows } = await pool.query<{ id: string }>(
      `select id from public.network_connection_requests
        where from_network_profile_id = $1 and to_network_profile_id = $2
          and status = 'pending'`,
      [profileAId, profileBId],
    );
    expect(rows.length, "exactly one pending request exists after sending").toBe(1);
    requestId = rows[0]!.id;
  }, 60_000);

  it("BEFORE: B cannot see A's connected profile at all, and B reads zero rows of every probe table", async () => {
    const connected = await fx.ownerB.client
      .from("network_connected_profiles")
      .select("id")
      .eq("id", profileAId);
    expect(connected.data ?? [], "unaccepted -- the connected view carries no row yet").toHaveLength(0);

    await assertProbeBoundary(fx.ownerB.client, fx.ownerA.client, fx.orgA.id, "BEFORE accept");
  });

  it("ACCEPT: B, the recipient, accepts through the REAL server action", async () => {
    registerOrg(fx.orgB.slug, fx.orgB.id, "owner");
    actAs(fx.ownerB);
    const accepted = await acceptConnectionRequestAction(
      {},
      formData({ orgSlug: fx.orgB.slug, requestId }),
    );
    expect(accepted.error, accepted.error).toBeUndefined();
    expect(accepted.message).toBeDefined();

    const { rows } = await pool.query<{ status: string }>(
      `select status from public.network_connection_requests where id = $1`,
      [requestId],
    );
    expect(rows[0]!.status).toBe("accepted");
  });

  it("AFTER: B's readable field set over A's profile grows by EXACTLY the connections-marked count (>= 1), and by nothing else", async () => {
    const directory = await fx.ownerB.client
      .from("network_directory")
      .select(PUBLISHABLE.join(","))
      .eq("id", profileAId)
      .single();
    expect(directory.error, directory.error?.message).toBeNull();

    const connected = await fx.ownerB.client
      .from("network_connected_profiles")
      .select(PUBLISHABLE.join(","))
      .eq("id", profileAId)
      .single();
    expect(connected.error, connected.error?.message).toBeNull();

    const nonNullCount = (row: Record<string, unknown>) =>
      PUBLISHABLE.filter((f) => row[f] !== null && row[f] !== undefined).length;

    const directoryRow = directory.data as unknown as Record<string, unknown>;
    const connectedRow = connected.data as unknown as Record<string, unknown>;
    const beforeSet = nonNullCount(directoryRow);
    const afterSet = nonNullCount(connectedRow);
    const grown = afterSet - beforeSet;

    // THE DENOMINATOR, ASSERTED AT LEAST 1 -- Constraint 14.
    expect(grown).toBeGreaterThanOrEqual(1);
    // EXACTLY the one field A marked `connections` (contact_email).
    expect(grown).toBe(1);
    expect(connectedRow.contact_email).toBe("unlock@alpha.test");
    // THE DIRECTORY VIEW IS UNCHANGED BY THE ACCEPT -- it never resolves a
    // connections-level field for anyone, connected or not.
    expect(directoryRow.contact_email).toBeNull();
  });

  it("AFTER: B still reads ZERO rows of any of the fourteen private tables, same positive control", async () => {
    await assertProbeBoundary(fx.ownerB.client, fx.ownerA.client, fx.orgA.id, "AFTER accept");
  });
});

describe("createNetworkLinkAction: a DRAFT profile is refused, a published one succeeds", () => {
  it("the positive control (published) and the refusal (draft), same statement shape", async () => {
    const linkingCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Linking Co') returning id`,
      [fx.orgA.id],
    );
    const linkingCompanyId = linkingCompany.rows[0]!.id;

    // TWO SEPARATE target companies -- one profile is PUBLISHED, the other is
    // a DRAFT, and network_profiles_entity_unique (organisation_id,
    // entity_kind, entity_id) permits only one LIVE profile per entity, so
    // the two profiles cannot share one entity_id.
    const publishedCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Link Target Co') returning id`,
      [fx.orgB.id],
    );
    const draftCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Draft Target Co') returning id`,
      [fx.orgB.id],
    );
    const publishedProfile = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
       values ($1, 'company', $2, 'published', 'Link Target Co', '{}'::jsonb, now())
       returning id`,
      [fx.orgB.id, publishedCompany.rows[0]!.id],
    );
    const draftProfile = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name, field_visibility)
       values ($1, 'company', $2, 'draft', 'Draft Target Co', '{}'::jsonb)
       returning id`,
      [fx.orgB.id, draftCompany.rows[0]!.id],
    );

    registerOrg(fx.orgA.slug, fx.orgA.id, "owner");
    actAs(fx.ownerA);

    const refused = await createNetworkLinkAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        networkProfileId: draftProfile.rows[0]!.id,
        privateEntityType: "company",
        privateEntityId: linkingCompanyId,
      }),
    );
    expect(refused.error, "linking to a DRAFT profile is refused").toBeDefined();

    const { rows: afterRefusal } = await pool.query(
      `select 1 from public.network_links
        where organisation_id = $1 and private_entity_id = $2 and network_profile_id = $3
          and deleted_at is null`,
      [fx.orgA.id, linkingCompanyId, draftProfile.rows[0]!.id],
    );
    expect(afterRefusal.length, "no link row was created for the draft attempt").toBe(0);

    const succeeded = await createNetworkLinkAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        networkProfileId: publishedProfile.rows[0]!.id,
        privateEntityType: "company",
        privateEntityId: linkingCompanyId,
      }),
    );
    expect(succeeded.error, succeeded.error).toBeUndefined();
    expect(succeeded.message, "POSITIVE CONTROL: the published profile links").toBeDefined();

    const { rows: afterSuccess } = await pool.query(
      `select 1 from public.network_links
        where organisation_id = $1 and private_entity_id = $2 and network_profile_id = $3
          and deleted_at is null`,
      [fx.orgA.id, linkingCompanyId, publishedProfile.rows[0]!.id],
    );
    expect(afterSuccess.length).toBe(1);
  });
});

describe("Q82: BETA cannot read ALPHA's network_links, even after the two organisations connect", () => {
  it("ALPHA reads its own link; BETA, the profile's owner, reads none of it -- before or after accepting", async () => {
    const linkingCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Q82 Linking Co') returning id`,
      [fx.orgA.id],
    );
    const targetCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Q82 Target Co') returning id`,
      [fx.orgB.id],
    );
    const targetProfile = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
       values ($1, 'company', $2, 'published', 'Q82 Target Co', '{}'::jsonb, now())
       returning id`,
      [fx.orgB.id, targetCompany.rows[0]!.id],
    );

    registerOrg(fx.orgA.slug, fx.orgA.id, "owner");
    actAs(fx.ownerA);
    const linked = await createNetworkLinkAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        networkProfileId: targetProfile.rows[0]!.id,
        privateEntityType: "company",
        privateEntityId: linkingCompany.rows[0]!.id,
      }),
    );
    expect(linked.error, linked.error).toBeUndefined();

    // BEFORE any connection between the two organisations at all: BETA
    // (the profile's owner) reads none of ALPHA's links.
    const beforeAsBeta = await fx.ownerB.client
      .from("network_links")
      .select("id")
      .eq("organisation_id", fx.orgA.id);
    expect(beforeAsBeta.data ?? [], "BEFORE: BETA reads zero of ALPHA's links").toHaveLength(0);

    const beforeAsAlpha = await fx.ownerA.client
      .from("network_links")
      .select("id")
      .eq("organisation_id", fx.orgA.id);
    expect(
      (beforeAsAlpha.data ?? []).length,
      "DENOMINATOR: ALPHA reads its own link",
    ).toBeGreaterThan(0);

    // Now connect the two organisations for real -- ALPHA needs its OWN
    // published profile to send from.
    const alphaCompany = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name) values ($1, 'Q82 Alpha Sender Co') returning id`,
      [fx.orgA.id],
    );
    const alphaProfile = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name, field_visibility, published_at)
       values ($1, 'company', $2, 'published', 'Q82 Alpha Sender Co', '{}'::jsonb, now())
       returning id`,
      [fx.orgA.id, alphaCompany.rows[0]!.id],
    );

    const sent = await sendConnectionRequestAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        fromProfileId: alphaProfile.rows[0]!.id,
        toProfileId: targetProfile.rows[0]!.id,
      }),
    );
    expect(sent.error, sent.error).toBeUndefined();

    const { rows: reqRows } = await pool.query<{ id: string }>(
      `select id from public.network_connection_requests
        where from_network_profile_id = $1 and to_network_profile_id = $2 and status = 'pending'`,
      [alphaProfile.rows[0]!.id, targetProfile.rows[0]!.id],
    );
    const requestId = reqRows[0]!.id;

    registerOrg(fx.orgB.slug, fx.orgB.id, "owner");
    actAs(fx.ownerB);
    const accepted = await acceptConnectionRequestAction(
      {},
      formData({ orgSlug: fx.orgB.slug, requestId }),
    );
    expect(accepted.error, accepted.error).toBeUndefined();

    // AFTER acceptance: the connection is real (network_connected_profiles
    // now resolves ALPHA's profile for BETA) -- and BETA STILL reads none of
    // ALPHA's network_links. Q82's leak this task owes.
    const connectedCheck = await fx.ownerB.client
      .from("network_connected_profiles")
      .select("id")
      .eq("id", alphaProfile.rows[0]!.id);
    expect(connectedCheck.data ?? [], "the two ARE connected now").toHaveLength(1);

    const afterAsBeta = await fx.ownerB.client
      .from("network_links")
      .select("id")
      .eq("organisation_id", fx.orgA.id);
    expect(
      afterAsBeta.data ?? [],
      "Q82 THE FINDING: BETA reads zero of ALPHA's links even after connecting",
    ).toHaveLength(0);

    const afterAsAlpha = await fx.ownerA.client
      .from("network_links")
      .select("id")
      .eq("organisation_id", fx.orgA.id);
    expect(
      (afterAsAlpha.data ?? []).length,
      "POSITIVE CONTROL: ALPHA still reads its own links",
    ).toBeGreaterThan(0);
  });
});
