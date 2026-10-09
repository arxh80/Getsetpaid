// TASK 9b REVIEW I2 AGAINST THE REAL DATABASE: ONE WORKSPACE CANNOT STARVE
// THE NOTICE QUEUE (20261018000000).
//
// The finding: the reminder resolver returned the 30 OLDEST owed reminders
// platform-wide, and a reminder whose builder threw stamped nothing and was
// offered again on every tick. So 30 poison rows from one workspace held the
// head of the queue for seven days.
//
// Since I3 no PERSON'S TEXT makes a builder throw, so the poison is planted
// the only way left: the builder is wrapped to refuse any title starting
// "POISON" -- standing in for whatever invariant may refuse a render in
// future. Everything else is real: the service_role client, the resolver,
// both ledger RPCs and private.notification_deliveries.
//
//   * FAIRNESS: 31 poison reminders in workspace A, all OLDER than workspace
//     B's one good reminder. B's email goes in the SAME tick.
//   * TERMINAL: every poison row is recorded `undeliverable`/`content_refused`
//     once and is never offered again; none is ever sent.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

const transport = vi.hoisted(() => ({ sent: [] as Array<{ to: string[]; subject: string }> }));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: { email: string }[]; bcc?: { email: string }[]; subject: string }) => {
    transport.sent.push({
      to: [...input.to, ...(input.bcc ?? [])].map((t) => t.email).sort(),
      subject: input.subject,
    });
    return { ok: true, messageId: "stub" };
  },
}));

vi.mock("@/lib/email/task-reminder-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/task-reminder-template")>();
  const { NoticeContentError } = await import("@/lib/email/requester-templates");
  return {
    ...actual,
    buildTaskReminderNotice: (input: Parameters<typeof actual.buildTaskReminderNotice>[0]) => {
      if (input.title.startsWith("POISON")) throw new NoticeContentError("taskReminder notice refused: planted poison");
      return actual.buildTaskReminderNotice(input);
    },
  };
});

let fx: RlsFixtures;
let pool: Pool;
let reminders: typeof import("@/lib/email/task-reminder-notifications");

const POISON_COUNT = 31;
const poisonIds = Array.from({ length: POISON_COUNT }, () => crypto.randomUUID());
const goodB = crypto.randomUUID();
const allIds = [...poisonIds, goodB];

async function ledgerFor(ids: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ v: string }>(
    `select outcome || ':' || coalesce(reason, '-') as v from private.notification_deliveries
      where notice = 'task_reminder' and task_id = any($1::uuid[]) order by 1`,
    [ids],
  );
  return rows.map((r) => r.v);
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  vi.spyOn(console, "error").mockImplementation(() => {});

  reminders = await import("@/lib/email/task-reminder-notifications");
  fx = await createFixtures();
  pool = fx._pool;

  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    // Workspace A's poison: every one OLDER than workspace B's good reminder.
    for (const [i, id] of poisonIds.entries()) {
      await c.query(
        `insert into public.tasks (id, organisation_id, owner_user_id, title, status, reminder_at)
         values ($1, $2, $3, $4, 'open', now() - interval '3 hours' + make_interval(secs => $5))`,
        [id, fx.orgA.id, fx.activeByRole.manager.userId, `POISON ${i}`, i],
      );
    }
    await c.query(
      `insert into public.tasks (id, organisation_id, owner_user_id, title, status, reminder_at)
       values ($1, $2, $3, 'Workspace B good reminder', 'open', now() - interval '1 minute')`,
      [goodB, fx.orgB.id, fx.ownerB.userId],
    );
    await c.query("commit");
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from private.notification_deliveries where task_id = any($1::uuid[])", [allIds]);
      await c.query("delete from public.tasks where id = any($1::uuid[])", [allIds]);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  if (fx) await destroyFixtures(fx);
});

describe("I2: 31 poison reminders in workspace A do not starve workspace B", () => {
  it("REACH: the resolver really owes all 32 before the tick (the poison is in the queue)", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.tasks t
        where t.id = any($1::uuid[])
          and not exists (select 1 from private.notification_deliveries d where d.task_id = t.id)`,
      [allIds],
    );
    expect(rows[0].n).toBe(POISON_COUNT + 1);
  });

  it("FAIRNESS: workspace B's reminder is sent in the SAME tick, ahead of A's older poison", async () => {
    transport.sent = [];
    const result = await reminders.deliverTaskReminderNotifications();
    expect(result.outcome).toBe("delivered");
    expect(transport.sent.map((m) => m.subject)).toContain("Reminder: Workspace B good reminder");
    expect(transport.sent.some((m) => m.subject.includes("POISON"))).toBe(false);
    expect(await ledgerFor([goodB])).toEqual(["delivered:-"]);
  });

  it("TERMINAL: every poison row is recorded undeliverable once and is never offered again", async () => {
    // Tick 1 took at most 29 of A's 31 (B held a slot); ticks drain the rest.
    for (let tick = 0; tick < 3; tick += 1) await reminders.deliverTaskReminderNotifications();
    expect(await ledgerFor(poisonIds)).toEqual(Array(POISON_COUNT).fill("undeliverable:content_refused"));

    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.pending_task_reminder_notifications(30) where task_id = any($1::uuid[])`,
      [allIds],
    );
    expect(rows[0].n).toBe(0);
    expect(transport.sent.some((m) => m.subject.includes("POISON"))).toBe(false);
    expect(transport.sent.filter((m) => m.subject === "Reminder: Workspace B good reminder")).toHaveLength(1);
  });
});
