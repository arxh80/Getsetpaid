// Phase 10 Task 14 (G6). The "Publish a record" picker and the "Send from"
// choice used to read every live profile of the organisation, which past
// `[api] max_rows = 1000` PostgREST cuts short without an error. This seeds
// 150 published venues and one unpublished venue whose name sorts after all of
// them, then calls the real loaders against the real stack as a manager of
// org A (only `@/lib/supabase/server`'s createClient is replaced, with a real
// signed-in supabase-js client -- the directory-list-page.test.ts seam).
//
// It asserts the two properties G6 is about: no single read returns more than
// 101 rows, and the picker still finds the unpublished venue past the first
// page of published ones.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

const current = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));

import { loadOwnPublishedProfiles, loadPublishableEntities } from "@/lib/network/entities";

let fx: RlsFixtures;
let pool: Pool;
const SEEDED = 150;
const PREFIX = "AAAA G6 Venue";

/** Row counts of every PostgREST read made while `fn` runs. */
async function rowCounts(fn: () => Promise<unknown>): Promise<number[]> {
  const counts: number[] = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const res = await real(input, init);
    if (String(input instanceof Request ? input.url : input).includes("/rest/v1/")) {
      const body: unknown = await res.clone().json().catch(() => null);
      if (Array.isArray(body)) counts.push(body.length);
    }
    return res;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return counts;
}

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
  await pool.query(
    `with v as (
       insert into public.venues (organisation_id, name)
       select $1, $2 || ' ' || lpad(i::text, 3, '0') from generate_series(0, $3 - 1) i
       returning id, name)
     insert into public.network_profiles
       (organisation_id, entity_kind, entity_id, status, field_visibility, display_name, published_at)
     select $1, 'venue', v.id, 'published', '{}'::jsonb, v.name, now() from v`,
    [fx.orgA.id, PREFIX, SEEDED],
  );
  await pool.query(`insert into public.venues (organisation_id, name) values ($1, $2)`, [fx.orgA.id, `${PREFIX} zzz unpublished`]);
  current.client = fx.activeByRole.manager.client;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await pool.query(`delete from public.network_profiles where organisation_id = $1 and display_name like $2`, [fx.orgA.id, `${PREFIX}%`]);
  await pool.query(`delete from public.venues where organisation_id = $1 and name like $2`, [fx.orgA.id, `${PREFIX}%`]);
  await destroyFixtures(fx);
});

describe("the network pickers are bounded (G6)", () => {
  it("the publish picker offers the unpublished venue past 150 published ones, reading at most 101 rows at a time", async () => {
    let options: { id: string; name: string }[] = [];
    const counts = await rowCounts(async () => {
      options = await loadPublishableEntities(fx.orgA.id, "venue");
    });
    const names = options.map((o) => o.name);
    expect(names).toContain(`${PREFIX} zzz unpublished`);
    expect(names.filter((n) => n.startsWith(PREFIX) && !n.endsWith("unpublished"))).toEqual([]);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(101);
  });

  it("Send from lists the first 100 of 150 and says there are more", async () => {
    let own = { profiles: [] as { displayName: string }[], more: false };
    const counts = await rowCounts(async () => {
      own = await loadOwnPublishedProfiles(fx.orgA.id);
    });
    expect(own.profiles).toHaveLength(100);
    expect(own.more).toBe(true);
    expect(Math.max(...counts)).toBeLessThanOrEqual(101);
  });
});
