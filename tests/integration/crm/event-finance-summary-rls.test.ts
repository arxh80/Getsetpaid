// public.event_finance_summary is a security_invoker view: a caller sees a
// row exactly when they could select the underlying financial_entries under
// financial_entries_select_view_finance. This test proves the two halves the
// finance panel depends on, at the DB layer the app's loadEventFinanceSummary
// reads:
//
//   POSITIVE CONTROL  a Finance caller (view_finance, aal2) gets the REAL sums,
//                     and they equal summariseFinanceEntries over the same rows
//                     (the TS mirror of the SQL mapping).
//   THE GATE          a Booker (view_crm, no view_finance) gets NO ROW -> the
//                     app renders all-zeros AND, critically, the panel is not
//                     shown at all (the page's view_finance render gate). This
//                     is the acceptance criterion "a Booker on the same event
//                     sees no finance panel and, if they hand-craft a PostgREST
//                     GET, an empty array".
//
// The view read is driven directly (not through loadEventFinanceSummary, which
// needs a Next server client and a signed-in session) because the SECURITY is
// the view, and the view is what that function reads verbatim -- the same
// philosophy as crm-write-access-matches-db.test.ts: drive the DB expression
// the app composes, under a real role and real claims, not a re-derivation.
//
// LOCAL ONLY, everything rolled back. env.ts refuses anything but the loopback
// stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { summariseFinanceEntries } from "@/lib/crm/finance-summary";
import type { FinanceCategory, FinanceStatus } from "@/lib/crm/finance-category";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

interface SummaryRow {
  budgeted_gross_minor: string;
  budgeted_expense_minor: string;
  actual_gross_minor: string;
  actual_expense_minor: string;
}

/** The fixed set of lines the fixture plants, and the denominator the test
 *  checks the view against. */
const LINES: {
  category: FinanceCategory;
  status: FinanceStatus;
  amountMinor: number;
}[] = [
  { category: "fee", status: "budgeted", amountMinor: 100000 },
  { category: "cost", status: "budgeted", amountMinor: 20000 },
  { category: "income", status: "budgeted", amountMinor: 150000 },
  { category: "fee", status: "actual", amountMinor: 110000 },
  { category: "income", status: "actual", amountMinor: 90000 },
  // A soft-deleted line the view must EXCLUDE (deleted_at is not null): if it
  // leaked in, budgeted_expense would be 20000 too high.
  { category: "cost", status: "budgeted", amountMinor: 999999 },
];

async function createUser(
  client: import("pg").PoolClient,
  email: string,
): Promise<string> {
  const {
    rows: [{ uid }],
  } = await client.query<{ uid: string }>(
    `insert into auth.users (id, instance_id, aud, role, email,
                             encrypted_password, email_confirmed_at,
                             created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
             'authenticated', 'authenticated',
             $1 || gen_random_uuid() || '@example.test',
             'x', now(), now(), now())
     returning id as uid`,
    [email],
  );
  return uid;
}

async function readAs(
  client: import("pg").PoolClient,
  uid: string,
  aal: "aal1" | "aal2",
  org: string,
  eventId: string,
): Promise<SummaryRow | null> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: uid, role: "authenticated", aal }),
  ]);
  const { rows } = await client.query<SummaryRow>(
    `select budgeted_gross_minor, budgeted_expense_minor,
            actual_gross_minor, actual_expense_minor
       from public.event_finance_summary
      where organisation_id = $1 and event_id = $2`,
    [org, eventId],
  );
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', '', true)");
  return rows[0] ?? null;
}

describe("event_finance_summary is gated by view_finance and drift-proof", () => {
  it("a Finance caller gets the real sums; a Booker gets no row", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");

      const financeUid = await createUser(client, "fin-");
      const bookerUid = await createUser(client, "book-");

      const {
        rows: [{ org }],
      } = await client.query<{ org: string }>(
        `insert into public.organisations (name, slug)
         values ('Finance probe', 'fin-' || replace(gen_random_uuid()::text, '-', ''))
         returning id as org`,
      );

      await client.query(
        `insert into public.organisation_memberships
           (organisation_id, user_id, role, status, joined_at)
         values ($1, $2, 'finance', 'active', now()),
                ($1, $3, 'booker',  'active', now())`,
        [org, financeUid, bookerUid],
      );

      const {
        rows: [{ eventid }],
      } = await client.query<{ eventid: string }>(
        `insert into public.events (organisation_id, owner_user_id, name, starts_at)
         values ($1, $2, 'Finance probe event', now())
         returning id as eventid`,
        [org, financeUid],
      );

      for (const line of LINES) {
        const deleted = line.amountMinor === 999999;
        await client.query(
          `insert into public.financial_entries
             (organisation_id, created_by, event_id, category, status,
              amount_minor, currency, occurred_on, deleted_at)
           values ($1, $2, $3, $4, $5, $6, 'GBP', current_date, $7)`,
          [
            org,
            financeUid,
            eventid,
            line.category,
            line.status,
            line.amountMinor,
            deleted ? new Date().toISOString() : null,
          ],
        );
      }

      // ---- POSITIVE CONTROL: the Finance caller sees the real sums ----------
      const financeRow = await readAs(client, financeUid, "aal2", org, eventid);
      expect(financeRow, "a Finance caller must see a summary row").not.toBeNull();

      // The denominator: the TS mirror over the LIVE lines only.
      const expected = summariseFinanceEntries(
        LINES.filter((line) => line.amountMinor !== 999999),
      );
      expect(Number(financeRow!.budgeted_gross_minor)).toBe(
        expected.budgetedGrossMinor,
      );
      expect(Number(financeRow!.budgeted_expense_minor)).toBe(
        expected.budgetedExpenseMinor,
      );
      expect(Number(financeRow!.actual_gross_minor)).toBe(
        expected.actualGrossMinor,
      );
      expect(Number(financeRow!.actual_expense_minor)).toBe(
        expected.actualExpenseMinor,
      );
      // Concretely: 150000 / 120000 / 90000 / 110000, with the soft-deleted
      // 999999 cost excluded (it would have made budgeted_expense 1119999).
      expect(Number(financeRow!.budgeted_expense_minor)).toBe(120000);

      // ---- THE GATE: the Booker sees no row --------------------------------
      const bookerRow = await readAs(client, bookerUid, "aal1", org, eventid);
      expect(
        bookerRow,
        "a Booker holds no view_finance, so the security_invoker view returns no row",
      ).toBeNull();
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});
