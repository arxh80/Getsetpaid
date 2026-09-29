// THE ATOMIC INCREMENT, MEASURED UNDER REAL CONCURRENCY.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHY IT IS AT THIS EXACT PATH
// ===========================================================================
// `20260909020000`'s core carries this comment above its upsert:
//
//   -- THE ATOMIC INCREMENT. ON CONFLICT serialises concurrent callers on the
//   -- row: two simultaneous requests get counts n and n+1, never both n
//   -- (tests/integration/rls/rate-limits.test.ts fires ten in parallel and
//   -- asserts the final count is exactly ten).
//
// That file did not exist. The claim is almost certainly true -- `ON CONFLICT
// DO UPDATE` does take a row lock -- but it was unmeasured, and a migration is
// immutable, so a citation to a file nobody wrote is permanent and sends the
// next reader looking for it. Task 5's brief asked for "concurrent increment
// semantics as implemented" in as many words (Requirement 6) and the first
// round covered boundary and reset and not this.
//
// So the file is written AT THE PATH THE SHIPPED COMMENT NAMES, doing what the
// shipped comment says, and `20260909090000` reissues the function's own
// `comment on` to say precisely what is asserted here rather than only how
// many callers fire.
//
// ===========================================================================
// AGAINST THE REAL MECHANISM, NOT A MODEL OF IT
// ===========================================================================
// The calls below are `private.record_rate_limit_event()` itself -- the
// function every consumer reaches, where the upsert lives -- over N SEPARATE
// POSTGRES CONNECTIONS, acquired and held before the burst starts so the
// concurrency is real rather than a queue behind one connection warming up.
// The subject is a synthetic uuid, so nothing here can collide with another
// suite's counters.
//
// The strong assertion is not "the final count is ten" (an implementation that
// lost an update and then double-counted could reach ten). It is that the ten
// callers received TEN DISTINCT counts, 1 through 10 -- which is exactly the
// "never both n" the comment claims, and is what a lost update breaks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { getLocalSupabaseStatus } from "./support/env";

const CATEGORY = "search";
/** A subject nothing else in the repository writes -- these assertions are
 *  about the increment, and a stray counter from another suite would fail them
 *  for a reason that has nothing to do with what they measure. */
const SUBJECT = "00000000-0000-4000-8000-0000000000c1";

let pool: Pool;
let MAX = 0;
let WINDOW = 0;

/** Windows are epoch-aligned, so a burst that straddled a bin boundary would
 *  split across two counters and never reach the number it asserts. */
async function waitForFreshWindow(windowSeconds: number, needSeconds: number) {
  const remaining = windowSeconds - ((Date.now() / 1000) % windowSeconds);
  if (remaining >= needSeconds) return;
  await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 250));
}

async function clear() {
  await pool.query(`delete from public.rate_limit_counters where subject_id = $1`, [
    SUBJECT,
  ]);
  await pool.query(
    `delete from public.incident_alerts where details->>'subject_id' = $1`,
    [SUBJECT],
  );
}

async function counterCount(): Promise<number> {
  const { rows } = await pool.query(
    `select request_count from public.rate_limit_counters
      where category = $1 and subject_scope = 'user' and subject_id = $2`,
    [CATEGORY, SUBJECT],
  );
  return rows.length === 0 ? 0 : Number(rows[0].request_count);
}

/** One call of the real core, on one dedicated connection. */
async function consumeOn(
  client: PoolClient,
): Promise<{ allowed: boolean; count: number }> {
  const { rows } = await client.query(
    `select allowed, request_count
       from private.record_rate_limit_event($1, 'user', $2)`,
    [CATEGORY, SUBJECT],
  );
  return {
    allowed: rows[0].allowed as boolean,
    count: Number(rows[0].request_count),
  };
}

beforeAll(async () => {
  pool = new Pool({
    connectionString: getLocalSupabaseStatus().dbUrl,
    max: 24,
  });
  const { rows } = await pool.query(
    `select max_requests, window_seconds from public.rate_limit_policies
      where category = $1`,
    [CATEGORY],
  );
  MAX = Number(rows[0].max_requests);
  WINDOW = Number(rows[0].window_seconds);
  await clear();
}, 60_000);

afterAll(async () => {
  if (!pool) return;
  await clear();
  await pool.end();
});

describe("concurrent increments on one counter row", () => {
  it("gives ten simultaneous callers ten DISTINCT counts, and lands on exactly ten", async () => {
    await clear();
    await waitForFreshWindow(WINDOW, 20);

    // Held before the burst, so all ten are already connected and authenticated
    // when the first query goes out -- otherwise the "parallelism" is ten
    // connection handshakes in a row.
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.connect()),
    );
    try {
      const results = await Promise.all(clients.map((c) => consumeOn(c)));
      const counts = results.map((r) => r.count).sort((a, b) => a - b);
      // THE ASSERTION THE MIGRATION COMMENT IS ABOUT: no two callers saw the
      // same n. A lost update shows up here as a duplicate, and would show up
      // in production as a budget that quietly permits more than it says.
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(new Set(counts).size).toBe(10);
    } finally {
      for (const c of clients) c.release();
    }

    expect(await counterCount()).toBe(10);
  }, 30_000);

  it("crosses its limit exactly once under a parallel burst — one refusal, one alert", async () => {
    await clear();
    await waitForFreshWindow(WINDOW, 25);

    // MAX + 1 callers at once. Exactly one of them must be the crossing: the
    // exactly-once alert-at-max+1 write is the property the whole alerting
    // half of Task 5 rests on, and a race that let two callers both observe
    // max + 1 would file two alerts for one crossing.
    const results = await Promise.all(
      Array.from({ length: MAX + 1 }, () =>
        pool.connect().then(async (c) => {
          try {
            return await consumeOn(c);
          } finally {
            c.release();
          }
        }),
      ),
    );

    const refused = results.filter((r) => !r.allowed);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.count).toBe(MAX + 1);
    expect(new Set(results.map((r) => r.count)).size).toBe(MAX + 1);
    expect(await counterCount()).toBe(MAX + 1);

    const { rows } = await pool.query(
      `select count(*)::int as n from public.incident_alerts
        where alert_type = 'rate_limit_tripped'
          and details->>'subject_id' = $1`,
      [SUBJECT],
    );
    expect(rows[0].n).toBe(1);
  }, 60_000);
});
