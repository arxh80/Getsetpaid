// THE NAMED NETWORK-DISCOVERY LIMIT, PROVED END TO END.
//
// ===========================================================================
// WHY THIS FILE EXISTS AND WHY NOTHING IN IT IS MOCKED BUT THE CLIENT SEAM
// ===========================================================================
// SECURITY.md § 5's network-discovery row -- 30 requests / minute, per user,
// against the NAMED path -- is the one limit in the table whose unit cost is
// O(platform-wide published rows) rather than O(tenant). Task 5's brief asks
// for a proof "driven through the real enforcement point rather than a mock",
// and it asks for that specifically because a mocked limiter proves only that
// the mock counts.
//
// So: the counter is a real row in a real Postgres, the verdict comes from the
// real `public.consume_rate_limit()`, the window arithmetic is the real
// `private.rate_limit_window_start()`, and the call under test is
// `loadNetworkDirectory()` -- the same function `/[orgSlug]/network`'s page
// component calls, going through the same `fetchListPage` chokepoint that
// decides the category from the TABLE NAME. The only thing replaced is
// `@/lib/supabase/server`'s `createClient`, swapped for a real supabase-js
// client signed in as a real persona: the `directory-list-page.test.ts` seam,
// which changes who is asking and nothing about what happens next.
//
// Note that `consumeRateLimit` is `cache()`-wrapped for per-REQUEST dedupe.
// React's `cache` memoises against a request store; outside one it passes
// straight through (measured, not assumed -- if that ever changed, every
// assertion below would read one verdict thirty times and this file would go
// red rather than quietly stop testing anything).
//
// ===========================================================================
// WINDOWS ARE EPOCH-ALIGNED, SO THE TEST WAITS FOR A FRESH ONE
// ===========================================================================
// `private.rate_limit_window_start()` bins from the epoch, not from a
// subject's first request. Thirty round trips that straddled a bin boundary
// would split across two counters and never reach the limit -- a flake with a
// perfectly good explanation, which is the worst kind. `waitForFreshWindow()`
// below refuses to start a burst without enough of the current bin left.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

const current = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

import { loadNetworkDirectory } from "@/lib/network/discovery";
import { fetchListPage } from "@/lib/list/query";
import { parseListParams } from "@/lib/list/params";
import {
  CONTACT_LIST,
  CONTACT_SELECT,
  type ContactRow,
} from "@/lib/crm/contacts-list";

let fx: RlsFixtures;
let pool: Pool;
let subjectId: string;

const PROFILE = "f0130000-0000-0000-0000-000000000001";

/** SECURITY.md § 5's own numbers, read back from the seed rather than typed. */
let DISCOVERY_MAX = 0;
let DISCOVERY_WINDOW = 0;

/**
 * Block until at least `needSeconds` of the current fixed window remain.
 *
 * The bin is `floor(epochSeconds / window) * window`, exactly what
 * `date_bin(..., 'epoch')` computes, so this is the same arithmetic the
 * database will apply to each request in the burst.
 */
async function waitForFreshWindow(windowSeconds: number, needSeconds: number) {
  const usedSeconds = (Date.now() / 1000) % windowSeconds;
  const remaining = windowSeconds - usedSeconds;
  if (remaining >= needSeconds) return;
  await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 150));
}

/** The counter row the burst is writing, straight out of Postgres. */
async function counterCount(): Promise<number> {
  const { rows } = await pool.query(
    `select request_count from public.rate_limit_counters
      where category = 'network_discovery'
        and subject_scope = 'user'
        and subject_id = $1
        and window_start = date_bin(
              make_interval(secs => (select window_seconds
                                       from public.rate_limit_policies
                                      where category = 'network_discovery')),
              now(), 'epoch'::timestamptz)`,
    [subjectId],
  );
  return rows.length === 0 ? 0 : Number(rows[0].request_count);
}

async function tripAlertCount(): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from public.incident_alerts
      where alert_type = 'rate_limit_tripped'
        and details->>'subject_id' = $1`,
    [subjectId],
  );
  return rows[0].n as number;
}

async function clearCounters() {
  await pool.query(
    `delete from public.rate_limit_counters where subject_id = $1`,
    [subjectId],
  );
  await pool.query(
    `delete from public.incident_alerts where details->>'subject_id' = $1`,
    [subjectId],
  );
}

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;

  // One published profile, so the directory has something to return and a
  // "loaded" outcome means the query really ran rather than short-circuiting
  // on an empty relation.
  await pool.query(
    `insert into public.network_profiles
       (id, organisation_id, entity_kind, entity_id, status, field_visibility,
        display_name, city, published_at, deleted_at)
     values ($1, $2, 'company', gen_random_uuid(), 'published',
             '{"city":"network"}'::jsonb, 'Rate Limit Fixture', 'Bristol',
             now(), null)`,
    [PROFILE, fx.orgB.id],
  );

  // A MANAGER of org A: `view_network` is held by all nine roles and a
  // password grant yields aal1, which manager is fine at -- a realistic
  // steady-state session, the same persona directory-list-page.test.ts uses.
  current.client = fx.activeByRole.manager.client;
  subjectId = fx.activeByRole.manager.userId;

  const { rows } = await pool.query(
    `select max_requests, window_seconds from public.rate_limit_policies
      where category = 'network_discovery'`,
  );
  DISCOVERY_MAX = Number(rows[0].max_requests);
  DISCOVERY_WINDOW = Number(rows[0].window_seconds);

  await clearCounters();
});

afterAll(async () => {
  // Restore the seeded policy unconditionally -- § 2 narrows it, and a test
  // that failed mid-narrowing must not leave a 2-second network-discovery
  // budget behind for whatever runs next.
  await pool.query(
    `update public.rate_limit_policies
        set max_requests = $1, window_seconds = $2
      where category = 'network_discovery'`,
    [DISCOVERY_MAX, DISCOVERY_WINDOW],
  );
  await clearCounters();
  await pool.query(`delete from public.network_profiles where id = $1`, [
    PROFILE,
  ]);
  await destroyFixtures(fx);
});

describe("the 31st network-directory read in a minute is refused", () => {
  it("is metered at SECURITY.md § 5's numbers, read from the seed", () => {
    // Not a restatement of the table -- a binding. If the seed ever drifts
    // from § 5 the psql suite's § RV catches it; if THIS test's arithmetic
    // ever stopped tracking the seed, the burst below would stop landing on
    // the boundary it claims to measure.
    expect(DISCOVERY_MAX).toBe(30);
    expect(DISCOVERY_WINDOW).toBe(60);
  });

  it("allows exactly 30 and refuses the 31st, with a usable retry hint", async () => {
    await clearCounters();
    await waitForFreshWindow(DISCOVERY_WINDOW, 25);

    for (let i = 1; i <= DISCOVERY_MAX; i += 1) {
      const page = await loadNetworkDirectory({});
      expect(
        page.outcome,
        `request ${i} of ${DISCOVERY_MAX} was refused; the budget is ` +
          `smaller than SECURITY.md § 5 says, or a counter from another ` +
          `test in this file leaked into this window`,
      ).toBe("loaded");
    }

    const refused = await loadNetworkDirectory({});
    expect(refused.outcome).toBe("rate_limited");
    if (refused.outcome !== "rate_limited") throw new Error("unreachable");
    // The hint is the remainder of a real 60-second bin, so it is bounded by
    // the window and strictly positive -- rendered to a person as
    // "try again in N seconds" by components/list/rate-limit-notice.tsx.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(DISCOVERY_WINDOW);
  });

  it("kept counting past the limit — the refusal is counted too", async () => {
    // 20260909020000's header: request_count measures PRESSURE, not permitted
    // traffic. It is also what makes the alert exactly-once, so this is not
    // cosmetic -- a limiter that clamped at 30 would file its alert on every
    // subsequent refusal.
    expect(await counterCount()).toBe(DISCOVERY_MAX + 1);
    await loadNetworkDirectory({});
    expect(await counterCount()).toBe(DISCOVERY_MAX + 2);
  });

  it("filed exactly ONE incident alert for the crossing, not one per refusal", async () => {
    expect(await tripAlertCount()).toBe(1);
    const { rows } = await pool.query(
      `select alert_type, summary, details, resolved_at, notified_at
         from public.incident_alerts
        where alert_type = 'rate_limit_tripped'
          and details->>'subject_id' = $1`,
      [subjectId],
    );
    expect(rows[0].details.category).toBe("network_discovery");
    // Open and undelivered: `notified_at` is the seam Task 6's Brevo sender
    // stamps. An alert that arrived already stamped would be silently
    // un-emailable.
    expect(rows[0].resolved_at).toBeNull();
    expect(rows[0].notified_at).toBeNull();
  });

  it("did NOT spend the SEARCH budget — the two are separate, as § 5 requires", async () => {
    // The whole point of naming the discovery path separately
    // (FOLLOW-UPS:3408-3419). With discovery exhausted, a search-carrying
    // TENANT list must still load: folding the two budgets together would
    // have taken the CRM down with the directory, and sizing one budget for
    // both would have given the O(platform) path a 60/min allowance.
    const params = parseListParams(CONTACT_LIST, { q: "a" });
    // NOT VACUOUS: a list with an EMPTY search term is deliberately unmetered
    // (a plain browse is O(page)), so if the spec's param key ever changed
    // under this call the request would be unmetered and the assertion below
    // would pass without testing anything. Pin the term first.
    expect(params.q, "the search term did not survive parseListParams").toBe(
      "a",
    );

    const page = await fetchListPage<
      ContactRow,
      keyof (typeof CONTACT_LIST)["sort"],
      keyof (typeof CONTACT_LIST)["filters"]
    >({
      spec: CONTACT_LIST,
      params,
      organisationId: fx.orgA.id,
      table: "contacts",
      select: CONTACT_SELECT,
      mapRow: (row) => row as unknown as ContactRow,
    });
    expect(page.outcome).toBe("loaded");

    // ...and it really did spend the OTHER budget, so "separate" is measured
    // rather than inferred from the discovery counter not moving.
    const { rows } = await pool.query(
      `select request_count from public.rate_limit_counters
        where category = 'search' and subject_scope = 'user' and subject_id = $1`,
      [subjectId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].request_count)).toBe(1);
  });
});

describe("the budget recovers when the window turns over", () => {
  // DRIVEN BY THE REAL CLOCK, not by rewriting window_start. Rolling the
  // counter row back would prove only that a row with a stale key is ignored;
  // what has to be true is that the SAME subject, making the SAME call, is
  // allowed again once wall-clock time crosses a bin boundary. So the policy
  // is narrowed to a 2-second window for the length of this test and the test
  // actually waits -- the arithmetic under test is identical at 2 seconds and
  // at 60, and § RW pins that independently at 60, 900 and 3600.
  it("refuses at the limit, then allows again in the next bin", async () => {
    const NARROW_WINDOW = 2;
    const NARROW_MAX = 2;
    try {
      await pool.query(
        `update public.rate_limit_policies
            set max_requests = $1, window_seconds = $2
          where category = 'network_discovery'`,
        [NARROW_MAX, NARROW_WINDOW],
      );
      await clearCounters();
      await waitForFreshWindow(NARROW_WINDOW, 1.2);

      for (let i = 1; i <= NARROW_MAX; i += 1) {
        expect(
          (await loadNetworkDirectory({})).outcome,
          `narrowed-window request ${i} should be inside the budget`,
        ).toBe("loaded");
      }
      const refused = await loadNetworkDirectory({});
      expect(refused.outcome).toBe("rate_limited");

      // Wait out the remainder of this bin, plus a margin.
      const used = (Date.now() / 1000) % NARROW_WINDOW;
      await new Promise((r) =>
        setTimeout(r, Math.ceil((NARROW_WINDOW - used) * 1000) + 300),
      );

      const recovered = await loadNetworkDirectory({});
      expect(
        recovered.outcome,
        "the same caller is still refused after the window turned over — " +
          "the budget is not recovering, which makes every limit permanent",
      ).toBe("loaded");
    } finally {
      await pool.query(
        `update public.rate_limit_policies
            set max_requests = $1, window_seconds = $2
          where category = 'network_discovery'`,
        [DISCOVERY_MAX, DISCOVERY_WINDOW],
      );
      await clearCounters();
    }
  });
});
