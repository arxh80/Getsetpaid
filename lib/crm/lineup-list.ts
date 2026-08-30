import { defineListSpec } from "@/lib/list/spec";
import {
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";

// The lineup panel's list specification, and the vocabulary it renders.
//
// ===========================================================================
// A REAL lib/list/ SURFACE, NOT A `LINK_PANEL_LIMIT` CAP
// ===========================================================================
// Every other child panel in this product -- rooms, representations, the
// contact/company links -- is a capped read (`LINK_PANEL_LIMIT`, 100) with no
// pager, on the argument that a join panel does not GROW. A lineup does: a
// festival day is a hundred slots, and `event_lineup` has no ceiling other
// than the 999 `position` allows. So this goes through lib/list/ for the same
// reason ARTIST_FEE_LIST does, and CLAUDE.md § Non-negotiable rules
// ("Paginate everything. No unbounded list endpoint.") has no exception for a
// panel that does not look like a list endpoint.
//
// ===========================================================================
// `paramPrefix` IS NOT OPTIONAL HERE
// ===========================================================================
// The event detail page carries this list AND the activity timeline
// (`activity_`, Task 6). Two lists reading one `after` is the failure
// lib/crm/activity.ts's header documents in full: the timeline's cursor would
// be handed to THIS spec, compared against `position` -- an integer column,
// against a cursor carrying a timestamp -- and PostgREST would answer 400,
// rendered as "we couldn't load the lineup" on a page where nothing is wrong.
// `Cursor.sort` does not close it, because the two specs' sort keys are
// different strings and either could legitimately be the one in the cursor.
//
// Both lists must ALSO be passed `preserve` (HrefOverrides.preserve), or
// paging one silently returns the other to its first page. The artist detail
// page is the existing model for both halves.
//
// ===========================================================================
// ORDERING IS A NUMBER THE USER TYPES. NO DRAG-AND-DROP, NO "MOVE UP".
// ===========================================================================
// The rationale lives in components/crm/lineup-panel.tsx, beside the control
// it is about. In one line: a unique index on `(event_id, position)` cannot be
// deferred, so a swap becomes two statements in one transaction plus a 23505
// path -- the cost `contact_companies_one_primary_per_contact` imposed on
// Phase 2 -- and duplicate positions are legal precisely so that never has to
// be paid.
//
// TIES BREAK ON `id`, NOT ON `created_at`, AND THAT IS MEASURED RATHER THAN
// INTENDED. `public.event_lineup`'s table comment (20260901000000) says the
// ordering is `(position, created_at, id)`, and the RENDERED order cannot be:
// `fetchListPage` orders by `spec.sort[...].column` and then by `id`, full
// stop -- one sort column plus the primary key is the whole shape a keyset
// cursor can carry (lib/list/query.ts, `buildPage`). So a tie is broken by a
// `gen_random_uuid()`, which is TOTAL and PERMANENT -- the list does not
// reshuffle between reloads, which is the property the panel actually needs --
// and is NOT insertion order. Measured in the Rule 17 walk: two slots both at
// position 0, added B-then-A, render A first and go on doing so.
//
// The migration's comment therefore overstates it. It is not edited (no
// existing migration is) and the divergence is in FOLLOW-UPS.md.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `created_at` IS NOT HERE, and its absence is the correction the browser walk
 * forced. The first version selected it and said it was "half the documented
 * tie-break" -- which the walk measured to be false: the rendered order is
 * `(position, id)` and nothing reads `created_at` at all (see the header). A
 * column selected to support a claim that turned out not to hold is a column
 * on the wire for nothing.
 *
 * `deleted_at` is NOT here either. `fetchListPage` writes `deleted_at is null` on
 * every live list (lib/list/query.ts, `applyScope`), so every row this list
 * returns is live by construction, and a column that is always null is not
 * worth the wire. The REMOVED rows are read by a second, capped query inside
 * `loadLineupForEvent` (lib/crm/queries.ts), which selects `deleted_at`
 * because the disclosure renders when each one was removed.
 */
export const LINEUP_SELECT =
  "id, artist_id, position, billing, set_starts_at, set_ends_at, notes";

/** The six values `event_lineup`'s billing CHECK allows, in bill order. */
export const BILLING_VALUES = [
  "headliner",
  "support",
  "opener",
  "guest",
  "resident",
  "other",
] as const;

export type Billing = (typeof BILLING_VALUES)[number];

/**
 * The labels, keyed on the union so a seventh value added to the CHECK without
 * a label here is a `pnpm typecheck` failure rather than a blank cell.
 */
export const BILLING_LABELS: Readonly<Record<Billing, string>> = {
  headliner: "Headliner",
  support: "Support",
  opener: "Opener",
  guest: "Guest",
  resident: "Resident",
  other: "Other",
};

export function isBilling(value: string | null): value is Billing {
  return value !== null && (BILLING_VALUES as readonly string[]).includes(value);
}

/** `position`'s bounds, from `event_lineup`'s CHECK (20260901000000). */
export const MIN_POSITION = 0;
export const MAX_POSITION = 999;

/** The one message a bad `position` gets. */
export const POSITION_PROBLEM =
  "Position must be a whole number between 0 and 999.";

/**
 * Read a `position` out of a form value.
 *
 * PURE, so it is unit-testable -- which matters because the three ways it can
 * be wrong are invisible to every other gate: `Number("")` is 0 (an omitted
 * field would become position zero), `Number("1e3")` is 1000 (past the CHECK,
 * so a 23514 the user meets as "something went wrong"), and `Number("1.5")`
 * is 1.5 (an integer column, so a 22P02). Each is refused here with the one
 * sentence, next to the field.
 *
 * `null` in, `null` out: the add form may omit it and take the column default.
 */
export function readPosition(raw: string | null): number | null | "invalid" {
  if (raw === null) return null;
  if (!/^\d{1,3}$/.test(raw)) return "invalid";
  const value = Number(raw);
  if (value < MIN_POSITION || value > MAX_POSITION) return "invalid";
  return value;
}

/** One mapped row of the panel. */
export interface LineupRow {
  id: string;
  artistId: string;
  position: number;
  /** `null` when the database holds a billing this build does not know. */
  billing: Billing | null;
  /** The raw column, for the neutral rendering and for logs. */
  rawBilling: string;
  setStartsAt: string | null;
  setEndsAt: string | null;
  notes: string | null;
}

export function mapLineupRow(raw: Record<string, unknown>): LineupRow {
  const rawBilling = String(raw.billing ?? "");
  return {
    id: String(raw.id),
    artistId: String(raw.artist_id),
    position: Number(raw.position),
    billing: isBilling(rawBilling) ? rawBilling : null,
    rawBilling,
    setStartsAt: (raw.set_starts_at as string | null) ?? null,
    setEndsAt: (raw.set_ends_at as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
  };
}

export const LINEUP_LIST = defineListSpec({
  entity: "event-lineup",
  noun: { one: "lineup entry", many: "lineup entries" },
  // NOTHING ON THIS SURFACE SEARCHES, and `lineupParams()` below drops the
  // search key before parsing so nothing can. It is still a REAL column rather
  // than a placeholder, because `spec.searchColumn` reaches PostgREST the
  // moment `params.q !== ""`, and a spec naming a column that does not exist
  // is a 400 waiting for the first person who removes that guard. Same trade,
  // and the same column-choice logic, as ACTIVITY_LIST's `kind`.
  searchColumn: "billing",
  searchLabel: "Search lineup by billing",
  sort: {
    order: {
      column: "position",
      label: "Order",
      defaultDirection: "asc",
      directionLabels: { asc: "first to last", desc: "last to first" },
      // NOT NULL by declaration: `position integer not null default 0`
      // (20260901000000), with a CHECK pinning it to 0-999. A nullable sort
      // column silently drops a contiguous band of rows out of a keyset page
      // -- see lib/list/spec.ts's `notNull`.
      notNull: true,
      backedBy: "event_lineup_org_event_position_id_live_idx",
    },
  },
  defaultSort: "order",
  filters: {},
  // See the header. Without this the event detail page has two lists reading
  // one `after`.
  paramPrefix: "lineup_",
});

export type LineupSortKey = keyof (typeof LINEUP_LIST)["sort"];
export type LineupFilterKey = keyof (typeof LINEUP_LIST)["filters"];
export type LineupParams = ListParams<LineupSortKey, LineupFilterKey>;

/**
 * The one query-string key this surface refuses to honour.
 *
 * `LINEUP_LIST.paramPrefix` + the spec's search key. Written out rather than
 * built from the spec so that renaming the prefix without renaming this is a
 * mismatch a reader can see, instead of a guard that silently stops guarding.
 * `tests/unit/crm/lineup-list.test.ts` asserts it against the spec.
 */
export const LINEUP_SEARCH_PARAM = "lineup_q";

/**
 * The lineup's parameters, out of the detail page's query string.
 *
 * THE WHOLE OBJECT IS SAFE TO PASS, because `LINEUP_LIST.paramPrefix` means
 * `parseListParams` only ever reads keys beginning `lineup_`. The timeline's
 * `activity_after` and anything a later phase adds to this page are invisible
 * to it.
 *
 * ===========================================================================
 * EXCEPT `lineup_q`, WHICH IS DROPPED, FOR `activityParams()`'s REASON
 * ===========================================================================
 * The spec declares a `searchColumn` because it must (a spec naming a column
 * that does not exist is a 400), and there is no search control anywhere on
 * this surface. So `?lineup_q=zzz` in a hand-edited or pasted URL would narrow
 * the panel through `ilike(billing, ...)` with nothing on screen saying so --
 * and because the panel renders ONE empty state rather than the list surface's
 * narrowed/unnarrowed pair, a reader would be told
 *
 *     No lineup yet
 *
 * about an event with a full bill. That is the same class of lie Task 3's
 * browser pass found on the contacts list ("No contacts yet" in a 71-contact
 * workspace), reached through a query parameter instead of through a role.
 *
 * Two ways to close it: honour the search and render a second empty state for
 * it, or refuse the search. Refusing is right, because the first would build
 * copy and a "clear search" affordance for a control this surface does not
 * have and is not getting.
 */
export function lineupParams(raw: RawSearchParams): LineupParams {
  return parseListParams(LINEUP_LIST, {
    ...raw,
    [LINEUP_SEARCH_PARAM]: undefined,
  });
}
