import Link from "next/link";
import type { Cursor } from "@/lib/list/cursor";
import { toolbarParamNames, type RawSearchParams } from "@/lib/list/params";
import {
  DSR_FILTER_PARAMS,
  DSR_SPEC,
  buildDsrNextHref,
  buildDsrSelfHref,
  dsrQueueIsFiltered,
  type DsrNote,
  type DsrQueuePage,
  type DsrQueueParams,
  type DsrQueueRow,
} from "@/lib/dsr/queue";
import {
  DSR_ALERT_LEAD_DAYS,
  DSR_RIGHTS,
  DSR_RIGHT_COPY,
  DSR_SCOPE_COPY,
  DSR_STATUSES,
  DSR_STATUS_LABELS,
  describeDeadline,
  dsrUrgency,
  isDsrRight,
  isDsrScope,
  isDsrStatus,
} from "@/lib/dsr/contract";
import { formatDateTime } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { DsrTransitionForms } from "@/components/admin/dsr-transition-forms";
import { DsrNoteForm } from "@/components/admin/dsr-note-form";

// The operator's data subject request queue: a filter strip, the rows oldest
// deadline first, a forward pager.
//
// THE INCIDENT-ALERT AND FEEDBACK IDIOM: a plain native GET form keyed on the
// view it was rendered for, uncontrolled inputs, no client toolbar, works with
// JavaScript off.
//
// OVERDUE IS IMPOSSIBLE TO MISS, AND NOT BY COLOUR ALONE. DESIGN.md forbids
// telling states apart by hue (--success shares its value with --primary), so
// an overdue row carries a word — "OVERDUE" — in a bordered chip, the
// deadline sentence says how many days late in text, and the row's left edge
// is a --danger rule. Three signals, of which colour is the least.
//
// METADATA AND THE REQUESTER'S OWN WORDS. There is no tenant CRM content on
// this page, and cannot be: the tables behind it hold none. The requester's
// detail is rendered inert (text, pre-wrap, never HTML).

const SELECT_CLASS =
  "h-11 w-full min-w-0 border border-rule bg-surface px-3 text-base text-ink " +
  "transition-colors duration-[var(--dur-fast)] ease-brand hover:border-ink focus:border-accent";
const INPUT_CLASS =
  "h-11 w-full min-w-0 border border-rule bg-surface px-3 text-base text-ink " +
  "placeholder:text-ink-muted transition-colors duration-[var(--dur-fast)] " +
  "ease-brand hover:border-ink focus:border-accent";
const LABEL_CLASS = "text-base font-semibold text-ink";
const CHIP_CLASS =
  "inline-flex items-center border border-rule-strong px-2 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase text-ink";
const OVERDUE_CHIP_CLASS =
  "inline-flex items-center border border-danger px-2 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase text-danger";

function FilterStrip({ params, basePath }: { params: DsrQueueParams; basePath: string }) {
  const { filters } = params;
  const narrowed = dsrQueueIsFiltered(params);
  const searchName = toolbarParamNames(DSR_SPEC).q;

  return (
    <form
      key={`${filters.status ?? ""}|${filters.right ?? ""}|${filters.openOnly ? "open" : "all"}|${params.list.q}`}
      action={basePath}
      method="get"
      className="flex flex-wrap items-end gap-x-4 gap-y-4 border-y border-rule py-4"
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="dsr-search">
          {DSR_SPEC.searchLabel}
        </label>
        <input
          id="dsr-search"
          name={searchName}
          type="search"
          defaultValue={params.list.q}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex min-w-0 basis-48 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="dsr-status">
          State
        </label>
        <select
          id="dsr-status"
          name={DSR_FILTER_PARAMS.status}
          defaultValue={filters.status ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Still open</option>
          {DSR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DSR_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 basis-56 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="dsr-right">
          Right
        </label>
        <select
          id="dsr-right"
          name={DSR_FILTER_PARAMS.right}
          defaultValue={filters.right ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Any right</option>
          {DSR_RIGHTS.map((r) => (
            <option key={r} value={r}>
              {DSR_RIGHT_COPY[r].label}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" variant="secondary">
        Filter
      </Button>

      {narrowed ? (
        <Link
          href={basePath}
          className="flex h-11 items-center text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Clear filters
        </Link>
      ) : (
        <Link
          href={`${basePath}?${DSR_FILTER_PARAMS.open}=all`}
          className="flex h-11 items-center text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Show closed requests too
        </Link>
      )}
    </form>
  );
}

function Row({ row, notes }: { row: DsrQueueRow; notes: readonly DsrNote[] }) {
  const urgency = dsrUrgency(row.status, row.dueBy);
  const right = isDsrRight(row.rightType) ? DSR_RIGHT_COPY[row.rightType].label : row.rightType;
  const scope = isDsrScope(row.subjectScope)
    ? DSR_SCOPE_COPY[row.subjectScope].label
    : row.subjectScope;
  const status = isDsrStatus(row.status) ? DSR_STATUS_LABELS[row.status] : row.status;

  return (
    <li
      data-testid="dsr-row"
      data-urgency={urgency}
      className={
        "flex flex-col gap-3 border-b border-rule py-4 " +
        (urgency === "overdue" ? "border-l-2 border-l-danger pl-4" : "")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {urgency === "overdue" ? (
          <span className={OVERDUE_CHIP_CLASS} data-testid="dsr-overdue-chip">
            Overdue
          </span>
        ) : null}
        {urgency === "due_soon" ? <span className={CHIP_CLASS}>Due soon</span> : null}
        <span className={CHIP_CLASS}>{status}</span>
        <span className={CHIP_CLASS}>{right}</span>
        <span
          className={urgency === "overdue" ? "text-sm font-semibold text-danger" : "text-sm text-ink-muted"}
          data-testid="dsr-deadline"
        >
          {describeDeadline(row.status, row.dueBy)} · due {formatDateTime(row.dueBy)}
        </span>
      </div>

      <dl className="grid max-w-prose grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-muted">From</dt>
        <dd className="text-ink" translate="no">
          {row.userEmail}
        </dd>
        <dt className="text-ink-muted">About</dt>
        <dd className="text-ink">{scope}</dd>
        <dt className="text-ink-muted">Received</dt>
        <dd className="text-ink tabular-nums">{formatDateTime(row.requestedAt)}</dd>
        {row.routedAt ? (
          <>
            <dt className="text-ink-muted">Passed to</dt>
            <dd className="text-ink">
              {row.routedToOrganisationName} on{" "}
              <span className="tabular-nums">{formatDateTime(row.routedAt)}</span>
            </dd>
          </>
        ) : null}
        {row.fulfilmentKind ? (
          <>
            <dt className="text-ink-muted">Fulfilment</dt>
            <dd className="text-ink">{row.fulfilmentKind} recorded</dd>
          </>
        ) : null}
      </dl>

      {/* THE REQUESTER'S OWN WORDS, inert. Never HTML. */}
      <p className="max-w-prose whitespace-pre-wrap text-base text-ink" data-testid="dsr-detail">
        {row.detail}
      </p>

      {row.rejectionReason ? (
        <div className="flex max-w-prose flex-col gap-1 border-l-2 border-rule pl-4">
          <p className="text-sm text-ink-muted">Refused, and the requester reads this</p>
          <p className="whitespace-pre-wrap text-base text-ink">{row.rejectionReason}</p>
        </div>
      ) : null}

      <section className="flex max-w-prose flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">
          Internal notes{" "}
          <span className="font-normal text-ink-muted">
            — the requester never sees these ({row.noteCount})
          </span>
        </h3>
        {notes.length === 0 ? (
          <p className="text-sm text-ink-muted">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="border-l-2 border-rule pl-3">
                <p className="whitespace-pre-wrap text-sm text-ink">{note.body}</p>
                <p className="text-xs text-ink-muted tabular-nums">
                  {formatDateTime(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <DsrNoteForm requestId={row.id} />
      </section>

      <DsrTransitionForms row={row} />
    </li>
  );
}

function NextLink({
  basePath,
  params,
  raw,
  enabled,
  cursor,
}: {
  basePath: string;
  params: DsrQueueParams;
  raw: RawSearchParams;
  enabled: boolean;
  cursor: Cursor | null;
}) {
  const href =
    enabled && cursor
      ? buildDsrNextHref(basePath, params, raw, cursor)
      : buildDsrSelfHref(basePath, params, raw);
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

export function DsrQueue({
  page,
  params,
  raw,
  basePath,
  notesByRequest,
}: {
  page: DsrQueuePage;
  params: DsrQueueParams;
  raw: RawSearchParams;
  basePath: string;
  notesByRequest: ReadonlyMap<string, readonly DsrNote[]>;
}) {
  const narrowed = dsrQueueIsFiltered(params);

  if (page.outcome === "unavailable") {
    return (
      <>
        <FilterStrip params={params} basePath={basePath} />
        <p
          role="status"
          className="max-w-prose border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t load the
          request queue just now. Refresh the page to try again.
        </p>
      </>
    );
  }

  const overdue = page.rows.filter((row) => dsrUrgency(row.status, row.dueBy) === "overdue");

  return (
    <>
      <FilterStrip params={params} basePath={basePath} />
      {overdue.length > 0 ? (
        <p
          role="status"
          data-testid="dsr-overdue-banner"
          className="max-w-prose border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">
            {overdue.length === 1
              ? "1 request on this page is past its statutory deadline."
              : `${overdue.length} requests on this page are past their statutory deadline.`}
          </span>{" "}
          The 30-day limit is the law’s, not a target. An alert for each is on{" "}
          <Link
            href="/super/health"
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            platform health
          </Link>{" "}
          and in the incident email.
        </p>
      ) : null}
      {page.rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          {narrowed
            ? "No request matches the search or filters you’ve set."
            : "No open requests. Everything that has been asked for has been answered, refused or withdrawn."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col border-t border-rule">
            {page.rows.map((row) => (
              <Row key={row.id} row={row} notes={notesByRequest.get(row.id) ?? []} />
            ))}
          </ul>
          <nav
            aria-label="Pagination for data subject requests"
            className="flex flex-wrap items-center justify-between gap-3 pt-2"
          >
            <p className="text-sm text-ink-muted">
              Showing <span className="tabular-nums">{page.rows.length}</span>{" "}
              {page.rows.length === 1 ? "request" : "requests"}, nearest deadline first. A
              request raises an alert {DSR_ALERT_LEAD_DAYS} days before its deadline and again
              once it passes.
            </p>
            <NextLink
              basePath={basePath}
              params={params}
              raw={raw}
              enabled={page.hasNext && page.lastCursor !== null}
              cursor={page.lastCursor}
            />
          </nav>
        </>
      )}
    </>
  );
}
