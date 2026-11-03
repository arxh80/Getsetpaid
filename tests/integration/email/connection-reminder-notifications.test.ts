// THE CONNECTION-REQUEST AND TASK-REMINDER NOTICES AGAINST THE REAL DATABASE
// (founder 2026-09-30, Q157(3)/Q174/Q45; job 3, 20261016000000).
//
// The TRANSPORT is stubbed -- no test sends a real email -- and everything
// else is real: the service_role client, the two resolver RPCs, the stamp RPC
// and the private ledger. Per notice:
//
//   1. STAMP ONLY AFTER ok:true. The stub reads the ledger AT THE MOMENT OF
//      THE SEND; it must hold no row for that notice then, and one after.
//   2. A FAILED SEND LEAVES IT UNSTAMPED, AND THE NEXT TICK RETRIES IT.
//   3. NOTHING IS SENT TWICE.
//   4. RECIPIENTS: a request org B sends org A is announced to org A's
//      active Owner and Admin, nobody else; its decline is told to org B's
//      sender; a reminder goes to the assignee, and NOT for a completed task.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";

interface SentMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  ledgerAtSend: number;
}

const transport = vi.hoisted(() => ({
  ok: false,
  sent: [] as SentMail[],
  probe: null as null | (() => Promise<number>),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: { email: string }[]; bcc?: { email: string }[]; subject: string; text: string; html: string }) => {
    const ledgerAtSend = transport.probe ? await transport.probe() : -1;
    transport.sent.push({
      // Everybody the message reaches; m5's To-vs-Bcc split is unit-tested.
      to: [...input.to, ...(input.bcc ?? [])].map((t) => t.email).sort(),
      subject: input.subject,
      text: input.text,
      html: input.html,
      ledgerAtSend,
    });
    return transport.ok ? { ok: true, messageId: "stub" } : { ok: false, error: "stubbed Brevo 503" };
  },
}));

let fx: RlsFixtures;
let pool: Pool;
let mod: typeof import("@/lib/email/network-notifications");
let reminders: typeof import("@/lib/email/task-reminder-notifications");

const profileA = crypto.randomUUID();
const profileB = crypto.randomUUID();
const requestId = crypto.randomUUID();
const taskDue = crypto.randomUUID();
const taskDone = crypto.randomUUID();

async function ledger(notice: string, column: "request_id" | "task_id", id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from private.notification_deliveries where notice = $1 and ${column} = $2`,
    [notice, id],
  );
  return rows[0].n;
}

function mine(predicate: (m: SentMail) => boolean): SentMail[] {
  return transport.sent.filter(predicate);
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  vi.spyOn(console, "error").mockImplementation(() => {});

  mod = await import("@/lib/email/network-notifications");
  reminders = await import("@/lib/email/task-reminder-notifications");
  fx = await createFixtures();
  pool = fx._pool;

  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(
      `insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, status, display_name, published_at)
       values ($1, $2, 'venue', gen_random_uuid(), 'published', 'Org A Published Venue', now()),
              ($3, $4, 'venue', gen_random_uuid(), 'published', 'Org B Published Venue', now())`,
      [profileA, fx.orgA.id, profileB, fx.orgB.id],
    );
    await c.query(
      `insert into public.network_connection_requests
         (id, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id,
          status, requested_by, requested_at)
       values ($1, $2, $3, $4, $5, 'pending', $6, now())`,
      [requestId, fx.orgB.id, profileB, fx.orgA.id, profileA, fx.ownerB.userId],
    );
    const assignee = fx.activeByRole.manager.userId;
    await c.query(
      `insert into public.tasks (id, organisation_id, owner_user_id, title, detail, status, reminder_at, completed_at)
       values ($1, $3, $4, 'Send the rider', 'PRIVATE TASK DETAIL', 'open', now() - interval '5 minutes', null),
              ($2, $3, $4, 'Already done', null, 'done', now() - interval '5 minutes', now())`,
      [taskDue, taskDone, fx.orgA.id, assignee],
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
      await c.query("delete from private.notification_deliveries where request_id = $1 or task_id = any($2::uuid[])", [
        requestId,
        [taskDue, taskDone],
      ]);
      await c.query("delete from public.network_connection_requests where id = $1", [requestId]);
      await c.query("delete from public.network_profiles where id = any($1::uuid[])", [[profileA, profileB]]);
      await c.query("delete from public.tasks where id = any($1::uuid[])", [[taskDue, taskDone]]);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
  if (fx) await destroyFixtures(fx);
});

const isReceived = (m: SentMail) => m.subject === "Org B Published Venue wants to connect on GetSetPaid";

describe("connection request received -> the requested workspace's Owner and Admin", () => {
  it("a FAILED send stamps nothing", async () => {
    transport.ok = false;
    transport.sent = [];
    transport.probe = () => ledger("connection_received", "request_id", requestId);
    await mod.deliverConnectionRequestNotifications();
    expect(mine(isReceived)).toHaveLength(1);
    expect(await ledger("connection_received", "request_id", requestId)).toBe(0);
  });

  it("the next tick retries, to exactly org A's active Owner and Admin, stamping only AFTER ok:true", async () => {
    transport.ok = true;
    transport.sent = [];
    transport.probe = () => ledger("connection_received", "request_id", requestId);
    await mod.deliverConnectionRequestNotifications();
    const [mail] = mine(isReceived);
    expect(mail).toBeDefined();
    expect(mail.to).toEqual([fx.activeByRole.admin.email, fx.ownerA.email].sort());
    expect(mail.ledgerAtSend).toBe(0);
    expect(await ledger("connection_received", "request_id", requestId)).toBe(1);
    // The other side is never addressed, and no member address of either side is in the body.
    const body = `${mail.subject}${mail.text}${mail.html}`;
    expect(mail.to).not.toContain(fx.ownerB.email);
    expect(body).not.toContain(fx.ownerB.email);
    expect(body).toContain(`/${fx.orgA.slug}/network/requests`);
  });

  it("a third tick sends nothing for it", async () => {
    transport.sent = [];
    await mod.deliverConnectionRequestNotifications();
    expect(mine(isReceived)).toHaveLength(0);
  });
});

describe("connection request declined -> the sender", () => {
  it("is told to org B's sender only, names the published profile, and nothing else", async () => {
    await pool.query(
      `update public.network_connection_requests set status = 'declined', responded_at = now(), responded_by = $2 where id = $1`,
      [requestId, fx.ownerA.userId],
    );
    transport.ok = true;
    transport.sent = [];
    transport.probe = () => ledger("connection_declined", "request_id", requestId);
    await mod.deliverConnectionRequestNotifications();
    const [mail] = mine((m) => m.subject === "Your connection request to Org A Published Venue was declined");
    expect(mail).toBeDefined();
    expect(mail.to).toEqual([fx.ownerB.email]);
    expect(mail.ledgerAtSend).toBe(0);
    expect(await ledger("connection_declined", "request_id", requestId)).toBe(1);
    const body = `${mail.subject}${mail.text}${mail.html}`;
    expect(body).not.toContain(fx.ownerA.email);
    expect(body).not.toContain(fx.ownerA.userId);
    expect(body).toContain(`/${fx.orgB.slug}/network/requests`);
  });
});

describe("task reminder -> the assignee", () => {
  const isReminder = (m: SentMail) => m.subject === "Reminder: Send the rider";
  const isDone = (m: SentMail) => m.subject === "Reminder: Already done";

  it("fails, then retries and stamps after ok:true, then never again; a completed task is never reminded", async () => {
    transport.probe = () => ledger("task_reminder", "task_id", taskDue);
    transport.ok = false;
    transport.sent = [];
    await reminders.deliverTaskReminderNotifications();
    expect(mine(isReminder)).toHaveLength(1);
    expect(await ledger("task_reminder", "task_id", taskDue)).toBe(0);

    transport.ok = true;
    transport.sent = [];
    await reminders.deliverTaskReminderNotifications();
    const [mail] = mine(isReminder);
    expect(mail.to).toEqual([fx.activeByRole.manager.email]);
    expect(mail.ledgerAtSend).toBe(0);
    expect(await ledger("task_reminder", "task_id", taskDue)).toBe(1);
    expect(`${mail.text}${mail.html}`).not.toContain("PRIVATE TASK DETAIL");
    expect(mail.text).toContain(`/${fx.orgA.slug}/tasks/${taskDue}`);
    expect(mine(isDone)).toHaveLength(0);
    expect(await ledger("task_reminder", "task_id", taskDone)).toBe(0);

    transport.sent = [];
    await reminders.deliverTaskReminderNotifications();
    expect(mine(isReminder)).toHaveLength(0);
  });
});
