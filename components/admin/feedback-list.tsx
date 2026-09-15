import Link from "next/link";
import type { Cursor } from "@/lib/list/cursor";
import { toolbarParamNames, type RawSearchParams } from "@/lib/list/params";
import {
  FEEDBACK_FILTER_PARAMS,
  FEEDBACK_SPEC,
  buildFeedbackNextHref,
  buildFeedbackSelfHref,
  feedbackIsFiltered,
  type FeedbackPage,
  type FeedbackParams,
  type FeedbackRow,
} from "@/lib/feedback/list";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  SUPPORT_ACCESS_LABEL,
  isFeedbackCategory,
  isFeedbackStatus,
} from "@/lib/feedback/contract";
import { formatDateTime } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { FeedbackStatusForm } from "@/components/admin/feedback-status-form";

// The superuser's feedback list: a filter strip, the rows, a forward pager.
// The incident-alert list's idiom (components/admin/incident-alert-list.tsx):
// a plain native GET form keyed on the view it was rendered for, uncontrolled
// inputs, no client toolbar, works with JavaScript off.
//
// STATUS AND CATEGORY ARE CHIPS, per DESIGN.md § Palette: "Status is always a
// chip: --rule-strong border, uppercase label at --text-xs, never bare
// coloured text." Neither carries a colour -- the label IS the information.
//
// THE MESSAGE IS RENDERED AS TEXT. `white-space: pre-wrap` keeps the
// submitter's line breaks; nothing is parsed, nothing goes through
// dangerouslySetInnerHTML. This is the one platform surface that shows
// user-entered content on purpose (the founder reads feedback), and it shows
// it inert.

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

function FilterStrip({ params, basePath }: { params: FeedbackParams; basePath: string }) {
  const { filters } = params;
  const narrowed = feedbackIsFiltered(params);
  const searchName = toolbarParamNames(FEEDBACK_SPEC).q;

  return (
    <form
      key={`${filters.orgSlug ?? ""}|${filters.category ?? ""}|${filters.status ?? ""}|${filters.from ?? ""}|${filters.to ?? ""}|${params.list.q}`}
      action={basePath}
      method="get"
      className="flex flex-wrap items-end gap-x-4 gap-y-4 border-y border-rule py-4"
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="feedback-search">
          {FEEDBACK_SPEC.searchLabel}
        </label>
        <input
          id="feedback-search"
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
        <label className={LABEL_CLASS} htmlFor="feedback-org">
          Workspace slug
        </label>
        <input
          id="feedback-org"
          name={FEEDBACK_FILTER_PARAMS.org}
          type="text"
          defaultValue={filters.orgSlug ?? ""}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={64}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex min-w-0 basis-40 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="feedback-category">
          Category
        </label>
        <select
          id="feedback-category"
          name={FEEDBACK_FILTER_PARAMS.category}
          defaultValue={filters.category ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Any category</option>
          {FEEDBACK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {FEEDBACK_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 basis-40 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="feedback-status">
          Status
        </label>
        <select
          id="feedback-status"
          name={FEEDBACK_FILTER_PARAMS.status}
          defaultValue={filters.status ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Any status</option>
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FEEDBACK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 basis-40 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="feedback-from">
          From (UTC date)
        </label>
        <input
          id="feedback-from"
          name={FEEDBACK_FILTER_PARAMS.from}
          type="date"
          defaultValue={filters.from ?? ""}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex min-w-0 basis-40 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="feedback-to">
          To (UTC date)
        </label>
        <input
          id="feedback-to"
          name={FEEDBACK_FILTER_PARAMS.to}
          type="date"
          defaultValue={filters.to ?? ""}
          className={INPUT_CLASS}
        />
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
      ) : null}
    </form>
  );
}

const SCREENSHOT_COPY: Record<Exclude<FeedbackRow["screenshot"], "none" | "clean">, string> = {
  quarantined: "Screenshot quarantined by the malware scanner — not viewable.",
  error: "Screenshot attached but unscanned — withheld.",
};

function Row({ row, basePath }: { row: FeedbackRow; basePath: string }) {
  const category = isFeedbackCategory(row.category)
    ? FEEDBACK_CATEGORY_LABELS[row.category]
    : row.category;
  const status = isFeedbackStatus(row.status)
    ? FEEDBACK_STATUS_LABELS[row.status]
    : row.status;

  return (
    <li className="flex flex-col gap-3 border-b border-rule py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={CHIP_CLASS}>{category}</span>
        <span className={CHIP_CLASS}>{status}</span>
        {row.duringSupportAccess ? (
          <span className={CHIP_CLASS}>{SUPPORT_ACCESS_LABEL}</span>
        ) : null}
        <span className="text-sm text-ink-muted">
          Submitted {formatDateTime(row.createdAt)}
          {row.notifiedAt === null ? " · email not sent" : ""}
        </span>
      </div>
      <dl className="grid max-w-prose grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-muted">From</dt>
        <dd className="text-ink" translate="no">
          {row.userEmail ?? "(email unavailable)"}
        </dd>
        <dt className="text-ink-muted">Workspace</dt>
        <dd className="text-ink">
          {/* Q121: a support-access submission carries NO workspace by
              design, and saying "Not inside a workspace" would hide the one
              fact that explains the row. The label is read from the column
              the database stamps, never inferred from a null organisation --
              /invites, /onboarding and /super all produce null-org rows that
              are nothing to do with support access. */}
          {row.duringSupportAccess
            ? SUPPORT_ACCESS_LABEL
            : (row.organisationName ?? "Not inside a workspace")}
          {row.organisationRole ? ` · ${row.organisationRole}` : ""}
        </dd>
        <dt className="text-ink-muted">Page</dt>
        <dd className="text-ink" translate="no">
          {row.route}
        </dd>
        <dt className="text-ink-muted">Browser</dt>
        <dd className="break-all text-ink-muted">{row.userAgent ?? "—"}</dd>
      </dl>
      <p className="max-w-prose whitespace-pre-wrap text-base text-ink">{row.message}</p>
      {row.screenshot === "clean" ? (
        <p className="text-sm">
          {/* A LINK TO THE ROUTE HANDLER, NOT AN <img>. An inline image would
              issue the audited signed URL on every render and every prefetch;
              a link makes each view a deliberate, audited act. prefetch={false}
              for the same reason. */}
          <Link
            href={`${basePath}/${row.id}/screenshot`}
            prefetch={false}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            View screenshot
          </Link>
          <span className="text-ink-muted"> — opening it is recorded in the audit log.</span>
        </p>
      ) : row.screenshot === "none" ? null : (
        <p className="text-sm text-ink-muted">{SCREENSHOT_COPY[row.screenshot]}</p>
      )}
      <FeedbackStatusForm feedbackId={row.id} status={row.status} />
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
  params: FeedbackParams;
  raw: RawSearchParams;
  enabled: boolean;
  cursor: Cursor | null;
}) {
  const href =
    enabled && cursor
      ? buildFeedbackNextHref(basePath, params, raw, cursor)
      : buildFeedbackSelfHref(basePath, params, raw);
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

export function FeedbackList({
  page,
  params,
  raw,
  basePath,
}: {
  page: FeedbackPage;
  params: FeedbackParams;
  raw: RawSearchParams;
  basePath: string;
}) {
  const narrowed = feedbackIsFiltered(params);

  if (page.outcome === "unavailable") {
    return (
      <>
        <FilterStrip params={params} basePath={basePath} />
        <p role="status" className="max-w-prose border border-danger bg-surface px-3 py-3 text-base text-ink">
          <span className="font-semibold text-danger">Error.</span> We couldn’t load
          the feedback just now. Refresh the page to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <FilterStrip params={params} basePath={basePath} />
      {page.rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          {narrowed
            ? "No feedback matches the search or filters you’ve set."
            : "No feedback yet. Submissions from the “Feedback” control in the site header land here, and a receipt is emailed to the support contact."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col border-t border-rule">
            {page.rows.map((row) => (
              <Row key={row.id} row={row} basePath={basePath} />
            ))}
          </ul>
          <nav
            aria-label="Pagination for feedback"
            className="flex flex-wrap items-center justify-between gap-3 pt-2"
          >
            <p className="text-sm text-ink-muted">
              Showing <span className="tabular-nums">{page.rows.length}</span>{" "}
              {page.rows.length === 1 ? "submission" : "submissions"}
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
