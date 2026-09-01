import { defineListSpec } from "@/lib/list/spec";
import {
  FINANCE_CATEGORIES,
  FINANCE_STATUSES,
  FINANCE_CATEGORY_LABELS,
  FINANCE_STATUS_LABELS,
  type FinanceCategory,
  type FinanceStatus,
} from "@/lib/crm/finance-category";

// The financial-entries list specification.
//
// ===========================================================================
// THE ONE THAT SORTS BY A DATE AND HAS NO OWNER FILTER
// ===========================================================================
// A finance line's default question is WHEN it lands (occurred_on), so that is
// the default and only sort -- the same shape the events list takes on
// `starts_at`. There is NO "Mine" filter and no owner column, because finance
// scope is role-based, not owner-record-based: every role holding view_finance
// (owner, admin, finance) is full-scope, so there is no per-user narrowing to
// offer. This is also why the covering index INCLUDES event_id rather than the
// owner_user_id the five Phase 2 lists include -- see the sort's backedBy note.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `event_id` (the line's event, rendered as a column and covered by the sort
 * index's INCLUDE), `supplier_contact_id`/`artist_id` (the optional links Task
 * 2's row renders), `category`/`status`/`amount_minor`/`currency`/`occurred_on`
 * (the money line itself), `description` (the free-text label and the search
 * column), `updated_at` (for a secondary display, not a sort). No owner column
 * exists to select.
 */
export const FINANCIAL_ENTRY_SELECT =
  "id, event_id, category, status, amount_minor, currency, occurred_on, description, supplier_contact_id, artist_id, updated_at";

/**
 * One mapped row of the live list.
 *
 * A FAITHFUL PROJECTION OF `FINANCIAL_ENTRY_SELECT`. `amount_minor` is a
 * bigint; PostgREST returns it as a JS number, which is exact up to
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991) -- the actions reject any
 * amount above that on the way IN (lib/crm/finance.ts), so a stored value is
 * always exactly representable here.
 */
export interface FinancialEntryRow {
  id: string;
  eventId: string;
  category: FinanceCategory;
  status: FinanceStatus;
  amountMinor: number;
  currency: string;
  occurredOn: string;
  description: string | null;
  supplierContactId: string | null;
  artistId: string | null;
  updatedAt: string;
}

/**
 * One raw `financial_entries` row, as `FinancialEntryRow`.
 *
 * Lives beside the row type for the reason `mapEventRow` does: the finance list
 * page and any later reader (a per-event finance panel) share one mapper over
 * one literal, so a column added to the select is read back everywhere or the
 * type stops compiling.
 */
export function mapFinancialEntryRow(row: Record<string, unknown>): FinancialEntryRow {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    category: row.category as FinanceCategory,
    status: row.status as FinanceStatus,
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    occurredOn: String(row.occurred_on),
    description: (row.description as string | null) ?? null,
    supplierContactId: (row.supplier_contact_id as string | null) ?? null,
    artistId: (row.artist_id as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

export const FINANCIAL_ENTRY_LIST = defineListSpec({
  entity: "financial-entries",
  noun: { one: "finance line", many: "finance lines" },

  // `description` is the free-text label ("Headliner fee"). Search is O(tenant)
  // (lib/list/spec.ts: ILIKE cannot be an Index Cond under RLS), and a finance
  // sheet is short per event, so the sequential scan is cheap and the label is
  // the only human-readable thing to match.
  searchColumn: "description",
  searchLabel: "Search by description",

  sort: {
    occurred: {
      column: "occurred_on",
      label: "Date",
      // LATEST FIRST. A finance sheet opened cold should show the most recent
      // lines, the same argument every date sort in this codebase makes.
      defaultDirection: "desc",
      directionLabels: { asc: "earliest first", desc: "latest first" },
      // NOT NULL by declaration. 20260903000000's column comment states it: it
      // "is the finance list's default sort column, and a nullable sort column
      // makes keyset ordering non-total. A line with no date agreed defaults to
      // today and is editable."
      notNull: true,
      // COVERED, AND THE INCLUDE COLUMN IS event_id, NOT owner_user_id. The
      // index is (organisation_id, occurred_on, id) INCLUDE (event_id) WHERE
      // deleted_at is null -- financial_entries has NO owner_user_id column
      // (finance scope is role-based, not record-based), so the covering column
      // is the event the list renders. This is the documented deviation from
      // the standard `include (owner_user_id)` sort-covering shape; see the
      // index's own comment in 20260903000000.
      backedBy: "financial_entries_org_occurred_id_idx",
    },
  },
  defaultSort: "occurred",

  filters: {
    // ONE CHOICE PER CATEGORY, GENERATED FROM `FINANCE_CATEGORIES` rather than
    // typed out, so the filter cannot drift from the CHECK constraint. The
    // FIRST choice ("Any") is the default and filters nothing (lib/list/spec.ts
    // FilterDefinition rule -- otherwise the un-narrowed empty state renders
    // over a filtered list).
    category: {
      label: "Category",
      choices: [
        { value: "any", label: "Any category" },
        ...FINANCE_CATEGORIES.map((category) => ({
          value: category,
          label: FINANCE_CATEGORY_LABELS[category],
        })),
      ],
    },
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...FINANCE_STATUSES.map((status) => ({
          value: status,
          label: FINANCE_STATUS_LABELS[status],
        })),
      ],
    },
  },
});

export type FinancialEntrySortKey = keyof (typeof FINANCIAL_ENTRY_LIST)["sort"];
export type FinancialEntryFilterKey = keyof (typeof FINANCIAL_ENTRY_LIST)["filters"];

/**
 * The restore view's spec. Mirrors EVENT_DELETED_LIST.
 *
 * A soft-deleted finance line is restorable, so the deleted view sorts by when
 * it was removed and reads soft-deleted rows (which the SELECT policy permits
 * on purpose -- 20260903003000 carries no deleted_at term).
 */
export const FINANCIAL_ENTRY_DELETED_LIST = defineListSpec({
  entity: "financial-entries-deleted",
  noun: { one: "deleted finance line", many: "deleted finance lines" },
  searchColumn: "description",
  searchLabel: "Search deleted finance lines by description",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      // TRUE OF THE ROWS THIS LIST READS, not of the column. `deleted_at` IS
      // nullable; `financial_entries_org_deleted_at_id_idx` is partial on
      // `deleted_at is not null` and lib/list/query.ts's `scope: "deleted"`
      // writes that predicate on every query, so no row this sort can reach has
      // a NULL in it. Same trade as the six other restore views.
      notNull: true,
      backedBy: "financial_entries_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const FINANCIAL_ENTRY_DELETED_SELECT =
  "id, event_id, category, status, amount_minor, currency, occurred_on, description, deleted_at";

export interface DeletedFinancialEntryRow {
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

export type FinancialEntryDeletedSortKey =
  keyof (typeof FINANCIAL_ENTRY_DELETED_LIST)["sort"];
export type FinancialEntryDeletedFilterKey =
  keyof (typeof FINANCIAL_ENTRY_DELETED_LIST)["filters"];
