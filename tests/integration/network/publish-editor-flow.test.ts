// Phase 6 (Network), Task 2: the publish-field editor's server actions,
// end to end, against a REAL local Supabase stack -- the four assertions the
// brief names by name:
//
//   1. N3.        setFieldVisibilityAction("hidden") leaves the base column
//                  NULL; the positive control is updateNetworkProfileAction
//                  storing a value when the level is "network".
//   2. FREE TIER.  publishNetworkProfileAction refuses on a Free-plan
//                  organisation AND the row's `status` is unchanged.
//   3. LEAKAGE.    a member of a SECOND tenant reading network_directory sees
//                  exactly the fields marked `network` and no column of the
//                  source `companies` row -- asserted column by column, with
//                  a denominator.
//   4. M4.         a marketing persona (manage_network_profile +
//                  manage_contacts, NOT manage_artists/manage_venues) is
//                  refused by the REAL DATABASE for an artist and permitted
//                  for a company -- the mirror-test half of
//                  tests/unit/network/access.test.ts's mocked prediction.
//
// ===========================================================================
// WHAT IS MOCKED, AND WHY IT DOES NOT WEAKEN THE TEST
// ===========================================================================
// Only the Next.js request-context seams -- next/cache, @/lib/auth
// (getCurrentUser/getCurrentOrg, which read cookies this process has none of)
// and @/lib/supabase/server (createClient -> a REAL supabase-js client signed
// in as the persona) -- exactly the shape
// tests/integration/documents/upload-scan-download.test.ts established. Every
// database read and write goes through the REAL RLS-scoped client over real
// HTTP to the local PostgREST instance.
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
  createNetworkProfileAction,
  updateNetworkProfileAction,
  setFieldVisibilityAction,
  publishNetworkProfileAction,
} from "@/lib/network/profiles";

let fx: RlsFixtures;
let pool: Pool;

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
}, 180_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

/** Register one org slug -> CurrentOrg shape, for the mocked getCurrentOrg. */
function registerOrg(
  slug: string,
  id: string,
  role: string,
  isSuspended = false,
) {
  current.orgs.set(slug, { id, name: slug, slug, role, isSuspended });
}

/** Act as one persona for the calls that follow. */
function actAs(persona: { userId: string; client: unknown }) {
  current.userId = persona.userId;
  current.client = persona.client;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
}

async function insertCompany(
  client: RlsFixtures["ownerA"]["client"],
  organisationId: string,
  name: string,
): Promise<string> {
  const { data, error } = await client
    .from("companies")
    .insert({ organisation_id: organisationId, name })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture: could not insert company: ${error?.message}`);
  return String(data.id);
}

async function insertArtist(
  client: RlsFixtures["ownerA"]["client"],
  organisationId: string,
  name: string,
): Promise<string> {
  const { data, error } = await client
    .from("artists")
    .insert({ organisation_id: organisationId, name })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture: could not insert artist: ${error?.message}`);
  return String(data.id);
}

describe("N3: setFieldVisibilityAction(hidden) nulls the base column; network stores it", () => {
  it("a positive control (network) stores the value, then hiding it NULLs the column", async () => {
    registerOrg(fx.orgA.slug, fx.orgA.id, "owner");
    actAs(fx.ownerA);

    const companyId = await insertCompany(fx.ownerA.client, fx.orgA.id, "N3 Probe Ltd");
    const created = await createNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        entityKind: "company",
        entityId: companyId,
        displayName: "N3 Probe Ltd",
      }),
    );
    expect(created.error, created.error).toBeUndefined();

    const { rows: createdRows } = await pool.query<{ id: string }>(
      `select id from public.network_profiles
        where organisation_id = $1 and entity_id = $2 and deleted_at is null`,
      [fx.orgA.id, companyId],
    );
    expect(createdRows.length, "exactly one draft profile exists").toBe(1);
    const profileId = createdRows[0]!.id;

    // POSITIVE CONTROL: the whole-form save, with `headline` at `network`,
    // stores the value -- proves the mask is a READ-time predicate over a
    // REAL stored value, not a column that is simply always empty.
    const updated = await updateNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        profileId,
        displayName: "N3 Probe Ltd",
        headline: "Booking enquiries welcome",
        visibility_headline: "network",
      }),
    );
    expect(updated.error, updated.error).toBeUndefined();

    const afterUpdate = await pool.query<{ headline: string | null }>(
      `select headline from public.network_profiles where id = $1`,
      [profileId],
    );
    expect(afterUpdate.rows[0]!.headline, "network stores the value").toBe(
      "Booking enquiries welcome",
    );

    // THE ASSERTION N3 IS FOR: hiding it, through setFieldVisibilityAction --
    // named in the brief -- nulls the column in the same statement.
    const hidden = await setFieldVisibilityAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        profileId,
        fieldName: "headline",
        level: "hidden",
      }),
    );
    expect(hidden.error, hidden.error).toBeUndefined();

    const afterHide = await pool.query<{
      headline: string | null;
      field_visibility: Record<string, string>;
    }>(
      `select headline, field_visibility from public.network_profiles where id = $1`,
      [profileId],
    );
    expect(afterHide.rows[0]!.headline, "hidden -> NULL, read back as postgres").toBeNull();
    expect(afterHide.rows[0]!.field_visibility.headline).toBe("hidden");
  });
});

describe("FREE TIER: publishNetworkProfileAction refuses, and the row's status does not move", () => {
  it("a refusal message with a mutated row is the failure this asserts against", async () => {
    registerOrg(fx.orgB.slug, fx.orgB.id, "owner");
    actAs(fx.ownerB);

    const companyId = await insertCompany(fx.ownerB.client, fx.orgB.id, "Free Tier Probe Ltd");
    const created = await createNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgB.slug,
        entityKind: "company",
        entityId: companyId,
        displayName: "Free Tier Probe Ltd",
      }),
    );
    expect(created.error, created.error).toBeUndefined();

    const { rows } = await pool.query<{ id: string; status: string }>(
      `select id, status from public.network_profiles
        where organisation_id = $1 and entity_id = $2 and deleted_at is null`,
      [fx.orgB.id, companyId],
    );
    const profileId = rows[0]!.id;
    expect(rows[0]!.status).toBe("draft");

    // NOW GATE THE ORGANISATION ONTO FREE, ACTIVE. The fixture already gave
    // org B a 'starter' subscription (createFixtures' step 7, so its owner's
    // MFA/aal2 path is exercised for real) -- so this is an UPDATE of that
    // row, not a fresh INSERT, or it collides with
    // organisation_subscriptions_organisation_id_key. plan_id='free',
    // status='active' is the one input that actually closes the "no
    // subscription row -> not yet billed -> not yet gated" escape every
    // fresh fixture organisation would otherwise benefit from -- the SAME
    // shape tests/integration/network/network-access-matches-db.test.ts's
    // bothSides() drives.
    const { rowCount } = await pool.query(
      `update public.organisation_subscriptions
          set plan_id = 'free', status = 'active',
              current_period_end = now() + interval '30 days'
        where organisation_id = $1`,
      [fx.orgB.id],
    );
    expect(rowCount, "org B's fixture subscription row exists to downgrade").toBe(1);

    const publish = await publishNetworkProfileAction(
      {},
      formData({ orgSlug: fx.orgB.slug, profileId }),
    );
    expect(publish.error, "Free tier refuses the publish").toBeDefined();
    expect(publish.message).toBeUndefined();

    const after = await pool.query<{ status: string; published_at: string | null }>(
      `select status, published_at from public.network_profiles where id = $1`,
      [profileId],
    );
    // THE ASSERTION THIS TEST IS FOR: a refusal message with a MUTATED row is
    // the failure this guards against. `status` is still 'draft'.
    expect(after.rows[0]!.status, "the row did not move").toBe("draft");
    expect(after.rows[0]!.published_at).toBeNull();
  });
});

describe("M4, at the database: marketing is refused for an artist and permitted for a company", () => {
  it("a RAW INSERT (bypassing the application entirely) proves the database, not just the app, refuses", async () => {
    registerOrg(fx.orgA.slug, fx.orgA.id, "marketing");
    const marketing = fx.activeByRole.marketing;

    const artistId = await insertArtist(fx.ownerA.client, fx.orgA.id, "M4 Probe Artist");

    // THE DEFECT'S PREMISE: marketing genuinely holds manage_network_profile.
    const { data: heldKeys } = await marketing.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_network_profile",
    });
    expect(heldKeys, "marketing holds manage_network_profile").toBe(true);
    const { data: holdsArtists } = await marketing.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_artists",
    });
    expect(holdsArtists, "marketing does NOT hold manage_artists").toBe(false);

    // THE RAW INSERT -- no application layer at all, straight over PostgREST
    // as the marketing persona's own session.
    const artistInsert = await marketing.client
      .from("network_profiles")
      .insert({
        organisation_id: fx.orgA.id,
        entity_kind: "artist",
        entity_id: artistId,
        display_name: "M4 Probe Artist",
      })
      .select("id");
    expect(artistInsert.error, "the database refuses the artist profile").not.toBeNull();
    expect(artistInsert.error?.code).toBe("42501");

    // POSITIVE CONTROL, same persona, same organisation, a KIND marketing CAN
    // manage (manage_contacts).
    const companyId = await insertCompany(fx.ownerA.client, fx.orgA.id, "M4 Probe Company");
    const companyInsert = await marketing.client
      .from("network_profiles")
      .insert({
        organisation_id: fx.orgA.id,
        entity_kind: "company",
        entity_id: companyId,
        display_name: "M4 Probe Company",
      })
      .select("id");
    expect(companyInsert.error, companyInsert.error?.message).toBeNull();
    expect(companyInsert.data?.length, "the company profile was created").toBe(1);
  });

  it("...and the APPLICATION action (createNetworkProfileAction) agrees, with the SAME reason tests/unit/network/access.test.ts predicts", async () => {
    registerOrg(fx.orgA.slug, fx.orgA.id, "marketing");
    actAs(fx.activeByRole.marketing);
    const artistId = await insertArtist(fx.ownerA.client, fx.orgA.id, "M4 Probe Artist 2");

    const result = await createNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        entityKind: "artist",
        entityId: artistId,
        displayName: "M4 Probe Artist 2",
      }),
    );
    expect(result.error, "the M4-closed gate refuses before any INSERT runs").toBeDefined();
    expect(result.error).toMatch(/artists/);

    const { rows } = await pool.query(
      `select 1 from public.network_profiles where organisation_id = $1 and entity_id = $2`,
      [fx.orgA.id, artistId],
    );
    expect(rows.length, "no profile was created").toBe(0);
  });
});

describe("THE LEAKAGE ASSERTION: a second tenant reading network_directory sees only what was marked `network`", () => {
  it("published fields resolve; connections/hidden fields are null; no companies-only column exists on the view", async () => {
    registerOrg(fx.orgA.slug, fx.orgA.id, "owner");
    actAs(fx.ownerA);

    const companyId = await insertCompany(fx.ownerA.client, fx.orgA.id, "Leakage Probe Ltd");
    const created = await createNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        entityKind: "company",
        entityId: companyId,
        displayName: "Leakage Probe Ltd",
      }),
    );
    expect(created.error, created.error).toBeUndefined();

    const { rows } = await pool.query<{ id: string }>(
      `select id from public.network_profiles
        where organisation_id = $1 and entity_id = $2 and deleted_at is null`,
      [fx.orgA.id, companyId],
    );
    const profileId = rows[0]!.id;

    const updated = await updateNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        profileId,
        displayName: "Leakage Probe Ltd",
        headline: "Everyone can see this",
        visibility_headline: "network",
        bio: "Only a connection can see this",
        visibility_bio: "connections",
        city: "Hidden City",
        visibility_city: "hidden",
      }),
    );
    expect(updated.error, updated.error).toBeUndefined();

    const publish = await publishNetworkProfileAction(
      {},
      formData({ orgSlug: fx.orgA.slug, profileId }),
    );
    expect(publish.error, publish.error).toBeUndefined();

    // NOW SWITCH TENANTS. orgB's owner has never heard of orgA's company.
    const reader = fx.ownerB.client;
    const { data: directoryRows, error: directoryError } = await reader
      .from("network_directory")
      .select(
        "id, entity_kind, display_name, headline, bio, city, region, country, website_url, contact_email, published_at",
      )
      .eq("id", profileId);
    expect(directoryError, directoryError?.message).toBeNull();
    expect(directoryRows?.length, "the published profile is visible to another tenant").toBe(1);
    const row = directoryRows![0]!;

    expect(row.display_name).toBe("Leakage Probe Ltd");
    expect(row.headline, "network-level field resolves").toBe("Everyone can see this");
    expect(row.bio, "connections-level field is masked for a non-connected reader").toBeNull();
    expect(row.city, "hidden field is masked").toBeNull();

    // COLUMN BY COLUMN: every column `companies` carries that is NOT part of
    // the network vocabulary must not exist on the reachable surface at all --
    // selecting it from network_directory is a PostgREST 400/42703, not a
    // null value (a null would be indistinguishable from "not published"; a
    // rejected column proves it was never projected in the first place).
    const { rows: companyColumnRows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'companies'`,
    );
    const NETWORK_VOCABULARY = new Set([
      "id",
      "entity_kind",
      "display_name",
      "headline",
      "bio",
      "city",
      "region",
      "country",
      "website_url",
      "contact_email",
      "published_at",
    ]);
    const companiesOnlyColumns = companyColumnRows
      .map((r) => r.column_name)
      .filter((name) => !NETWORK_VOCABULARY.has(name));
    // The denominator: there really are columns to check.
    expect(companiesOnlyColumns.length, "companies columns outside the vocabulary").toBeGreaterThan(0);
    expect(companiesOnlyColumns).toEqual(
      expect.arrayContaining([
        "organisation_id",
        "owner_user_id",
        "name",
        "type",
        "deleted_at",
        "created_at",
        "updated_at",
      ]),
    );

    for (const column of companiesOnlyColumns) {
      const { error } = await reader.from("network_directory").select(column).eq("id", profileId);
      expect(
        error,
        `network_directory unexpectedly has a "${column}" column reachable over PostgREST`,
      ).not.toBeNull();
    }
  });
});

describe("Constraint 11 on the AUTHORISATION refusal path: the visibility ladder survives a refusal it did not cause", () => {
  it("a Booker's submit is refused by authoriseNetwork, and the echoed visibility choice comes back intact", async () => {
    // A BOOKER: holds view_network (browses) but NOT manage_network_profile,
    // so `authoriseNetwork` refuses before `readProfile` is ever called --
    // this is the AUTHORISATION refusal path specifically, not the field-
    // validation one N3's test already exercises.
    registerOrg(fx.orgA.slug, fx.orgA.id, "booker");
    actAs(fx.ownerA);
    const companyId = await insertCompany(fx.ownerA.client, fx.orgA.id, "Constraint 11 Probe Ltd");
    const created = await createNetworkProfileAction(
      {},
      formData({
        orgSlug: fx.orgA.slug,
        entityKind: "company",
        entityId: companyId,
        displayName: "Constraint 11 Probe Ltd",
      }),
    );
    expect(created.error, created.error).toBeUndefined();
    const { rows } = await pool.query<{ id: string }>(
      `select id from public.network_profiles
        where organisation_id = $1 and entity_id = $2 and deleted_at is null`,
      [fx.orgA.id, companyId],
    );
    const profileId = rows[0]!.id;

    // NOW SWITCH TO THE BOOKER -- same organisation, a role with no
    // manage_network_profile at all.
    actAs(fx.activeByRole.booker);
    const submitted = formData({
      orgSlug: fx.orgA.slug,
      profileId,
      displayName: "Constraint 11 Probe Ltd",
      headline: "A headline the booker typed",
      visibility_headline: "network",
      "visibility_headline__submitted": "1",
    });
    const refused = await updateNetworkProfileAction({}, submitted);

    expect(refused.error, "the booker is refused by authoriseNetwork").toBeDefined();
    // THE ASSERTION: the refusal carries the submitted visibility choice back,
    // not the profile's stored (hidden) state -- without this, React 19's
    // form reset would silently revert the booker's just-chosen ladder (or,
    // worse, a retry by someone WITH permission would re-hide a field the
    // page had shown as selected).
    expect(refused.values?.visibility_headline, "the echoed visibility survives the refusal").toBe(
      "network",
    );
    expect(refused.values?.headline).toBe("A headline the booker typed");

    // ...and, the other half of Constraint 12: the refusal did not touch the
    // row. It is still hidden, exactly as it started.
    const after = await pool.query<{ headline: string | null }>(
      `select headline from public.network_profiles where id = $1`,
      [profileId],
    );
    expect(after.rows[0]!.headline, "the refused write did not apply").toBeNull();
  });
});
