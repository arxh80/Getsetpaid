// The list specification: what a CRM entity list is allowed to sort by,
// filter by and search on.
//
// This is the allowlist CLAUDE.md § Non-negotiable rules requires
// ("search/filter/sort inputs map to allowlisted columns and operators"),
// expressed so that the compiler enforces it as well as the runtime. A column
// name never travels from the query string into a query: the query string
// carries a KEY, the key is looked up here, and the value used is the literal
// written in this file.
//
// Task 4 copies this five times. The two fields most likely to be treated as
// paperwork -- `notNull` and `backedBy` -- are the two that are load-bearing,
// so they are required rather than optional and each one says why.

import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";

export interface SortOption {
  /**
   * The database column, written here as a literal. Never interpolated from
   * a request.
   */
  readonly column: string;
  /** Column header, and the accessible name of the sort control. */
  readonly label: string;
  /** Which way round this column is useful first. Names ascend; dates descend. */
  readonly defaultDirection: SortDirection;
  /**
   * How each direction reads for THIS column, for the line above the table.
   *
   * Required rather than defaulted, because the default is wrong half the
   * time and wrong quietly. The first browser pass produced "sorted by
   * updated (Z–A)" for a date column: A–Z is a text-sort idiom, and applied
   * to dates it is not merely inelegant -- a reader has to work out whether
   * Z–A means newest or oldest, which is the one thing the line exists to
   * tell them.
   */
  readonly directionLabels: Readonly<Record<SortDirection, string>>;
  /**
   * THE COLUMN MUST BE `NOT NULL`, and saying so here is not decoration.
   *
   * Keyset pagination compares `(column, id)` against the last row of the
   * previous page. Every comparison against NULL is NULL, which is not true,
   * so a NULL in the sort column silently drops rows out of the middle of the
   * list -- and because `order by` puts NULLs in a contiguous block, the rows
   * lost are a whole band of the list, not a stray one. Nothing errors and no
   * test that counts rows on one page can see it.
   *
   * `contacts.email` is exactly the tempting mistake: it is the obvious third
   * sort for a contacts list and it is nullable, so it is not here.
   */
  readonly notNull: true;
  /**
   * The index that makes this sort O(page) rather than O(tenant).
   *
   * Required, and required to be a real index name, because the alternative
   * is what was measured before `20260828180000` existed: page one of a
   * 25,000-contact organisation was a Seq Scan plus a top-N sort of every
   * live row in the tenant -- 13.575 ms and 866 buffers -- versus 1.015 ms
   * and 314 with the index. The shape is O(tenant size) per page click, so it
   * looks fine in every fixture and degrades linearly with a customer's
   * success.
   *
   * If you cannot name an index here, the column does not belong in the
   * allowlist. Adding the sort and deferring the index is the one move that
   * makes this field pointless.
   */
  readonly backedBy: string;
}

export interface FilterChoice {
  readonly value: string;
  readonly label: string;
}

export interface FilterDefinition {
  readonly label: string;
  /**
   * The first choice is the default and MUST be the one that filters nothing.
   * A list whose default state hides rows is a list that lies about how many
   * records exist.
   */
  readonly choices: readonly [FilterChoice, ...FilterChoice[]];
}

export interface ListSpec<
  TSort extends string = string,
  TFilter extends string = string,
> {
  /** Stable identifier, used in log lines. Never rendered. */
  readonly entity: string;
  /** Singular and plural, for counts and empty states. Lower case. */
  readonly noun: { readonly one: string; readonly many: string };
  /**
   * The column `q` searches, with ILIKE.
   *
   * There IS a trigram index on this column and the search does NOT use it and
   * cannot: ILIKE is not leakproof, so under RLS it can never become an Index
   * Cond (lib/list/query.ts, "SEARCH IS O(TENANT)"). Search is a sequential
   * scan of the tenant. Pick a column that is worth that.
   */
  readonly searchColumn: string;
  /** Accessible name of the search input. A real label, not a placeholder. */
  readonly searchLabel: string;
  readonly sort: Readonly<Record<TSort, SortOption>>;
  readonly defaultSort: TSort;
  readonly filters: Readonly<Record<TFilter, FilterDefinition>>;
  /**
   * A QUERY-STRING NAMESPACE FOR EVERY KEY THIS SPEC OWNS, for a page that
   * carries TWO list surfaces.
   *
   * Added by Task 7 because the artist detail page already had one -- the fee
   * history (`ARTIST_FEE_LIST`) -- and the activity timeline made it two. Both
   * read `after` and `before` off the same `searchParams`, so without this the
   * timeline's cursor would be handed to the fee list, which would compare a
   * timestamp against `occurred_on`, get a PostgREST 400, and render "we
   * couldn't load" on a page where nothing is wrong. That is the exact failure
   * `Cursor.sort` was added to close, reached through a second list on one page
   * rather than through a stale link -- and `Cursor.sort` does NOT close it,
   * because the two specs' sort keys are different strings and either could
   * legitimately be the one in the cursor.
   *
   * Prepended verbatim to `q`, `sort`, `dir`, `size`, `after`, `before` and to
   * every filter key, by `parseListParams` and `buildListHref` together. Omit
   * it and every key is bare, which is what the five entity lists, the two
   * duplicate queues, the merge history and the fee history all still do --
   * so this field changes nothing anywhere it is not set.
   *
   * INCLUDE THE SEPARATOR. It is a prefix, not a segment: write
   * `"activity_"`, not `"activity"`. `defineListSpec` refuses a value that
   * would not survive a round trip.
   */
  readonly paramPrefix?: string;
}

/**
 * The shape a prefix must have.
 *
 * Lower-case, and ending in the separator so the caller cannot half-write it.
 * The characters are the ones that need no percent-encoding in a query key,
 * because a prefix that encodes differently in `buildListHref` than the
 * browser sends it back would make every prefixed list read page one forever
 * and nothing would error.
 */
const PARAM_PREFIX = /^[a-z][a-z0-9]*_$/;

/**
 * Query-string keys lib/list/params.ts owns.
 *
 * A filter key becomes a query-string key verbatim (`?owner=mine`), which
 * keeps URLs readable and keeps the filter's identity in one place instead of
 * two. The cost is that a filter called `sort` would shadow the sort
 * parameter, so `defineListSpec` refuses one.
 */
export const RESERVED_PARAMS = [
  "q",
  "sort",
  "dir",
  "size",
  "after",
  "before",
] as const;

/**
 * Declare a list spec, inferring the sort and filter key unions from the
 * object literal.
 *
 * The inference is the point. `spec.sort` is `Record<"name" | "updated", ...>`
 * rather than `Record<string, ...>`, so `params.sort` is that union too, and a
 * column definition naming a sort key that does not exist is a compile error
 * at the call site -- not a runtime lookup that quietly yields `undefined` and
 * orders by nothing. `NoInfer` on `defaultSort` stops a typo there from
 * WIDENING the union to include itself, which would defeat the whole thing.
 *
 * The two runtime checks are the ones the type system cannot make. They throw
 * at MODULE LOAD, so a spec that violates either one fails `pnpm build` rather
 * than a request -- the closest thing to a compile error available for a
 * property of the object's contents rather than its shape.
 */
export function defineListSpec<TSort extends string, TFilter extends string>(
  // `defaultSort` is split out and wrapped in NoInfer for a concrete reason,
  // caught by the compiler on the first build: as a plain `TSort` it is an
  // inference SITE, and TypeScript unified the two candidates to the narrower
  // one -- so a spec declaring `name` and `updated` with `defaultSort: "name"`
  // inferred TSort as `"name"` alone and then rejected its own `updated` key.
  // Wrapped, the keys of `sort` are the only place TSort comes from.
  spec: Omit<ListSpec<TSort, TFilter>, "defaultSort"> & {
    readonly defaultSort: NoInfer<TSort>;
  },
): ListSpec<TSort, TFilter> {
  for (const key of Object.keys(spec.filters)) {
    if ((RESERVED_PARAMS as readonly string[]).includes(key)) {
      throw new Error(
        `[list] ${spec.entity}: filter "${key}" collides with a reserved query parameter (${RESERVED_PARAMS.join(", ")}). Rename the filter.`,
      );
    }
  }
  if (
    spec.paramPrefix !== undefined &&
    !PARAM_PREFIX.test(spec.paramPrefix)
  ) {
    throw new Error(
      `[list] ${spec.entity}: paramPrefix "${spec.paramPrefix}" must be lower-case alphanumerics ending in "_" (e.g. "activity_").`,
    );
  }
  if (!Object.hasOwn(spec.sort, spec.defaultSort)) {
    // Unreachable through the types; reachable through a cast or a JS caller,
    // and the failure mode would be `order by undefined`.
    throw new Error(
      `[list] ${spec.entity}: defaultSort "${spec.defaultSort}" is not one of the declared sorts.`,
    );
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Column rendering.
//
// Columns are data, not a wall of props: `vercel-composition-patterns` on
// compound APIs, and a plain array is what lets the Contacts page and Task 4's
// four pages differ in exactly the way they should differ (which fields) while
// sharing everything else.
// ---------------------------------------------------------------------------
export interface ListColumn<TRow, TSort extends string> {
  /** Stable React key. Not a database column and never sent anywhere. */
  readonly key: string;
  readonly header: string;
  readonly render: (row: TRow) => ReactNode;
  /**
   * Makes the header a sort control. Constrained to the spec's own sort keys,
   * so a sortable column that nothing can actually sort by does not compile.
   */
  readonly sortKey?: TSort;
  /**
   * DESIGN.md § Numerals: "Apply to every table cell containing a number,
   * every currency value and every date column. Non-negotiable."
   */
  readonly numeric?: boolean;
  /** Hidden below `sm`, for detail that is not worth a horizontal scroll. */
  readonly secondary?: boolean;
}
