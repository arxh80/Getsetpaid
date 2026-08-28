// Request parameters for a list surface: parsing, and the inverse.
//
// URL AS STATE, DECIDED HERE. Search text, sort, direction, filters, page
// size and the cursor all live in the query string rather than in component
// state, and the whole surface is therefore a Server Component that reads
// them. The reasons, in the order they mattered:
//
//   - A filtered list is a thing people send each other. "Here's everyone at
//     that agency" has to be a link, and in a CRM it is half of what the list
//     is for.
//   - The back button. `ui-ux-pro-max` § 9 `state-preservation`: navigating
//     back must restore the previous filter state, and component state does
//     not survive a navigation to a record and back. This is the single most
//     common way a list surface feels broken.
//   - The query runs on the server, so nothing about the list -- not the rows,
//     not the pager, not the sort controls -- ships JavaScript to render. The
//     only Client Component on the page is the toolbar, and only because it
//     pushes a route.
//   - The cursor round-trips as a URL parameter, which is the only place it
//     can live if a page of results is to be linkable at all.
//
// The cost is that every keystroke would be a navigation, so search is a form
// SUBMIT rather than a live filter. See components/list/list-toolbar.tsx for
// why that is the right trade here and not a limitation.

import {
  decodeCursor,
  encodeCursor,
  type Cursor,
  type CursorDirection,
} from "./cursor";
import type { ListSpec, SortDirection } from "./spec";

/**
 * Server-side page-size ceiling. CLAUDE.md § Non-negotiable rules: "no
 * unbounded list endpoint. Server-side page-size ceiling."
 *
 * 50 rather than a larger number because the page is rendered server-side and
 * every row is HTML on the wire; and because `vercel-react-best-practices`
 * puts the virtualisation threshold at ~50 items, so this ceiling is also the
 * reason no list in this product needs a virtualiser.
 */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Search terms longer than this are truncated rather than refused.
 *
 * A refusal would need an error state for something no human types. The cap
 * exists so a pathological query string cannot turn into a pathological ILIKE
 * pattern.
 */
export const MAX_SEARCH_LENGTH = 100;

/** Next.js hands `searchParams` through in this shape. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface ListParams<
  TSort extends string = string,
  TFilter extends string = string,
> {
  /** Trimmed, capped search text. Empty string means "no search". */
  readonly q: string;
  readonly sort: TSort;
  readonly dir: SortDirection;
  readonly filters: Readonly<Record<TFilter, string>>;
  readonly pageSize: number;
  readonly cursor: Cursor | null;
  readonly cursorDirection: CursorDirection | null;
}

/**
 * What, if anything, is narrowing the list.
 *
 * The two halves are reported separately because the copy above the table has
 * to name the right one. The first browser pass rendered "50 contacts match
 * your search" for a list with no search term and a filter applied, which
 * sends a reader looking for a search box they never typed in.
 *
 * Sorting is deliberately not narrowing: the same rows in a different order.
 * If it counted, every sorted list would offer "Clear search and filters" and
 * an empty sorted list would claim nothing matched.
 */
export function narrowedBy<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
  params: ListParams<TSort, TFilter>,
): { readonly search: boolean; readonly filters: boolean } {
  let filters = false;
  for (const key of Object.keys(spec.filters) as TFilter[]) {
    if (params.filters[key] !== spec.filters[key].choices[0].value) {
      filters = true;
      break;
    }
  }
  return { search: params.q !== "", filters };
}

/** True when anything is narrowing the list -- drives the empty-state choice. */
export function isNarrowed<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
  params: ListParams<TSort, TFilter>,
): boolean {
  const by = narrowedBy(spec, params);
  return by.search || by.filters;
}

function first(value: string | string[] | undefined): string | null {
  // A repeated parameter (`?sort=name&sort=email`) arrives as an array. Taking
  // the first and ignoring the rest is deliberate: the alternative is to
  // reject, which turns a stray link into an error page, and the allowlist
  // below means neither entry can do anything a single one could not.
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return typeof value === "string" ? value : null;
}

/**
 * Parse a request's query string against a spec.
 *
 * EVERY value out of this function is either a literal from the spec or a
 * bounded scalar. Nothing a caller supplies reaches a query as a column name,
 * an operator or a direction -- only as the search term and the cursor, both
 * of which are encoded by lib/list/postgrest.ts at the point of use.
 *
 * Unrecognised input falls back to the default rather than erroring, for the
 * reason cursor.ts gives: a stale link is ordinary, and an error page for one
 * is a worse bug than the default view.
 */
export function parseListParams<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
  raw: RawSearchParams,
): ListParams<TSort, TFilter> {
  // ---- sort ----------------------------------------------------------
  // `Object.hasOwn`, NOT `key in spec.sort`. `in` walks the prototype chain,
  // so `?sort=toString` and `?sort=constructor` both pass an `in` check and
  // then resolve to a function whose `.column` is undefined -- an allowlist
  // that admits every member of Object.prototype. That is a real bypass of a
  // control whose entire job is to be un-bypassable, and it is the reason
  // tests/unit/list/params.test.ts probes the prototype keys by name.
  const rawSort = first(raw.sort);
  const sort: TSort =
    rawSort !== null && Object.hasOwn(spec.sort, rawSort)
      ? (rawSort as TSort)
      : spec.defaultSort;

  // ---- direction -----------------------------------------------------
  const rawDir = first(raw.dir);
  const dir: SortDirection =
    rawDir === "asc" || rawDir === "desc"
      ? rawDir
      : spec.sort[sort].defaultDirection;

  // ---- search --------------------------------------------------------
  const q = (first(raw.q) ?? "").trim().slice(0, MAX_SEARCH_LENGTH);

  // ---- filters -------------------------------------------------------
  // Two allowlists, not one: the KEY must be a filter this entity declares,
  // and the VALUE must be one of that filter's declared choices. Checking only
  // the key would let `?owner=<anything>` through to whatever the entity's
  // apply function does with it.
  const filters = {} as Record<TFilter, string>;
  for (const key of Object.keys(spec.filters) as TFilter[]) {
    const definition = spec.filters[key];
    const candidate = first(raw[key]);
    const known = definition.choices.some((c) => c.value === candidate);
    filters[key] = known && candidate !== null
      ? candidate
      : definition.choices[0].value;
  }

  // ---- page size -----------------------------------------------------
  // A value that is not a plain positive integer is treated as ABSENT, not as
  // something to clamp the parsed prefix of.
  //
  // Fix round 1, review finding M-2: `Number.parseInt("1e9", 10)` is 1, so
  // `?size=1e9` rendered a ONE-ROW page with a full pager. So did `?size=0`
  // and `?size=-1`. The old comment called that "something servable", which it
  // is, but a single row reads as a rendering fault rather than as a clamp --
  // and the three inputs that produce it are all typos or tampering, never a
  // real request for one row. Falling back to the default is the honest
  // reading of "I could not understand this".
  //
  // A number this DOES understand is still clamped, so the ceiling is enforced
  // by the clamp and not by the parse: `?size=10000` is 50, not 10000.
  const rawSizeText = first(raw.size) ?? "";
  const rawSize = /^\d+$/.test(rawSizeText) ? Number(rawSizeText) : Number.NaN;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(rawSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  // ---- cursor --------------------------------------------------------
  // `after` wins if both are present. They cannot both be meaningful, and
  // preferring one deterministically beats erroring on a hand-edited URL.
  const after = decodeCursor(first(raw.after));
  const before = after ? null : decodeCursor(first(raw.before));
  const decoded = after ?? before;

  // A CURSOR MADE UNDER A DIFFERENT SORT IS DISCARDED, not used. Its `value`
  // is the other column's -- a name where a timestamp is expected -- and
  // sending it produces `updated_at >= 'Contact 00100'`, a PostgREST 400, and
  // a page that tells the user the system is broken when the URL is merely
  // stale. Dropping it gives page one under the requested sort, which is what
  // lib/list/cursor.ts's header promises for every other unreadable cursor.
  const cursor = decoded && decoded.sort === sort ? decoded : null;

  return {
    q,
    sort,
    dir,
    filters,
    pageSize,
    cursor,
    cursorDirection: cursor ? (after ? "after" : "before") : null,
  };
}

export interface HrefOverrides<TSort extends string, TFilter extends string> {
  readonly q?: string;
  readonly sort?: TSort;
  readonly dir?: SortDirection;
  readonly pageSize?: number;
  readonly filters?: Partial<Record<TFilter, string>>;
  readonly cursor?: { direction: CursorDirection; cursor: Cursor } | null;
}

/**
 * Build the href for a modified view of the same list.
 *
 * THE CURSOR IS DROPPED unless this call sets one. That is the important
 * behaviour and it is not incidental: a cursor names a row in one particular
 * ordering of one particular filtered set, so carrying it across a sort
 * change, a new search or a filter change would page from a boundary that no
 * longer exists in the new list. The result is not an error -- it is a page
 * that starts somewhere arbitrary, which is exactly the kind of wrong that
 * gets shipped.
 *
 * Defaults are omitted from the URL, so the canonical list is a bare path and
 * two links to the same view are the same string.
 */
export function buildListHref<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
  basePath: string,
  params: ListParams<TSort, TFilter>,
  overrides: HrefOverrides<TSort, TFilter> = {},
): string {
  const search = new URLSearchParams();

  const q = overrides.q ?? params.q;
  if (q !== "") search.set("q", q);

  const sort = overrides.sort ?? params.sort;
  if (sort !== spec.defaultSort) search.set("sort", sort);

  const dir = overrides.dir ?? (overrides.sort ? undefined : params.dir);
  const effectiveDir = dir ?? spec.sort[sort].defaultDirection;
  if (effectiveDir !== spec.sort[sort].defaultDirection) {
    search.set("dir", effectiveDir);
  }

  for (const key of Object.keys(spec.filters) as TFilter[]) {
    const value = overrides.filters?.[key] ?? params.filters[key];
    if (value !== spec.filters[key].choices[0].value) search.set(key, value);
  }

  const pageSize = overrides.pageSize ?? params.pageSize;
  if (pageSize !== DEFAULT_PAGE_SIZE) search.set("size", String(pageSize));

  if (overrides.cursor) {
    search.set(
      overrides.cursor.direction,
      encodeCursor(overrides.cursor.cursor),
    );
  }

  const query = search.toString();
  return query === "" ? basePath : `${basePath}?${query}`;
}
