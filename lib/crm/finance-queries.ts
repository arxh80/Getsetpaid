import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  fetchListPage,
  type ListPage,
  type ListQuery,
} from "@/lib/list/query";
import type { RawSearchParams } from "@/lib/list/params";
import {
  FINANCIAL_ENTRY_LIST,
  FINANCIAL_ENTRY_SELECT,
  FINANCIAL_ENTRY_DELETED_SELECT,
  financeParams,
  mapFinancialEntryRow,
  type FinancialEntryRow,
  type FinancialEntryParams,
  type FinancialEntrySortKey,
  type FinancialEntryFilterKey,
} from "@/lib/crm/finance-list";
import { LINK_PANEL_LIMIT } from "@/lib/crm/queries";
import type { EventFinanceSummaryOutcome } from "@/lib/crm/finance-summary";
import type { FinanceCategory, FinanceStatus } from "@/lib/crm/finance-category";

// The event finance panel's reads: the line-item page (plus the removed rows
// under it and the linked-record names beside them), and the budget-vs-actuals
// summary.
//
// MODELLED ON `loadLineupForEvent` (lib/crm/queries.ts), because the finance
// panel is the same shape as the lineup panel: a paginated live list, a capped
// read of the soft-deleted rows for the restore disclosure, and a name lookup
// for the ids the rows carry. The three differences are stated where they
// occur -- two name maps rather than one (a finance line may link an artist AND
// a supplier contact), the summary is a second function reading a view, and
// there is no owner column anywhere (finance scope is role-based).

/** A soft-deleted finance line, for the restore disclosure. */
export interface RemovedFinancialEntry {
  id: string;
  eventId: string;
  category: FinanceCategory;
  status: FinanceStatus;
  amountMinor: number;
  currency: string;
  occurredOn: string;
  description: string | null;
  deletedAt: string;
}

/** A linked record's name, as the panel renders it. A missing id is one this
 *  caller cannot read -- the panel says so rather than showing a name. */
export interface LinkedName {
  name: string;
  deleted: boolean;
}

/** One raw deleted `financial_entries` row as `RemovedFinancialEntry`. A
 *  faithful projection of FINANCIAL_ENTRY_DELETED_SELECT. */
function mapRemoved(row: Record<string, unknown>): RemovedFinancialEntry {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    category: row.category as FinanceCategory,
    status: row.status as FinanceStatus,
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    occurredOn: String(row.occurred_on),
    description: (row.description as string | null) ?? null,
    deletedAt: String(row.deleted_at),
  };
}

/**
 * One event's finance lines: a page of the live ones, the removed rows under
 * them, and the artist/supplier names for both.
 *
 * ===========================================================================
 * FOUR QUERIES, AND THE NAME LOOKUP IS TWO OF THEM
 * ===========================================================================
 *   1. `fetchListPage` over `financial_entries`, keyset-paginated, live rows
 *      only (`applyScope` writes `deleted_at is null`), filtered to this event
 *      and to any category/status filter, sorted by `occurred_on desc`.
 *   2. A capped read of the REMOVED rows (bounded by LINK_PANEL_LIMIT, ordered
 *      before it caps), for the restore disclosure -- not paginated, for the
 *      reason `loadLineupForEvent` gives: a second lib/list/ surface here would
 *      need another query-string namespace and pager for a tail nobody scrolls.
 *   3 & 4. The artist names and the supplier-contact names, for the union of
 *      both sets' ids -- SECOND queries, not PostgREST embeds, for
 *      `loadLineupForEvent`'s two reasons (an embed would move the count line's
 *      HEAD request, and under RLS an embed of an unreadable row is null
 *      anyway). `deleted_at` is SELECTED, not filtered: this is a DETAIL page,
 *      so a deleted artist/contact is NAMED (marked) rather than hidden, and
 *      only its link is withheld -- the same choice `loadEvent` makes for a
 *      deleted venue.
 *
 * BOUNDED BY CONSTRUCTION: at most MAX_PAGE_SIZE (50) live ids plus
 * LINK_PANEL_LIMIT (100) removed ones per link type, so a name query carries at
 * most 150 uuids.
 */
export async function loadFinancialEntriesForEvent(
  organisationId: string,
  eventId: string,
  raw: RawSearchParams,
): Promise<{
  params: FinancialEntryParams;
  page: ListPage<FinancialEntryRow>;
  removed: readonly RemovedFinancialEntry[];
  artistNames: ReadonlyMap<string, LinkedName>;
  supplierNames: ReadonlyMap<string, LinkedName>;
}> {
  const params = financeParams(raw);
  const supabase = await createClient();

  const [page, removedResult] = await Promise.all([
    fetchListPage<
      FinancialEntryRow,
      FinancialEntrySortKey,
      FinancialEntryFilterKey
    >({
      spec: FINANCIAL_ENTRY_LIST,
      params,
      organisationId,
      table: "financial_entries",
      select: FINANCIAL_ENTRY_SELECT,
      mapRow: mapFinancialEntryRow,
      // event_id comes from the resolved route, never the query string. The
      // spec's category/status filters are DORMANT on the panel surface (see
      // financeParams' header: the panel has no toolbar and one empty state, so
      // an applied filter could show "No finance lines yet" over a full sheet),
      // so only the event is pinned -- the same shape as the lineup loader.
      applyFilters: (query: ListQuery) => query.eq("event_id", eventId),
    }),
    supabase
      .from("financial_entries")
      .select(FINANCIAL_ENTRY_DELETED_SELECT)
      .eq("organisation_id", organisationId)
      .eq("event_id", eventId)
      // ORDER BEFORE LIMIT: without it the hundred that survive the cap are a
      // different hundred on every render. Most recently removed first.
      .filter("deleted_at", "not.is", null)
      .order("deleted_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(LINK_PANEL_LIMIT),
  ]);

  if (removedResult.error) {
    console.error(
      "[crm] removed finance-line lookup failed:",
      removedResult.error.message,
    );
  }
  const removed: RemovedFinancialEntry[] = (removedResult.data ?? []).map(
    (row) => mapRemoved(row as Record<string, unknown>),
  );

  // The union of every artist id and every supplier-contact id across both the
  // live page and the removed rows.
  const artistIds = new Set<string>();
  const supplierIds = new Set<string>();
  const collect = (row: {
    artistId: string | null;
    supplierContactId: string | null;
  }) => {
    if (row.artistId !== null) artistIds.add(row.artistId);
    if (row.supplierContactId !== null) supplierIds.add(row.supplierContactId);
  };
  if (page.outcome === "loaded") for (const row of page.rows) collect(row);
  // Removed rows carry no artist/supplier ids in the deleted select (they are
  // not rendered on the removed line -- only date, category, status and
  // amount), so only the live page contributes ids. Kept as one collector so a
  // later widening of the deleted select does not need a second path.

  const [artistNames, supplierNames] = await Promise.all([
    resolveNames(supabase, "artists", organisationId, artistIds),
    resolveNames(supabase, "contacts", organisationId, supplierIds),
  ]);

  return { params, page, removed, artistNames, supplierNames };
}

/**
 * Names for a set of ids from one tenant-scoped table, with their deleted flag.
 *
 * An empty map on error, not a throw: the failure of a name lookup must not
 * take down the finance list it decorates -- the panel degrades to "outside
 * your access" for the affected rows. Same disposition as `loadVenueNames`.
 */
async function resolveNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "artists" | "contacts",
  organisationId: string,
  ids: ReadonlySet<string>,
): Promise<ReadonlyMap<string, LinkedName>> {
  const names = new Map<string, LinkedName>();
  if (ids.size === 0) return names;
  const { data, error } = await supabase
    .from(table)
    .select("id, name, deleted_at")
    .eq("organisation_id", organisationId)
    .in("id", [...ids]);
  if (error) {
    console.error(`[crm] finance ${table} name lookup failed:`, error.message);
    return names;
  }
  for (const row of data ?? []) {
    names.set(String(row.id), {
      name: String(row.name),
      deleted: row.deleted_at !== null,
    });
  }
  return names;
}

/**
 * The budget-vs-actuals summary for one event, from public.event_finance_summary.
 *
 * ===========================================================================
 * THE VIEW IS THE ACCESS CONTROL, AND THIS FUNCTION TRUSTS IT
 * ===========================================================================
 * `event_finance_summary` is `security_invoker` (20260903010000): its base
 * read runs under the caller's `financial_entries_select_view_finance` policy,
 * so a caller WITHOUT view_finance gets no row and this returns all-zeros. That
 * is correct ONLY because the panel is not rendered at all unless the page has
 * already confirmed view_finance (Constraint 12) -- this function is the second
 * of the two jobs, not the gate.
 *
 * ===========================================================================
 * "NO ROW" AND "THE QUERY FAILED" ARE DIFFERENT ANSWERS (review finding I3)
 * ===========================================================================
 * NO ROW is the ordinary case for an event with no finance lines (the view
 * `group by`s them away) and returns `empty`, which the panel renders as
 * zeros. A FAILURE returns `unavailable`, and the panel says so.
 *
 * They used to be the same all-zeros object, on the argument that "the honest
 * thing to show a view_finance holder is a summary of nothing". That is honest
 * for an empty event and a fabrication for a failed query: the line list below
 * the summary has its own outcome and keeps rendering the real lines, so the
 * user saw actual money listed under a Gross/Expense/Net block claiming
 * £0.00 · break-even. Same rule as every list surface, and as the panel's own
 * "A FAILED QUERY IS NOT AN EMPTY SHEET" note twelve lines away. The failure is
 * still logged.
 */
export async function loadEventFinanceSummary(
  organisationId: string,
  eventId: string,
): Promise<EventFinanceSummaryOutcome> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("event_finance_summary")
    .select(
      "budgeted_gross_minor, budgeted_expense_minor, actual_gross_minor, actual_expense_minor",
    )
    .eq("organisation_id", organisationId)
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    console.error("[crm] event finance summary lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "empty" };

  return {
    outcome: "loaded",
    summary: {
      budgetedGrossMinor: Number(data.budgeted_gross_minor),
      budgetedExpenseMinor: Number(data.budgeted_expense_minor),
      actualGrossMinor: Number(data.actual_gross_minor),
      actualExpenseMinor: Number(data.actual_expense_minor),
    },
  };
}
