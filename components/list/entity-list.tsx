import type { ReactNode } from "react";
import Link from "next/link";
import { buildListHref, narrowedBy, type ListParams } from "@/lib/list/params";
import type { ListPage } from "@/lib/list/query";
import type { ListColumn, ListSpec } from "@/lib/list/spec";
import { ListPager } from "./list-pager";

// The shared CRM list surface: count, table, sort controls, pager, and the
// three states a list is actually in most of the time.
//
// A SERVER COMPONENT, with no client JavaScript of its own. Sorting is a set
// of links, paging is two links, and the rows are HTML. Only the search and
// filter strip is a Client Component, and only because it pushes a route.
//
// ===========================================================================
// A TABLE, NOT THE RULED LIST
// ===========================================================================
// components/ui/ruled-row.tsx is this product's structural signature and every
// existing list uses it. This one deliberately does not, and the reason is
// semantic rather than visual: these columns SORT. The accessible expression
// of "this column is sorted ascending, activate to reverse it" is `aria-sort`
// on a `<th>`, and there is no `<th>` in a `<ul>`. A sortable list built out
// of list items has to reinvent the association between a control at the top
// and the values below it, and reinventing it is how it ends up wrong.
//
// The visual language is unchanged -- hairline rules, name in semibold ink,
// detail in muted, a heavier rule under the header instead of a lighter one.
// It reads as the same door list; it just tells assistive technology the
// truth about being a table. DESIGN.md § Numerals' `tabular-nums` rule is why
// the date column is marked `numeric`.
// ===========================================================================

interface EntityListProps<TRow, TSort extends string, TFilter extends string> {
  spec: ListSpec<TSort, TFilter>;
  params: ListParams<TSort, TFilter>;
  basePath: string;
  page: ListPage<TRow>;
  columns: readonly ListColumn<TRow, TSort>[];
  rowKey: (row: TRow) => string;
  /** True when a search or filter is narrowing -- picks the empty state. */
  narrowed: boolean;
  /** Shown when the entity has no records at all. Teaches the workflow. */
  emptyState: ReactNode;
  /**
   * One muted line explaining WHY a viewer might be seeing fewer rows than
   * their colleagues. See the Contacts page for why this is not optional.
   */
  scopeNote?: ReactNode;
}

export function EntityList<TRow, TSort extends string, TFilter extends string>({
  spec,
  params,
  basePath,
  page,
  columns,
  rowKey,
  narrowed,
  emptyState,
  scopeNote,
}: EntityListProps<TRow, TSort, TFilter>) {
  // A FAILED QUERY IS NOT AN EMPTY LIST. Foundation shipped exactly that on
  // the members page and it is still in FOLLOW-UPS.md; the brief names it as
  // a thing this component must not repeat. "0 contacts" is a claim about the
  // customer's data and it would be false.
  if (page.outcome === "unavailable") {
    return (
      <div className="flex flex-col gap-4">
        <p
          role="status"
          className="border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We
          couldn’t load {spec.noun.many} just now. Refresh the page to try
          again — nothing has been deleted.
        </p>
      </div>
    );
  }

  const { rows, total } = page;

  return (
    <div className="flex flex-col gap-4">
      {/* The count, and the only live region on the page.
          role="status" is polite, so it does not interrupt; it is here rather
          than on the table because the number is the thing that changed.
          Honest limit, recorded in the task report: this element is inside the
          streamed results boundary, so on a client-side navigation it is
          replaced rather than updated, and whether a screen reader announces a
          replaced live region is implementation-dependent. No screen reader
          was available to check -- see the report. */}
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm text-ink-muted">
          {total === null ? (
            <>
              <span className="tabular-nums">{rows.length}</span>{" "}
              {rows.length === 1 ? spec.noun.one : spec.noun.many} on this page
            </>
          ) : (
            <>
              <span className="tabular-nums">{total}</span>{" "}
              {total === 1 ? spec.noun.one : spec.noun.many}
              {matchSuffix(narrowedBy(spec, params))}
            </>
          )}
          {" · sorted by "}
          {spec.sort[params.sort].label.toLowerCase()}
          {", "}
          {spec.sort[params.sort].directionLabels[params.dir]}
        </p>
        {scopeNote}
      </div>

      {rows.length === 0 ? (
        narrowed ? (
          // Two empty states, not one. "Nothing here yet" is a lie when the
          // user has just searched for a name nobody has -- their next action
          // is to widen the search, not to create a record, and the copy has
          // to offer that instead.
          <div className="border border-rule bg-surface p-5">
            <h2 className="text-xl font-bold text-ink">
              No {spec.noun.many} match
            </h2>
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              {params.q !== "" ? (
                <>
                  Nothing here is called{" "}
                  <span className="font-semibold text-ink">“{params.q}”</span>.
                  Try a shorter piece of the name — search matches anywhere in
                  it, not just the start.
                </>
              ) : (
                <>
                  No {spec.noun.many} match the filters you’ve set.
                </>
              )}
            </p>
            <p className="mt-4">
              <Link
                href={basePath}
                className="text-base text-primary underline underline-offset-4 hover:text-ink"
              >
                Clear search and filters
              </Link>
            </p>
          </div>
        ) : (
          emptyState
        )
      ) : (
        <>
          {/* A wide table scrolls INSIDE this box, never the page (hallmark
              gate 34: no horizontal scroll on the document at any width).
              tabIndex + a name because a scrollable region has to be
              reachable and identifiable from the keyboard -- WCAG 2.1.1. */}
          <div
            role="region"
            aria-label={`${spec.noun.many} table`}
            tabIndex={0}
            className="overflow-x-auto"
          >
            <table className="w-full border-collapse text-left">
              <thead>
                {/* The heavier rule under the header is DESIGN.md's "emphasis
                    comes from swapping --rule for --rule-strong, never from
                    thickening to 2px". */}
                <tr className="border-b border-rule-strong">
                  {columns.map((column) => (
                    <HeaderCell
                      key={column.key}
                      column={column}
                      spec={spec}
                      params={params}
                      basePath={basePath}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={rowKey(row)} className="border-b border-rule">
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cellClass(column)}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ListPager
            spec={spec}
            params={params}
            basePath={basePath}
            hasPrevious={page.hasPrevious}
            hasNext={page.hasNext}
            firstCursor={page.firstCursor}
            lastCursor={page.lastCursor}
            shown={rows.length}
            noun={spec.noun}
          />
        </>
      )}
    </div>
  );
}

/**
 * Names what is narrowing the list, or nothing when nothing is.
 *
 * "matching", not "match": the count in front of it is 0, 1 or many, and
 * "1 contact match your search" was on screen in the browser pass. A
 * participle agrees with all three without a second plural branch.
 */
function matchSuffix(by: { search: boolean; filters: boolean }): string {
  if (by.search && by.filters) return " matching your search and filters";
  if (by.search) return " matching your search";
  if (by.filters) return " matching your filters";
  return "";
}

function cellClass<TRow, TSort extends string>(
  column: ListColumn<TRow, TSort>,
): string {
  return [
    // DESIGN.md § Spacing: "Dense table rows use --space-2 vertical padding,
    // --space-3 horizontal."
    "px-3 py-2 align-top text-sm text-ink first:pl-0 last:pr-0",
    column.numeric ? "tabular-nums" : "",
    column.secondary ? "hidden sm:table-cell" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function HeaderCell<TRow, TSort extends string, TFilter extends string>({
  column,
  spec,
  params,
  basePath,
}: {
  column: ListColumn<TRow, TSort>;
  spec: ListSpec<TSort, TFilter>;
  params: ListParams<TSort, TFilter>;
  basePath: string;
}) {
  const base =
    "px-3 py-2 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase " +
    "first:pl-0 last:pr-0 " +
    (column.secondary ? "hidden sm:table-cell " : "") +
    (column.numeric ? "tabular-nums " : "");

  if (!column.sortKey) {
    return (
      <th scope="col" className={base}>
        {column.header}
      </th>
    );
  }

  const active = params.sort === column.sortKey;
  const nextDirection = active
    ? params.dir === "asc"
      ? "desc"
      : "asc"
    : undefined;

  return (
    <th
      scope="col"
      // The ARIA sortable-table pattern: the state lives on the header cell,
      // the control's name is just the column name. "none" on the other
      // sortable columns rather than omitting it, so a screen reader can tell
      // a sortable column from a fixed one.
      aria-sort={
        active ? (params.dir === "asc" ? "ascending" : "descending") : "none"
      }
      className={base}
    >
      <Link
        href={buildListHref(spec, basePath, params, {
          sort: column.sortKey,
          dir: nextDirection,
        })}
        className="inline-flex items-center gap-1 text-ink-muted hover:text-ink hover:underline hover:underline-offset-4"
      >
        {column.header}
        {/* A glyph, not a colour -- DESIGN.md forbids colour as the only
            signal, and aria-sort above carries the same fact for anyone not
            looking at it. Hidden from assistive tech so it is not read as
            punctuation after the column name. */}
        {active ? (
          <span aria-hidden="true">{params.dir === "asc" ? "↑" : "↓"}</span>
        ) : null}
      </Link>
    </th>
  );
}
