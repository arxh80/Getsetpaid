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
import { RESERVED_PARAMS, type ListSpec, type SortDirection } from "./spec";

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
  /**
   * A cursor arrived, decoded cleanly, and was thrown away because it was made
   * under a DIFFERENT SORT than the one being rendered.
   *
   * Surfaced because the user is looking at page one of a list they asked for
   * a middle page of, and nothing told them. It is the same class of event as
   * the two `fetchListPage` recovers from -- your link is stale, so this is
   * not what you asked for -- and it was the only one of the three that
   * produced no notice at all. `null` is not distinguishable from "no cursor
   * was sent" without it: the cursor field is null in both cases.
   *
   * Deliberately NOT true for a cursor that failed to DECODE. That one is
   * either tampering or truncation, is not a link the product ever issued, and
   * `lib/list/cursor.ts` already decided the answer is silently page one. This
   * flag is for a link this product really did hand out and has since
   * invalidated by a sort change.
   */
  readonly cursorDiscarded: boolean;
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

/**
 * The query-string key this spec uses for one of its own parameters.
 *
 * ONE FUNCTION, USED BY BOTH THE PARSER AND THE BUILDER, because the failure
 * mode of two copies is silent: a builder that writes `activity_after` against
 * a parser that reads `after` produces a link that always renders page one,
 * with no error anywhere. See ListSpec.paramPrefix for why the namespace
 * exists at all.
 */
export function paramKey<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
  key: string,
): string {
  return spec.paramPrefix ? `${spec.paramPrefix}${key}` : key;
}

/**
 * The `name` attribute of every input the toolbar renders, for one spec.
 *
 * ===========================================================================
 * WHY THIS EXISTS RATHER THAN paramKey() CALLS INSIDE THE TOOLBAR
 * ===========================================================================
 * Final review I-4 (deferred-minor L1039). `components/list/list-toolbar.tsx`
 * hardcoded `name="sort"`, `name="dir"`, `name="size"`, `name="q"` and
 * `name={key}`, bypassing `paramKey()` entirely. The JS submit path was fine
 * -- it calls `buildListHref`, which applies the prefix -- but the
 * `<form method="get">` fallback wrote the UN-NAMESPACED keys straight into
 * the URL, and the JS path's own `new FormData()` read them back by the
 * unprefixed name too.
 *
 * Not live at the time: `ACTIVITY_LIST` is the only spec with a `paramPrefix`
 * and it deliberately renders no toolbar. It becomes live the moment a
 * namespaced list on a shared route gets a search box -- at which point one
 * list's toolbar rewrites the other list's state, silently, with no error.
 * `lib/list` is the template every later entity list reuses, so a component in
 * it that violates the library's own namespace contract is a trap laid for the
 * next author.
 *
 * A function returning the whole set, rather than five `paramKey()` calls in
 * the component, so the property is unit-testable without a DOM: this
 * repository has no React Testing Library and tests/unit is pure functions by
 * vitest.config.ts's own rule.
 */
export interface ToolbarParamNames<TFilter extends string> {
  readonly q: string;
  readonly sort: string;
  readonly dir: string;
  readonly size: string;
  readonly filters: Readonly<Record<TFilter, string>>;
}

export function toolbarParamNames<TSort extends string, TFilter extends string>(
  spec: ListSpec<TSort, TFilter>,
): ToolbarParamNames<TFilter> {
  const filters = {} as Record<TFilter, string>;
  for (const key of Object.keys(spec.filters) as TFilter[]) {
    filters[key] = paramKey(spec, key);
  }
  return {
    q: paramKey(spec, "q"),
    sort: paramKey(spec, "sort"),
    dir: paramKey(spec, "dir"),
    size: paramKey(spec, "size"),
    filters,
  };
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
  const rawSort = first(raw[paramKey(spec, "sort")]);
  const sort: TSort =
    rawSort !== null && Object.hasOwn(spec.sort, rawSort)
      ? (rawSort as TSort)
      : spec.defaultSort;

  // ---- direction -----------------------------------------------------
  const rawDir = first(raw[paramKey(spec, "dir")]);
  const dir: SortDirection =
    rawDir === "asc" || rawDir === "desc"
      ? rawDir
      : spec.sort[sort].defaultDirection;

  // ---- search --------------------------------------------------------
  const q = (first(raw[paramKey(spec, "q")]) ?? "")
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);

  // ---- filters -------------------------------------------------------
  // Two allowlists, not one: the KEY must be a filter this entity declares,
  // and the VALUE must be one of that filter's declared choices. Checking only
  // the key would let `?owner=<anything>` through to whatever the entity's
  // apply function does with it.
  const filters = {} as Record<TFilter, string>;
  for (const key of Object.keys(spec.filters) as TFilter[]) {
    const definition = spec.filters[key];
    const candidate = first(raw[paramKey(spec, key)]);
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
  const rawSizeText = first(raw[paramKey(spec, "size")]) ?? "";
  const rawSize = /^\d+$/.test(rawSizeText) ? Number(rawSizeText) : Number.NaN;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(rawSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  // ---- cursor --------------------------------------------------------
  // `after` wins if both are present. They cannot both be meaningful, and
  // preferring one deterministically beats erroring on a hand-edited URL.
  const after = decodeCursor(first(raw[paramKey(spec, "after")]));
  const before = after
    ? null
    : decodeCursor(first(raw[paramKey(spec, "before")]));
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
    // `decoded !== null && cursor === null` is exactly the discard branch
    // above, written as a fact about the two values rather than as a second
    // copy of the condition -- so it cannot say "discarded" while the cursor
    // was in fact kept.
    cursorDiscarded: decoded !== null && cursor === null,
  };
}

export interface HrefOverrides<TSort extends string, TFilter extends string> {
  /**
   * QUERY PARAMETERS BELONGING TO SOMETHING ELSE ON THIS PAGE, carried
   * through instead of dropped.
   *
   * Hand it the page's whole `searchParams`; this builder removes its own keys
   * from it before re-emitting the rest, so it is safe to pass everything and
   * a caller cannot leak a stale cursor of its own back into the URL.
   *
   * WITHOUT IT, TWO LISTS ON ONE PAGE FIGHT. `buildListHref` builds from
   * scratch -- deliberately, so a sort change cannot carry a cursor from an
   * ordering that no longer exists -- and on the artist detail page that meant
   * paging the activity timeline silently returned the fee history to its
   * first page, and the reverse. Neither is an error and neither says
   * anything, which is what makes it worth fixing rather than documenting.
   *
   * Only pages with two list surfaces pass it. Absent, this builder behaves
   * exactly as it did before Task 7.
   */
  readonly preserve?: RawSearchParams;
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

  // FOREIGN KEYS FIRST, so this spec's own values below overwrite rather than
  // duplicate if `preserve` happens to contain one. `ownKeys` is built from
  // the same paramKey() the writes below use, so a namespaced spec strips its
  // namespaced keys and a bare one strips bare keys.
  if (overrides.preserve) {
    const ownKeys = new Set<string>([
      ...RESERVED_PARAMS.map((key) => paramKey(spec, key)),
      ...Object.keys(spec.filters).map((key) => paramKey(spec, key)),
    ]);
    for (const [key, value] of Object.entries(overrides.preserve)) {
      if (ownKeys.has(key)) continue;
      // A repeated parameter arrives as an array; carry the first, for the
      // same reason `first()` reads the first -- the alternative is to decide
      // what a duplicate MEANS for a key this spec does not own.
      const single = Array.isArray(value) ? value[0] : value;
      if (typeof single === "string") search.set(key, single);
    }
  }

  const q = overrides.q ?? params.q;
  if (q !== "") search.set(paramKey(spec, "q"), q);

  const sort = overrides.sort ?? params.sort;
  if (sort !== spec.defaultSort) search.set(paramKey(spec, "sort"), sort);

  const dir = overrides.dir ?? (overrides.sort ? undefined : params.dir);
  const effectiveDir = dir ?? spec.sort[sort].defaultDirection;
  if (effectiveDir !== spec.sort[sort].defaultDirection) {
    search.set(paramKey(spec, "dir"), effectiveDir);
  }

  for (const key of Object.keys(spec.filters) as TFilter[]) {
    const value = overrides.filters?.[key] ?? params.filters[key];
    if (value !== spec.filters[key].choices[0].value) {
      search.set(paramKey(spec, key), value);
    }
  }

  const pageSize = overrides.pageSize ?? params.pageSize;
  if (pageSize !== DEFAULT_PAGE_SIZE) {
    search.set(paramKey(spec, "size"), String(pageSize));
  }

  if (overrides.cursor) {
    search.set(
      paramKey(spec, overrides.cursor.direction),
      encodeCursor(overrides.cursor.cursor),
    );
  }

  const query = search.toString();
  return query === "" ? basePath : `${basePath}?${query}`;
}
