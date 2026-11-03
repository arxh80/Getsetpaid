// Q79/Q112'S CONNECTION-REQUEST BUDGET, DRIVEN THROUGH THE PATH THAT USED TO
// SKIP IT.
//
// ===========================================================================
// WHY THIS FILE EXISTS (fix round 1, review finding I2)
// ===========================================================================
// The budget shipped as a `consumeRateLimit()` call inside
// `sendConnectionRequestAction` -- and `public.network_connection_requests`
// carries an INSERT grant for `authenticated` plus a permissive INSERT policy.
// So the actor Q79's mitigation targets, a user who legitimately holds
// `manage_network_connections` in a publishing workspace, could
// `POST /rest/v1/network_connection_requests` with the anon key and a session
// JWT, unlimited, and never load the application. No counter moved, so no
// `rate_limit_tripped` alert was written either: the harasser worth detecting
// was the one the operator could not see.
//
// EVERY INSERT BELOW IS THAT BYPASS. Not the server action, not a mocked
// client -- a real supabase-js client signed in as a real member, writing
// straight to PostgREST, which is exactly the request an abuser's script would
// send. The enforcement it now meets is `private.meter_connection_request()`
// (`20260909060000`), a BEFORE INSERT trigger, so the budget binds this path
// and the app's own form identically.
//
// AGAINST THE OLD CODE every insert here succeeds and no alert exists.
//
// ===========================================================================
// ELEVEN TARGETS, NOT ELEVEN SENDS TO ONE
// ===========================================================================
// `network_connection_requests_live_pair` (Q79, narrowed by `20260907000000`)
// makes a second pending request to the SAME profile pair a 23505. Eleven
// distinct published profiles in the receiving workspace is what makes each
// send legal on every ground except the budget, so a refusal can only be the
// budget.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  type RlsFixtures,
} from "../rls/support/fixtures";

let fx: RlsFixtures;
let pool: Pool;

let fromProfileId = "";
const toProfileIds: string[] = [];

/** SECURITY.md § 5's own numbers, read from the seed rather than typed. */
let MAX = 0;
let WINDOW = 0;

/**
 * Windows are epoch-aligned (`private.rate_limit_window_start()`), so a burst
 * that straddled the hour boundary would split across two counters and never
 * reach its own limit -- a flake with a perfectly good explanation, which is
 * the worst kind. The burst takes a couple of seconds; this refuses to start
 * one without half a minute of the bin left.
 */
async function waitForFreshWindow(windowSeconds: number, needSeconds: number) {
  const remaining = windowSeconds - ((Date.now() / 1000) % windowSeconds);
  if (remaining >= needSeconds) return;
  await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 250));
}

async function counterCount(): Promise<number> {
  const { rows } = await pool.query(
    `select request_count from public.rate_limit_counters
      where category = 'network_connection_request'
        and subject_scope = 'organisation'
        and subject_id = $1`,
    [fx.orgA.id],
  );
  return rows.length === 0 ? 0 : Number(rows[0].request_count);
}

beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;

  // createFixtures() gives org A 'pro' and org B 'starter'; both permit
  // network_publish, so nothing here has to touch organisation_subscriptions.
  const company = await pool.query<{ id: string }>(
    `insert into public.companies (organisation_id, name)
     values ($1, 'Budget Sender Co') returning id`,
    [fx.orgA.id],
  );
  const sender = await pool.query<{ id: string }>(
    `insert into public.network_profiles
       (organisation_id, entity_kind, entity_id, status, display_name,
        field_visibility, published_at)
     values ($1, 'company', $2, 'published', 'Budget Sender Co',
             '{}'::jsonb, now())
     returning id`,
    [fx.orgA.id, company.rows[0]!.id],
  );
  fromProfileId = sender.rows[0]!.id;

  for (let i = 0; i < 12; i += 1) {
    const target = await pool.query<{ id: string }>(
      `insert into public.companies (organisation_id, name)
       values ($1, $2) returning id`,
      [fx.orgB.id, `Budget Target ${i}`],
    );
    const profile = await pool.query<{ id: string }>(
      `insert into public.network_profiles
         (organisation_id, entity_kind, entity_id, status, display_name,
          field_visibility, published_at)
       values ($1, 'company', $2, 'published', $3, '{}'::jsonb, now())
       returning id`,
      [fx.orgB.id, target.rows[0]!.id, `Budget Target ${i}`],
    );
    toProfileIds.push(profile.rows[0]!.id);
  }

  const { rows } = await pool.query(
    `select max_requests, window_seconds from public.rate_limit_policies
      where category = 'network_connection_request'`,
  );
  MAX = Number(rows[0].max_requests);
  WINDOW = Number(rows[0].window_seconds);

  await pool.query(
    `delete from public.rate_limit_counters where subject_id = $1`,
    [fx.orgA.id],
  );
  await pool.query(
    `delete from public.incident_alerts where details->>'subject_id' = $1`,
    [fx.orgA.id],
  );

  await waitForFreshWindow(WINDOW, 30);
}, 180_000);

afterAll(async () => {
  if (!fx) return;
  await pool.query(
    `delete from public.rate_limit_counters where subject_id = $1`,
    [fx.orgA.id],
  );
  await destroyFixtures(fx);
});

describe("a direct PostgREST INSERT is metered by the same budget the form is", () => {
  it("is metered at SECURITY.md § 5's numbers, read from the seed", () => {
    expect(MAX).toBe(10);
    expect(WINDOW).toBe(3600);
  });

  it("allows exactly ten, then refuses the eleventh with a 429-shaped error", async () => {
    for (let i = 0; i < MAX; i += 1) {
      const { error } = await fx.ownerA.client
        .from("network_connection_requests")
        .insert({
          from_organisation_id: fx.orgA.id,
          from_network_profile_id: fromProfileId,
          to_network_profile_id: toProfileIds[i],
        });
      expect(
        error,
        `request ${i + 1} of ${MAX} was refused (${error?.code}: ${error?.message}) ` +
          `-- the budget is smaller than SECURITY.md § 5 says, or a counter leaked in`,
      ).toBeNull();
    }

    const { error } = await fx.ownerA.client
      .from("network_connection_requests")
      .insert({
        from_organisation_id: fx.orgA.id,
        from_network_profile_id: fromProfileId,
        to_network_profile_id: toProfileIds[MAX],
      });

    // AGAINST THE OLD CODE this is `null` -- the whole finding in one line.
    expect(error, "the eleventh direct INSERT must be refused").not.toBeNull();
    // PT429 is PostgREST's "return this HTTP status" escape, so a scripted
    // caller gets a real 429 and the server action gets a code it can tell
    // apart from 42501 (unreachable profile) and 23505 (a live request stands).
    expect(error?.code).toBe("PT429");
    // The seconds left in the window ride in `hint`, which is what lets the
    // refusal copy render a human duration without re-deriving the window
    // arithmetic in TypeScript.
    const retry = Number.parseInt(error?.hint ?? "", 10);
    expect(Number.isFinite(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(WINDOW);
  }, 60_000);

  it("wrote exactly ten rows — the refused one is not in the table", async () => {
    const { rows } = await pool.query(
      `select count(*)::int as n from public.network_connection_requests
        where from_organisation_id = $1`,
      [fx.orgA.id],
    );
    expect(rows[0].n).toBe(MAX);
  });

  it("filed exactly one rate_limit_tripped alert, attributed to the SENDING workspace", async () => {
    const { rows } = await pool.query(
      `select organisation_id, resolved_at, notified_at, details
         from public.incident_alerts
        where alert_type = 'rate_limit_tripped'
          and details->>'subject_id' = $1`,
      [fx.orgA.id],
    );
    // The first operator-visible signal of network harassment the product has:
    // before this, a scripted sender produced no row anywhere.
    expect(rows).toHaveLength(1);
    expect(rows[0].organisation_id).toBe(fx.orgA.id);
    expect(rows[0].resolved_at).toBeNull();
    expect(rows[0].notified_at).toBeNull();
    expect(rows[0].details.subject_scope).toBe("organisation");
  });

  it("stops counting at the limit — stated, because every other category does not (Q115)", async () => {
    // 20260909020000's counters measure PRESSURE: a refusal increments too, so
    // "4,000 in a 30-limit window" is readable. This path cannot do that. A
    // refused INSERT must RAISE, and a raise rolls back its own increment, so
    // the counter is deliberately read BEFORE the write and the refusal writes
    // nothing at all. The number here means "hit the ceiling", not "tried n
    // times", and this assertion is what stops that difference being silently
    // forgotten.
    expect(await counterCount()).toBe(MAX);
  });

  it("does not spend the RECEIVING workspace's budget", async () => {
    const { rows } = await pool.query(
      `select count(*)::int as n from public.rate_limit_counters
        where category = 'network_connection_request' and subject_id = $1`,
      [fx.orgB.id],
    );
    expect(rows[0].n).toBe(0);
  });
});
