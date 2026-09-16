import Link from "next/link";
import type { Cursor } from "@/lib/list/cursor";
import type { RawSearchParams } from "@/lib/list/params";
import {
  auditLogIsFiltered,
  buildAuditLogNextHref,
  buildAuditLogSelfHref,
  type AuditLogPage,
  type AuditLogParams,
} from "@/lib/admin/audit-log";
import { formatDateTime } from "@/lib/format/date";
// THE SHARED EMPTY-VALUE MARKER, not a local copy. This file carried its own
// byte-identical `function Absent()` while Phase 7 was on a base that had no
// such module; main extracted one (components/ui/absent.tsx) and
// tests/unit/design/one-absent.test.ts now fails any file that re-declares it
// or inlines its markup -- because the dash being aria-hidden and the sr-only
// text being the real content is an accessibility decision, and a drifted
// twenty-first copy goes silent while looking right.
import { Absent } from "@/components/ui/absent";

// The audit log table, and its one-directional pager.
//
// SAME TABLE IDIOM AS components/list/entity-list.tsx (a real <table>, not
// the ruled-row list -- these columns are the row's own fixed fields, not
// something a reader would ever want a <ul> reading of), same tabular-nums
// rule on the timestamp column, same "scrollable region gets its own
// role/tabIndex/aria-label" wrapper. It is a smaller, bespoke sibling rather
// than a literal reuse of EntityList -- see lib/admin/audit-log.ts's header
// for why this surface cannot be organisation-scoped the way EntityList and
// fetchListPage assume every list is.
//
// THE "NEXT" LINK GOES THROUGH lib/admin/audit-log.ts's buildAuditLogNextHref,
// NOT A HAND-ROLLED URL BUILDER HERE. That function delegates to
// lib/list/params.ts's buildListHref -- the one place `encodeCursor` is
// called at all (tests/unit/list/one-cursor-only.test.ts enforces this as a
// source census) -- carrying the request's own raw searchParams through via
// `preserve` so the five real filters (not expressible as a ListSpec filter;
// see lib/admin/audit-log.ts's header) survive the click unchanged.
export function AuditLogTable({
  page,
  params,
  raw,
  basePath,
}: {
  page: AuditLogPage;
  params: AuditLogParams;
  raw: RawSearchParams;
  basePath: string;
}) {
  const { filters } = params;
  if (page.outcome === "unavailable") {
    return (
      <p
        role="status"
        className="border border-danger bg-surface px-3 py-3 text-base text-ink"
      >
        <span className="font-semibold text-danger">Error.</span> We
        couldn’t load the audit log just now. Refresh the page to try again.
      </p>
    );
  }

  const narrowed = auditLogIsFiltered(filters);

  if (page.rows.length === 0) {
    return (
      <div className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">
          {narrowed ? "No events match" : "No events yet"}
        </h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          {narrowed
            ? "No audit events match the filters you’ve set."
            : "Nothing has written to the audit trail yet."}
        </p>
        {narrowed ? (
          <p className="mt-4">
            <Link
              href={basePath}
              className="text-base text-primary underline underline-offset-4 hover:text-ink"
            >
              Clear filters
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm text-ink-muted">
        <span className="tabular-nums">{page.rows.length}</span>{" "}
        {page.rows.length === 1 ? "event" : "events"} on this page
      </p>

      <div
        role="region"
        aria-label="Audit events table"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-rule-strong">
              <th scope="col" className={HEADER_CLASS}>
                When
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Action
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Target
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Organisation
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Actor
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Correlation
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Before / after
              </th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.id} className="border-b border-rule">
                <td className={`${CELL_CLASS} tabular-nums`}>
                  <time dateTime={row.createdAt}>
                    {formatDateTime(row.createdAt)}
                  </time>
                </td>
                <td className={CELL_CLASS}>
                  <span className="font-semibold text-ink">{row.action}</span>
                </td>
                <td className={CELL_CLASS}>
                  {row.targetType}
                  {row.targetId ? (
                    <>
                      <br />
                      <IdText value={row.targetId} />
                    </>
                  ) : null}
                </td>
                <td className={CELL_CLASS}>
                  {row.organisationId ? (
                    <IdText value={row.organisationId} />
                  ) : (
                    <Absent />
                  )}
                </td>
                <td className={CELL_CLASS}>
                  <IdText value={row.actorUserId} />
                </td>
                <td className={CELL_CLASS}>
                  <IdText value={row.correlationId} />
                </td>
                <td className={CELL_CLASS}>
                  <PayloadDetail label="Before" value={row.before} />
                  <PayloadDetail label="After" value={row.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav
        aria-label="Pagination for audit events"
        className="flex flex-wrap items-center justify-between gap-3 pt-4"
      >
        <p className="text-sm text-ink-muted">
          Showing <span className="tabular-nums">{page.rows.length}</span>{" "}
          {page.rows.length === 1 ? "event" : "events"}
        </p>
        <NextLink
          basePath={basePath}
          params={params}
          raw={raw}
          enabled={page.hasNext && page.lastCursor !== null}
          cursor={page.lastCursor}
        />
      </nav>
    </div>
  );
}

const HEADER_CLASS =
  "px-3 py-2 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase first:pl-0 last:pr-0";
const CELL_CLASS = "px-3 py-2 align-top text-sm text-ink first:pl-0 last:pr-0";

/** An id, in monospace, so it reads as data rather than as prose -- and
 *  never resolved to a name: this table renders ONLY the audit row's own
 *  fields (CLAUDE.md § Superuser dashboard's "no direct tenant-data access"
 *  rule -- see lib/admin/audit-log.ts's header for the fuller argument). */
function IdText({ value }: { value: string }) {
  return (
    <span translate="no" className="font-mono text-xs text-ink-muted">
      {value}
    </span>
  );
}

/** `before`/`after` are exactly what the writing action itself recorded --
 *  an allowlist of identifiers and structure, per SECURITY.md § 7's
 *  "audit payload is an allowlist of identifiers, never user-entered
 *  content" rule, which is enforced where the row is WRITTEN, not here. A
 *  <details> so a dense, mostly-null column does not turn every row into a
 *  wall of JSON by default. */
function PayloadDetail({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <p className="text-xs text-ink-muted">
        {label}: <Absent />
      </p>
    );
  }
  return (
    <details className="text-xs">
      {/* py-1.5 is WCAG 2.2 SC 2.5.8 (target-size), not decoration. These two
          summaries are 16px tall and sit 8px apart, so BOTH the 24x24 size
          rule and the 24px offset rule failed -- and the 35th axe scan missed
          it until Task 6b's fix round, because it had only ever opened the
          FIRST <details> ("Before"), whose <pre> expands BETWEEN the two
          summaries and pushes them apart. Pinning the row and opening "After"
          leaves them adjacent, which is the real resting state of every other
          row on the page. 6px of vertical padding takes each target to 28px,
          satisfying the size rule outright. */}
      <summary className="cursor-pointer py-1.5 text-ink-muted hover:text-ink">
        {label}
      </summary>
      <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-muted">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

/**
 * The one pager link this surface has. Same focus-preserving shape as
 * components/list/list-pager.tsx's PagerLink (an <a>, not conditionally a
 * <span>, so a keyboard user's focus survives the element staying disabled
 * at the end of the log) -- see that file's header for the measurements
 * behind that choice. No "Previous": lib/admin/audit-log.ts's header
 * explains why this surface is forward-only.
 *
 * DISABLED IS A NO-OP, NOT A DROP (fix round 1, Important 1). The href for
 * the disabled branch is the CURRENT view (buildAuditLogSelfHref), not the
 * bare basePath -- see that function's header for why "page one, filters
 * cleared" was the exact lie list-pager.tsx's own `selfHref` exists to
 * prevent, and this component now reproduces the shape it already cited.
 */
function NextLink({
  basePath,
  params,
  raw,
  enabled,
  cursor,
}: {
  basePath: string;
  params: AuditLogParams;
  raw: RawSearchParams;
  enabled: boolean;
  cursor: Cursor | null;
}) {
  const href =
    enabled && cursor
      ? buildAuditLogNextHref(basePath, params, raw, cursor)
      : buildAuditLogSelfHref(basePath, params, raw);
  return (
    <Link
      href={href}
      aria-disabled={enabled ? undefined : true}
      prefetch={enabled ? undefined : false}
      className={
        "inline-flex h-11 items-center border px-4 text-base font-semibold " +
        "whitespace-nowrap transition-colors duration-[var(--dur-fast)] ease-brand " +
        (enabled
          ? "border-rule bg-surface text-ink hover:border-ink hover:bg-shell"
          : "cursor-not-allowed border-rule bg-surface text-ink-muted")
      }
    >
      Next
    </Link>
  );
}
