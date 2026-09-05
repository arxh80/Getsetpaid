// THE TEST REVIEW FINDING I3 EXISTS FOR: `NETWORK_DIRECTORY_LIST` REALLY
// FETCHES A PAGE.
//
// ===========================================================================
// WHY A SPEC THAT TYPE-CHECKS IS NOT A SPEC THAT WORKS
// ===========================================================================
// Task 1 shipped `NETWORK_DIRECTORY_LIST` described as "consumed by Task 3",
// and it could not be consumed. `lib/list/query.ts`'s `applyScope` applied
// `.eq("organisation_id", organisationId)` unconditionally and a `deleted_at`
// filter unless the relation was exempted; `public.network_directory` projects
// NEITHER column, deliberately and correctly. Every `fetchListPage` call
// against it would have been a PostgREST 400 twice over --
// `column network_directory.organisation_id does not exist` -- rendered to the
// user as "we couldn't load this".
//
// THAT IS THE `activity_events` DEFECT REPEATING ONE PHASE LATER, and
// `lib/list/query.ts:370-379` describes it in as many words: "FOUND IN A
// BROWSER, WITH EVERY GATE GREEN". Nothing caught it in Phase 6 either --
// `tsc`, eslint, 1395 unit and integration tests, 1467 psql assertions and 250
// HTTP checks were all green, because NOTHING CALLED `fetchListPage` AGAINST
// THE VIEW. The census in `soft-delete-tables-match-db.test.ts` did not fire
// for exactly that reason: it scans for `table:` call sites, and Task 1 shipped
// none.
//
// So this file makes the call. It is the smallest possible thing that would
// have gone red, and it is deliberately an INTEGRATION test against the real
// stack: the failure mode is a PostgREST response to a real query, which a
// mocked client cannot produce (`tests/unit/list/fetch-list-page.test.ts`
// mocks the client and is green on both sides of this bug).
//
// ===========================================================================
// AND IT ASSERTS THE PROPERTY THAT MADE THE EXEMPTION NECESSARY
// ===========================================================================
// The directory is THE ONE LIST IN THE PRODUCT THAT IS NOT ORGANISATION-SCOPED.
// So "it loads" is not enough: the test asserts a caller in org A sees org B's
// published profile through it, which is the whole feature and is also the
// thing that would break if someone "fixed" the exemption by re-adding the
// tenant clause. The masking, the draft/soft-delete exclusions and the paging
// are asserted on the same page, because all four run through `applyScope` and
// a spec that loads but pages wrong is not consumable either.
//
// WHAT IS MOCKED: only `@/lib/supabase/server`'s `createClient`, replaced with
// a REAL supabase-js client signed in as a real persona (the
// `upload-scan-download.test.ts` seam). The query, the view, the policies and
// the RLS boundary are all real.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

const current = vi.hoisted(() => ({
  // A supabase-js client, typed loosely to avoid importing the type here.
  client: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

// Imported AFTER the mock (vi.mock is hoisted above imports by vitest).
import { fetchListPage } from "@/lib/list/query";
import { parseListParams } from "@/lib/list/params";
import { encodeCursor } from "@/lib/list/cursor";
import {
  NETWORK_DIRECTORY_LIST,
  NETWORK_DIRECTORY_SELECT,
  mapNetworkDirectoryRow,
  type NetworkDirectoryRow,
} from "@/lib/network/discovery-list";

let fx: RlsFixtures;
let pool: Pool;

/** The ids this file plants, so teardown and the assertions can name them. */
const ALPHA_PUBLISHED = "f0110000-0000-0000-0000-00000000000a";
const BETA_PUBLISHED = "f0110000-0000-0000-0000-00000000000b";
const ALPHA_DRAFT = "f0110000-0000-0000-0000-00000000000d";
const BETA_DELETED = "f0110000-0000-0000-0000-00000000000e";

/**
 * Fetch one page through the spec, as the currently-set persona.
 *
 * Goes through `parseListParams` rather than hand-building a `ListParams`, so
 * the spec's own defaults (sort `name` asc, the `net_` prefix, the page size
 * ceiling) are what the query is built from — which is the thing being proved
 * consumable.
 */
async function fetchPage(raw: Record<string, string | undefined> = {}) {
  return fetchListPage<
    NetworkDirectoryRow,
    "name",
    keyof (typeof NETWORK_DIRECTORY_LIST)["filters"]
  >({
    spec: NETWORK_DIRECTORY_LIST,
    params: parseListParams(NETWORK_DIRECTORY_LIST, raw),
    // Passed because the option is required and the caller always has it. The
    // directory ignores it — that is the exemption under test.
    organisationId: fx.orgA.id,
    table: "network_directory",
    select: NETWORK_DIRECTORY_SELECT,
    mapRow: mapNetworkDirectoryRow,
  });
}

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;

  // FOUR PROFILES, planted as postgres: one published in EACH organisation
  // (the cross-tenant pair), one draft and one soft-deleted (the exclusions).
  // The published ALPHA one spreads its visibility across two levels so the
  // mask can be asserted on the same page.
  await pool.query(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, city, contact_email, published_at, deleted_at)
     values
       ($1, $5, 'company', gen_random_uuid(), 'published',
        '{"city":"network","contact_email":"connections"}'::jsonb,
        'AAA Directory Alpha', 'Bristol', 'bookings@alpha.test', now(), null),
       ($2, $6, 'company', gen_random_uuid(), 'published',
        '{"city":"network"}'::jsonb,
        'BBB Directory Beta', 'Leeds', null, now(), null),
       ($3, $5, 'venue', gen_random_uuid(), 'draft',
        '{}'::jsonb, 'CCC Directory Draft', null, null, null, null),
       ($4, $6, 'venue', gen_random_uuid(), 'published',
        '{}'::jsonb, 'DDD Directory Deleted', null, null, now(), now())`,
    [
      ALPHA_PUBLISHED,
      BETA_PUBLISHED,
      ALPHA_DRAFT,
      BETA_DELETED,
      fx.orgA.id,
      fx.orgB.id,
    ],
  );

  // A MANAGER of org A. `view_network` is held by all nine roles, and a
  // password grant yields aal1 — which `manager` is fine at, unlike an owner
  // (role_requires_mfa). So this is a realistic steady-state session.
  current.client = fx.activeByRole.manager.client;
});

afterAll(async () => {
  await pool.query(`delete from public.network_profiles where id = any($1)`, [
    [ALPHA_PUBLISHED, BETA_PUBLISHED, ALPHA_DRAFT, BETA_DELETED],
  ]);
  await destroyFixtures(fx);
});

describe("NETWORK_DIRECTORY_LIST can actually be fetched through fetchListPage", () => {
  it("LOADS AT ALL — this is the assertion that was missing", async () => {
    // Before the fix this was `{ outcome: "unavailable" }`, because
    // `applyScope` filtered two columns the view does not project. A page that
    // cannot load is the whole of finding I3.
    const page = await fetchPage();
    expect(
      page.outcome,
      "fetchListPage against public.network_directory returned unavailable. " +
        "If the reason is `column network_directory.organisation_id does not " +
        "exist`, RELATIONS_WITHOUT_ORGANISATION_ID in lib/list/query.ts has " +
        "lost its entry; if it is `...deleted_at does not exist`, " +
        "TABLES_WITHOUT_SOFT_DELETE has.",
    ).toBe("loaded");
  });

  it("returns BOTH organisations' published profiles — the list is cross-tenant", async () => {
    // THE PROPERTY THE EXEMPTION EXISTS FOR, asserted so that re-adding the
    // tenant clause (which would make the test above pass again if the view
    // ever gained an organisation_id column) is still red. A caller in org A
    // sees org B's profile.
    const page = await fetchPage();
    if (page.outcome !== "loaded") throw new Error("page did not load");
    const ids = page.rows.map((r) => r.id);
    expect(ids, "org A's own published profile").toContain(ALPHA_PUBLISHED);
    expect(ids, "org B's published profile, read from org A").toContain(
      BETA_PUBLISHED,
    );
  });

  it("excludes a DRAFT and a SOFT-DELETED profile", async () => {
    // The view's own `where p.status = 'published' and p.deleted_at is null`
    // is what does this — once, for every reader — which is precisely why
    // `applyScope` must not add a `deleted_at` filter of its own.
    const page = await fetchPage();
    if (page.outcome !== "loaded") throw new Error("page did not load");
    const ids = page.rows.map((r) => r.id);
    expect(ids, "a draft profile is not discoverable").not.toContain(ALPHA_DRAFT);
    expect(ids, "a soft-deleted profile is not discoverable").not.toContain(
      BETA_DELETED,
    );
  });

  it("carries the MASK through the mapper: a network field resolves, a connections field is null", async () => {
    // The masking is the view's, and this proves it survives the whole path —
    // select list, PostgREST, `mapNetworkDirectoryRow` — rather than only in
    // psql. `contact_email` is `connections`-level on this profile and there is
    // no accepted connection, so it must arrive null.
    const page = await fetchPage();
    if (page.outcome !== "loaded") throw new Error("page did not load");
    const alpha = page.rows.find((r) => r.id === ALPHA_PUBLISHED);
    expect(alpha, "the ALPHA profile is on the page").toBeDefined();
    expect(alpha!.city, "a `network` field resolves").toBe("Bristol");
    expect(alpha!.contactEmail, "a `connections` field is masked").toBeNull();
    // The always-visible pair, so "everything is null" cannot pass this.
    expect(alpha!.displayName).toBe("AAA Directory Alpha");
    expect(alpha!.entityKind).toBe("company");
  });

  it("sorts by display_name ascending, the spec's default", async () => {
    const page = await fetchPage();
    if (page.outcome !== "loaded") throw new Error("page did not load");
    const planted = page.rows
      .map((r) => r.displayName)
      .filter((n) => n.startsWith("AAA Directory") || n.startsWith("BBB Directory"));
    expect(planted).toEqual(["AAA Directory Alpha", "BBB Directory Beta"]);
  });

  it("PAGES: a page size of 1 yields one row and a next cursor that advances", async () => {
    // Keyset paging runs through `applyScope` on every one of its queries —
    // the page, the count, and the previous/next probes. A spec that loads
    // page one and 400s on page two is not consumable either, so the second
    // page is fetched through the cursor the first one returned.
    const first = await fetchPage({ net_size: "1" });
    if (first.outcome !== "loaded") throw new Error("page one did not load");
    expect(first.rows).toHaveLength(1);
    expect(first.hasNext, "there is more than one published profile").toBe(true);
    expect(first.lastCursor, "page one returns a cursor to page two").not.toBeNull();
    expect(first.total, "the count query ran too").toBeGreaterThanOrEqual(2);

    // ENCODED, because that is what a URL carries and what `parseListParams`
    // decodes -- passing the Cursor OBJECT makes `decodeCursor` return null,
    // the request becomes an un-cursored page one, and the test quietly
    // re-reads the same row. It did exactly that on the first run.
    const second = await fetchPage({
      net_size: "1",
      net_after: encodeCursor(first.lastCursor!),
    });
    if (second.outcome !== "loaded") throw new Error("page two did not load");
    expect(second.rows).toHaveLength(1);
    expect(
      second.rows[0]!.id,
      "page two is a different row from page one",
    ).not.toBe(first.rows[0]!.id);
    expect(second.hasPrevious, "page two knows page one is behind it").toBe(true);
  });

  it("SEARCHES on display_name, the spec's searchColumn", async () => {
    // `applyScope` applies the search too, so a search that 400s is the same
    // class of unconsumable. `ilike` over a column the view does project.
    const page = await fetchPage({ net_q: "BBB Directory" });
    if (page.outcome !== "loaded") throw new Error("search page did not load");
    expect(page.rows.map((r) => r.id)).toEqual([BETA_PUBLISHED]);
  });
});
