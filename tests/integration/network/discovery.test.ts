// TASK 3'S OWN TEST ASSERTIONS -- `loadNetworkDirectory` AND
// `loadNetworkProfileForViewer`, DRIVEN AGAINST THE REAL STACK.
//
// ===========================================================================
// WHY THIS IS AN INTEGRATION TEST, NOT A UNIT TEST
// ===========================================================================
// `tests/unit/network/discovery-source-shape.test.ts` proves the SHAPE never
// regresses to reading `public.network_profiles` -- from source, so it runs in
// CI. This file proves the BEHAVIOUR the shape exists to protect: that
// `network_connected_profiles` really does resolve a `connections`-level field
// once an accepted request stands between the two organisations, and that
// `network_directory` really does not before one does. Only a real Postgres
// session, with real RLS and a real `security_invoker` view, can tell those
// two states apart -- a mocked client cannot produce either failure mode.
//
// WHAT IS MOCKED: only `@/lib/supabase/server`'s `createClient`, replaced with
// a real supabase-js client signed in as a real persona -- the
// `directory-list-page.test.ts` seam. The query, the views, the policies and
// the RLS boundary are all real.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

const current = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

import {
  loadNetworkDirectory,
  loadNetworkProfileForViewer,
} from "@/lib/network/discovery";
import { loadNetworkProfileById } from "@/lib/network/entities";
import { mapNetworkDirectoryRow } from "@/lib/network/discovery-list";

let fx: RlsFixtures;
let pool: Pool;

/** The ids this file plants. */
const ALPHA_UNCONNECTED = "f0120000-0000-0000-0000-000000000001";
const ALPHA_CONNECTED_LATER = "f0120000-0000-0000-0000-000000000002";
const BETA_ANCHOR = "f0120000-0000-0000-0000-000000000003";

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;

  // TWO ORG-A PROFILES, so the "before the connection" and "after the
  // connection" assertions run on ORGANISATION-LEVEL state rather than on
  // whichever single profile happened to be used to send the request --
  // exactly what the connected view's `exists` clause tests (organisation to
  // organisation, not profile to profile). ONE ORG-B PROFILE exists only to
  // satisfy `network_connection_requests.to_network_profile_id`'s NOT NULL --
  // a request needs a published profile on each end (Q78).
  //
  // THE DENOMINATOR: exactly ONE field (`contact_email`) is `connections` on
  // ALPHA_CONNECTED_LATER. `city` is `network` on both, as the positive
  // control that masking is not wholesale.
  await pool.query(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, city, contact_email, published_at, deleted_at)
     values
       ($1, $4, 'company', gen_random_uuid(), 'published',
        '{"city":"network","contact_email":"connections"}'::jsonb,
        'Discovery Unconnected Ltd', 'Bristol', 'unconnected@alpha.test', now(), null),
       ($2, $4, 'venue', gen_random_uuid(), 'published',
        '{"city":"network","contact_email":"connections"}'::jsonb,
        'Discovery Connected Later Ltd', 'Bristol', 'connected@alpha.test', now(), null),
       ($3, $5, 'company', gen_random_uuid(), 'published',
        '{}'::jsonb, 'Discovery Beta Anchor', null, null, now(), null)`,
    [ALPHA_UNCONNECTED, ALPHA_CONNECTED_LATER, BETA_ANCHOR, fx.orgA.id, fx.orgB.id],
  );
});

afterAll(async () => {
  await pool.query(
    `delete from public.network_connection_requests where from_network_profile_id = any($1) or to_network_profile_id = any($1)`,
    [[ALPHA_UNCONNECTED, ALPHA_CONNECTED_LATER, BETA_ANCHOR]],
  );
  await pool.query(`delete from public.network_profiles where id = any($1)`, [
    [ALPHA_UNCONNECTED, ALPHA_CONNECTED_LATER, BETA_ANCHOR],
  ]);
  await destroyFixtures(fx);
});

describe("loadNetworkProfileForViewer: no connection stands -- the `connections` field does not resolve", () => {
  it("org B's owner sees ALPHA_UNCONNECTED through the DIRECTORY, with the connections field null and the network field present", async () => {
    current.client = fx.ownerB.client;
    const result = await loadNetworkProfileForViewer(ALPHA_UNCONNECTED);
    expect(result, "the profile is published and must resolve").not.toBeNull();
    expect(result!.source).toBe("directory");
    // THE DENOMINATOR: ALPHA_UNCONNECTED has exactly 1 field set to
    // `connections` in the fixture above (contact_email) -- so this is not a
    // vacuous "everything happens to be null" pass.
    expect(result!.row.contactEmail, "a connections-level field, unconnected").toBeNull();
    // THE POSITIVE CONTROL: a `network`-level field on the SAME row resolves,
    // so the null above is the mask working, not a broken view.
    expect(result!.row.city, "a network-level field resolves regardless").toBe("Bristol");
    expect(result!.row.displayName).toBe("Discovery Unconnected Ltd");
  });
});

describe("loadNetworkProfileForViewer: an accepted connection resolves the connections field", () => {
  it("before the request exists, org B sees ALPHA_CONNECTED_LATER masked the same way", async () => {
    current.client = fx.ownerB.client;
    const before = await loadNetworkProfileForViewer(ALPHA_CONNECTED_LATER);
    expect(before!.source).toBe("directory");
    expect(before!.row.contactEmail).toBeNull();
  });

  it("...and after an ACCEPTED request stands between org A and org B, it resolves through the CONNECTED view", async () => {
    // Hand-planted, per the acceptance criterion's own words ("until Task 4
    // exists"): Task 4 is what will let a real UI send this row.
    await pool.query(
      `insert into public.network_connection_requests
         (from_organisation_id, from_network_profile_id, to_organisation_id,
          to_network_profile_id, status, requested_at, responded_at)
       values ($1, $2, $3, $4, 'accepted', now(), now())`,
      [fx.orgA.id, ALPHA_CONNECTED_LATER, fx.orgB.id, BETA_ANCHOR],
    );

    current.client = fx.ownerB.client;
    const after = await loadNetworkProfileForViewer(ALPHA_CONNECTED_LATER);
    expect(after, "still resolves").not.toBeNull();
    expect(after!.source, "now resolves through the CONNECTED view").toBe("connected");
    expect(after!.row.contactEmail, "the connections field now resolves").toBe(
      "connected@alpha.test",
    );
    expect(after!.row.city, "the network field is unaffected").toBe("Bristol");

    // THE ORG-LEVEL SHAPE, ASSERTED: the SAME accepted request ALSO unlocks
    // ALPHA_UNCONNECTED for org B, because the view's `exists` clause tests
    // organisation membership, not which profile the request named.
    const other = await loadNetworkProfileForViewer(ALPHA_UNCONNECTED);
    expect(other!.source).toBe("connected");
    expect(other!.row.contactEmail).toBe("unconnected@alpha.test");

    // SYMMETRY (Q80): org A reading its OWN profile through this function
    // (never done by the real page, which prefers ownership -- but the
    // function itself has no ownership concept) ALSO resolves through the
    // connected view now, because the exists clause is written both ways
    // round.
    current.client = fx.ownerA.client;
    const symmetric = await loadNetworkProfileForViewer(BETA_ANCHOR);
    expect(symmetric!.source).toBe("connected");
  });
});

describe("positive control: the OWNING organisation's own read shows every field it stored", () => {
  it("org A's own read of ALPHA_CONNECTED_LATER (via loadNetworkProfileById, the page's OTHER source) is never masked", async () => {
    // This is `lib/network/entities.ts`'s function, not this file's -- named
    // here because it is exactly what the profile PAGE calls for the
    // ownership branch, and the acceptance criterion is about the page's
    // combined behaviour: "the owning organisation's own profile page shows
    // every field it stored." A masking view is never consulted for this
    // branch (Constraint 19: the page prefers ownership over the views), so
    // there is nothing to mask -- the value simply comes back.
    current.client = fx.ownerA.client;
    const own = await loadNetworkProfileById(fx.orgA.id, ALPHA_CONNECTED_LATER);
    expect(own).not.toBeNull();
    expect(own!.contactEmail, "the connections-level field, read as its owner").toBe(
      "connected@alpha.test",
    );
    expect(own!.city).toBe("Bristol");
  });
});

describe("loadNetworkProfileForViewer: draft and foreign-unowned collapse to null", () => {
  it("a DRAFT profile of org A is invisible to org B through this function (the page's ownership fallback is what shows it to org A itself)", async () => {
    const draftId = "f0120000-0000-0000-0000-000000000009";
    await pool.query(
      `insert into public.network_profiles
         (id, organisation_id, entity_kind, entity_id, status, field_visibility, display_name)
       values ($1, $2, 'venue', gen_random_uuid(), 'draft', '{}'::jsonb, 'Discovery Draft Ltd')`,
      [draftId, fx.orgA.id],
    );
    try {
      current.client = fx.ownerB.client;
      const result = await loadNetworkProfileForViewer(draftId);
      expect(result, "neither view carries a draft").toBeNull();
    } finally {
      await pool.query(`delete from public.network_profiles where id = $1`, [draftId]);
    }
  });

  it("an id that never existed resolves to null, the identical answer", async () => {
    current.client = fx.ownerB.client;
    const result = await loadNetworkProfileForViewer("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("loadNetworkDirectory: the page-size CEILING is enforced server-side", () => {
  // THE DENOMINATOR THIS ASSERTION NEEDS AND DID NOT HAVE. Fewer than 50
  // published profiles exist anywhere else in this fixture, so
  // `page.rows.length <= 50` would pass VACUOUSLY -- true whether the ceiling
  // is enforced or removed, because there is nothing to distinguish "capped
  // at 50" from "returned everything, which happens to be under 50". Found
  // by running the mutation this task's own brief specifies (removing
  // `Math.min(rawSize, MAX_PAGE_SIZE)` in lib/list/params.ts): the first
  // version of this test stayed green. 60 extra published profiles, named so
  // they cannot collide with anything else this file plants, make the
  // denominator real: with the ceiling in place, size=100000 returns exactly
  // 50; with it removed, it returns more than 50.
  const CEILING_PROFILE_IDS = Array.from(
    { length: 60 },
    (_, i) => `f0120000-0000-0000-0000-0000000cc0${String(i).padStart(2, "0")}`,
  );

  beforeAll(async () => {
    const values = CEILING_PROFILE_IDS.map(
      (_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, 'company', gen_random_uuid(), 'published', '{}'::jsonb, 'Ceiling Filler ${i}', now())`,
    ).join(",\n");
    const params = CEILING_PROFILE_IDS.flatMap((id) => [id, fx.orgA.id]);
    await pool.query(
      `insert into public.network_profiles
         (id, organisation_id, entity_kind, entity_id, status, field_visibility, display_name, published_at)
       values ${values}`,
      params,
    );
  });

  afterAll(async () => {
    await pool.query(`delete from public.network_profiles where id = any($1)`, [
      CEILING_PROFILE_IDS,
    ]);
  });

  it("size=100000 returns the ceiling (50), not 100000 and not the 63+ real rows available", async () => {
    current.client = fx.ownerB.client;
    const page = await loadNetworkDirectory({ net_size: "100000" });
    if (page.outcome !== "loaded") throw new Error("page did not load");
    // 50 is `lib/list/params.ts`'s MAX_PAGE_SIZE -- shared by every spec in the
    // product, not reimplemented here. What is under test is that THIS spec's
    // caller cannot bypass it by naming a bigger number, with enough real rows
    // planted (63+) that "50" and "everything" are different answers.
    expect(page.rows.length).toBe(50);
  });

  it("positive control: a legal, small size is honoured exactly", async () => {
    current.client = fx.ownerB.client;
    const page = await loadNetworkDirectory({ net_size: "1" });
    if (page.outcome !== "loaded") throw new Error("page did not load");
    expect(page.rows).toHaveLength(1);
  });

  it("loadNetworkDirectory really is loadNetworkDirectory: it maps rows the same way the spec's own mapper does", async () => {
    current.client = fx.ownerB.client;
    const page = await loadNetworkDirectory({ net_q: "Discovery Unconnected" });
    if (page.outcome !== "loaded") throw new Error("page did not load");
    expect(page.rows.map((r) => r.id)).toContain(ALPHA_UNCONNECTED);
    const raw = { id: ALPHA_UNCONNECTED, entity_kind: "company", display_name: "x" };
    expect(mapNetworkDirectoryRow(raw).id).toBe(ALPHA_UNCONNECTED);
  });
});
