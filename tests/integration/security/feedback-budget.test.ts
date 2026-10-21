// THE FEEDBACK BUDGET AND ATTRIBUTION, DRIVEN THROUGH THE PATH THAT WOULD SKIP
// AN APP-SIDE METER: a real supabase-js client signed in as a real member,
// writing straight to PostgREST -- the request a script sends, never the form.
//
// Task 5's I2 was a budget enforced only in a server action against a table
// with a client INSERT grant; Task 5's I1 was a caller-supplied organisation
// reaching a platform table. `public.feedback` has a client INSERT grant and an
// organisation column, so both classes apply and both are asserted here from
// the attacker's position. The enforcement they meet is
// private.feedback_before_insert() (20260911000000), a BEFORE INSERT trigger.
//
// tests/integration/security/connection-request-budget.test.ts is the sibling
// and the template.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;
let MAX = 0;
let WINDOW = 0;

async function waitForFreshWindow(windowSeconds: number, needSeconds: number) {
  const remaining = windowSeconds - ((Date.now() / 1000) % windowSeconds);
  if (remaining >= needSeconds) return;
  await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 250));
}

async function counterCount(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `select request_count from public.rate_limit_counters
      where category = 'feedback' and subject_scope = 'user' and subject_id = $1`,
    [userId],
  );
  return rows.length === 0 ? 0 : Number(rows[0].request_count);
}

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
  const { rows } = await pool.query(
    `select max_requests, window_seconds from public.rate_limit_policies where category = 'feedback'`,
  );
  MAX = Number(rows[0].max_requests);
  WINDOW = Number(rows[0].window_seconds);
});

afterAll(async () => {
  if (fx) {
    const ids = fx._allUserIds;
    await pool.query(
      `delete from public.incident_alerts where details->>'category'='feedback' and details->>'subject_id' = any($1::text[])`,
      [ids],
    );
    await pool.query(`delete from public.audit_events where target_type='feedback' and actor_user_id = any($1::uuid[])`, [ids]);
    await pool.query(`delete from public.feedback where user_id = any($1::uuid[])`, [ids]);
    await pool.query(`delete from public.rate_limit_counters where category='feedback' and subject_id = any($1::uuid[])`, [ids]);
    await destroyFixtures(fx);
  }
});

describe("feedback over the raw PostgREST path", () => {
  // THE SAME SHAPE AS M10, IN THE OTHER FILE vitest.config.ts NAMES AS A KNOWN
  // FLAKE. `waitForFreshWindow(WINDOW, 60)` used to be called from the burst
  // test's own body, where its sleep -- up to 60 s, because with a 3600-second
  // window the head-room IS 60 s -- was charged to a 20 s `testTimeout`. It
  // only bites in the last minute of a wall-clock hour, roughly 1.7% of runs,
  // which is exactly why it has never been pinned down. A hook's wait is
  // charged to `hookTimeout`, not to a test's budget; the precedent is
  // connection-request-budget.test.ts:131. Hoisting it to the suite costs the
  // two tests before the burst nothing -- they run in well under a second, so
  // the bin this waits for is still fresh when the burst starts.
  beforeAll(async () => {
    await waitForFreshWindow(WINDOW, 60);
  }, 120_000);

  it("is metered at § 5's numbers", () => {
    expect(MAX).toBe(10);
    expect(WINDOW).toBe(3600);
  });

  it("attribution: the row is stamped from the session and the membership, and a forged workspace is refused", async () => {
    const persona = fx.activeByRole.booker;
    const { error } = await persona.client.from("feedback").insert({
      organisation_id: fx.orgA.id,
      category: "bug",
      message: "raw insert",
      route: "/org-a",
    });
    expect(error).toBeNull();

    const { rows } = await pool.query(
      `select user_id, user_email, organisation_role, status, notified_at
         from public.feedback where user_id = $1`,
      [persona.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_email).toBe(persona.email);
    expect(rows[0].organisation_role).toBe("booker");
    expect(rows[0].status).toBe("new");
    expect(rows[0].notified_at).toBeNull();

    // Naming user_id is refused at the column grant (42501), before any trigger.
    const forgedUser = await persona.client.from("feedback").insert({
      user_id: fx.superuser.userId,
      organisation_id: fx.orgA.id,
      category: "bug",
      message: "x",
      route: "/",
    });
    expect(forgedUser.error?.code).toBe("42501");

    // Naming org B, which this persona is no member of, is refused by the trigger.
    const forgedOrg = await persona.client.from("feedback").insert({
      organisation_id: fx.orgB.id,
      category: "bug",
      message: "x",
      route: "/",
    });
    expect(forgedOrg.error?.code).toBe("42501");

    // Neither refusal spent budget: the counter reads exactly the one accepted row.
    expect(await counterCount(persona.userId)).toBe(1);

    // Fix round 1 (I1): the pre-check the app runs before any Storage I/O is a
    // READ of that same counter, from the caller's own session -- and it
    // reports the caller's budget, not a parameter's.
    const budget = await persona.client.rpc("feedback_budget_remaining").single();
    expect(budget.error).toBeNull();
    expect((budget.data as { remaining: number }).remaining).toBe(MAX - 1);
    // Reading it spent nothing.
    expect(await counterCount(persona.userId)).toBe(1);

    // M1: a DECLARED screenshot with no object behind it is refused at the
    // trigger, verdict and all -- the row cannot say "clean" about bytes that
    // do not exist. The key passes the shape CHECK (it is this row's own id).
    const declaredId = crypto.randomUUID();
    const declared = await persona.client.from("feedback").insert({
      id: declaredId,
      organisation_id: fx.orgA.id,
      category: "bug",
      message: "declared screenshot",
      route: "/",
      screenshot_key: `feedback/${declaredId}`,
      screenshot_mime: "image/png",
      screenshot_size_bytes: 10,
      screenshot_scan_status: "clean",
      screenshot_scanned_at: new Date().toISOString(),
    });
    expect(declared.error?.code).toBe("42501");
    expect(await counterCount(persona.userId), "a refused declaration spends nothing").toBe(1);

    // And the submitter reads nothing back, their own row included.
    const { data } = await persona.client.from("feedback").select("id");
    expect(data).toEqual([]);
  });

  it("allows exactly ten raw inserts in the hour, then refuses the eleventh with PT429 and stops counting", async () => {
    const persona = fx.activeByRole.standard_user;

    for (let i = 1; i <= MAX; i += 1) {
      const { error } = await persona.client.from("feedback").insert({
        organisation_id: fx.orgA.id,
        category: "idea",
        message: `burst ${i}`,
        route: "/org-a",
      });
      expect(error, `insert ${i} must be accepted`).toBeNull();
    }

    const eleventh = await persona.client.from("feedback").insert({
      organisation_id: fx.orgA.id,
      category: "idea",
      message: "eleventh",
      route: "/org-a",
    });
    expect(eleventh.error?.code).toBe("PT429");
    // The remaining seconds ride in `hint`, for formatRetryAfter().
    expect(Number(eleventh.error?.hint)).toBeGreaterThan(0);
    expect(Number(eleventh.error?.hint)).toBeLessThanOrEqual(WINDOW);

    // Fix round 1 (I1): the app's pre-check now reads 0 for this session, with
    // the same remainder the trigger put in `hint` -- so the refusal it
    // renders BEFORE touching storage is the same sentence.
    const spent = await persona.client.rpc("feedback_budget_remaining").single();
    expect(spent.error).toBeNull();
    const budget = spent.data as { remaining: number; retry_after_seconds: number };
    expect(budget.remaining).toBe(0);
    expect(budget.retry_after_seconds).toBeGreaterThan(0);
    expect(budget.retry_after_seconds).toBeLessThanOrEqual(WINDOW);

    const { rows } = await pool.query(`select count(*)::int as n from public.feedback where user_id = $1`, [persona.userId]);
    expect(rows[0].n).toBe(MAX);
    expect(await counterCount(persona.userId)).toBe(MAX);

    const alerts = await pool.query(
      `select organisation_id, details from public.incident_alerts
        where alert_type = 'rate_limit_tripped' and details->>'category' = 'feedback' and details->>'subject_id' = $1`,
      [persona.userId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].organisation_id).toBeNull();
    expect(alerts.rows[0].details.subject_scope).toBe("user");
  });

  it("the budget read is a session's own: anon has no EXECUTE on it", async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon', 'public.feedback_budget_remaining()', 'EXECUTE') as anon,
              has_function_privilege('service_role', 'public.feedback_budget_remaining()', 'EXECUTE') as svc,
              has_function_privilege('authenticated', 'public.feedback_budget_remaining()', 'EXECUTE') as authed`,
    );
    expect(rows[0]).toEqual({ anon: false, svc: false, authed: true });
  });
});
