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

    // And the submitter reads nothing back, their own row included.
    const { data } = await persona.client.from("feedback").select("id");
    expect(data).toEqual([]);
  });

  it("allows exactly ten raw inserts in the hour, then refuses the eleventh with PT429 and stops counting", async () => {
    await waitForFreshWindow(WINDOW, 60);
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
});
