import Link from "next/link";
import type { RawSearchParams } from "@/lib/list/params";
import type { ListPage, RecoveryReason } from "@/lib/list/query";
import { ListPager } from "@/components/list/list-pager";
import {
  FINANCIAL_ENTRY_LIST,
  type FinancialEntryRow,
  type FinancialEntryParams,
} from "@/lib/crm/finance-list";
import type {
  LinkedName,
  RemovedFinancialEntry,
} from "@/lib/crm/finance-queries";
import {
  netMinor,
  type EventFinanceSummary,
} from "@/lib/crm/finance-summary";
import { FinanceCategoryChip, FinanceStatusChip } from "@/components/crm/finance-chip";
import {
  AddFinanceForm,
  DeleteFinanceForm,
  FinanceEditForm,
  RestoreFinanceForm,
  type FinanceFieldValues,
  type PickerOption,
} from "@/components/crm/finance-forms";
import { formatGbp } from "@/lib/format/money";
import { formatDateOnly, formatDateTime } from "@/lib/format/date";

// The event finance panel: a budget-vs-actuals summary, the line-item list,
// and the add/edit/soft-delete affordances -- visible and writable only through
// the three gates Task 1 built.
//
// A SERVER COMPONENT. Only the forms are client code, in
// components/crm/finance-forms.tsx -- whose header carries the measurement that
// forces the split (a client component importing `ListPager` throws
// `Unknown encoding: base64url` at hydration). The division is exactly the one
// the lineup panel draws: summary, list, pager and links are server-rendered.
//
// TWO GATES, DECIDED BY THE PAGE, NOT HERE:
//   RENDER  the page mounts this panel only when the caller holds view_finance
//           (hasPermission). Without it there is no panel AND the view returns
//           no rows (Constraint 12) -- so this component always assumes the
//           caller may READ.
//   WRITE   `disabledReason` is null when the caller may write (getFinanceWrite
//           Access), and otherwise the sentence explaining why not (tier /
//           permission / suspended, or DELETED_RECORD_EXPLANATION on a deleted
//           event). Controls are DISABLED with it, never hidden.
//
// tabular-nums ON EVERY MONEY VALUE AND EVERY DATE (DESIGN.md § Numerals): this
// is the phase where money lives in tables, the highest-exposure case.

/** The id of the single explanation every disabled control points at. */
const NOTE_ID = "finance-blocked";

interface FinancePanelProps {
  orgSlug: string;
  eventId: string;
  /** The event's own URL. The pager builds its links from it. */
  basePath: string;
  summary: EventFinanceSummary;
  page: ListPage<FinancialEntryRow>;
  params: FinancialEntryParams;
  removed: readonly RemovedFinancialEntry[];
  artistNames: ReadonlyMap<string, LinkedName>;
  supplierNames: ReadonlyMap<string, LinkedName>;
  /** Live artists / contacts to offer in the pickers, capped by the server.
   *  Empty when the caller cannot write (no form to put them in). */
  artistOptions: readonly PickerOption[];
  supplierOptions: readonly PickerOption[];
  /** Null when the caller may write; otherwise the reason the controls explain. */
  disabledReason: string | null;
  /** The page's whole searchParams, so this list's links keep the other five
   *  surfaces' query state (Constraint 10). */
  preserve?: RawSearchParams;
}

export function FinancePanel({
  orgSlug,
  eventId,
  basePath,
  summary,
  page,
  params,
  removed,
  artistNames,
  supplierNames,
  artistOptions,
  supplierOptions,
  disabledReason,
  preserve,
}: FinancePanelProps) {
  const disabled = disabledReason !== null;

  return (
    <section
      aria-labelledby="finance-heading"
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <h2 id="finance-heading" className="text-xl font-bold text-ink">
        Finance
      </h2>

      {disabledReason !== null ? (
        <p
          id={NOTE_ID}
          className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted"
        >
          <span className="font-semibold text-ink">Read-only.</span>{" "}
          {disabledReason}
        </p>
      ) : null}

      <SummaryTable summary={summary} />

      {/* A FAILED QUERY IS NOT AN EMPTY SHEET. "This event has no finance lines"
          is a claim about the customer's data; making it because a query failed
          reads as deletion -- the same rule every list surface follows. */}
      {page.outcome === "unavailable" ? (
        <p
          role="status"
          className="border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t
          load this event’s finance lines just now. Refresh the page to try
          again — nothing has been removed.
        </p>
      ) : (
        <LineItems
          orgSlug={orgSlug}
          eventId={eventId}
          page={page}
          params={params}
          basePath={basePath}
          artistNames={artistNames}
          supplierNames={supplierNames}
          artistOptions={artistOptions}
          supplierOptions={supplierOptions}
          disabled={disabled}
          preserve={preserve}
        />
      )}

      {removed.length > 0 ? (
        <RemovedLines
          orgSlug={orgSlug}
          eventId={eventId}
          removed={removed}
          disabled={disabled}
        />
      ) : null}

      <AddFinanceForm
        orgSlug={orgSlug}
        eventId={eventId}
        artistOptions={artistOptions}
        supplierOptions={supplierOptions}
        disabled={disabled}
        noteId={NOTE_ID}
      />
    </section>
  );
}

/**
 * The budget-vs-actuals summary: two data columns (Budgeted, Actual), three
 * rows (Gross, Expense, Net).
 *
 * Net is COMPUTED here from the two view columns (`gross - expense`), never a
 * fourth stored aggregate -- 20260903010000's header and lib/crm/finance-
 * summary.ts. Every cell is tabular-nums; the net cell carries a TEXT label of
 * the sign ("surplus"/"deficit"/"break-even") beside the figure, coloured
 * --success/--danger, so the sign is never colour alone (DESIGN.md § Working
 * palette).
 */
function SummaryTable({ summary }: { summary: EventFinanceSummary }) {
  const budgetedNet = netMinor(summary.budgetedGrossMinor, summary.budgetedExpenseMinor);
  const actualNet = netMinor(summary.actualGrossMinor, summary.actualExpenseMinor);

  return (
    <div role="region" aria-label="Budget versus actuals" tabIndex={0} className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Budget versus actuals for this event</caption>
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="px-3 py-2 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase first:pl-0">
              &nbsp;
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase tabular-nums">
              Budgeted
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase tabular-nums last:pr-0">
              Actual
            </th>
          </tr>
        </thead>
        <tbody>
          <MoneyRow
            label="Gross"
            budgetedMinor={summary.budgetedGrossMinor}
            actualMinor={summary.actualGrossMinor}
          />
          <MoneyRow
            label="Expense"
            budgetedMinor={summary.budgetedExpenseMinor}
            actualMinor={summary.actualExpenseMinor}
          />
          <tr className="border-t border-rule-strong">
            <th scope="row" className="px-3 py-2 text-sm font-bold text-ink first:pl-0">
              Net
            </th>
            <td className="px-3 py-2 text-right text-sm tabular-nums">
              <NetCell netMinor={budgetedNet} />
            </td>
            <td className="px-3 py-2 text-right text-sm tabular-nums last:pr-0">
              <NetCell netMinor={actualNet} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MoneyRow({
  label,
  budgetedMinor,
  actualMinor,
}: {
  label: string;
  budgetedMinor: number;
  actualMinor: number;
}) {
  return (
    <tr className="border-b border-rule">
      <th scope="row" className="px-3 py-2 text-sm font-semibold text-ink first:pl-0">
        {label}
      </th>
      <td className="px-3 py-2 text-right text-sm text-ink tabular-nums">
        {formatGbp(budgetedMinor)}
      </td>
      <td className="px-3 py-2 text-right text-sm text-ink tabular-nums last:pr-0">
        {formatGbp(actualMinor)}
      </td>
    </tr>
  );
}

/** The net figure with a text sign-label beside it. Colour REINFORCES the word,
 *  never replaces it. */
function NetCell({ netMinor: value }: { netMinor: number }) {
  const tone =
    value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-ink-muted";
  const word = value > 0 ? "surplus" : value < 0 ? "deficit" : "break-even";
  return (
    <span className={`font-semibold ${tone}`}>
      {formatGbp(value)}{" "}
      <span className="text-xs font-normal uppercase tracking-wide">{word}</span>
    </span>
  );
}

/** One sentence per recovery cause -- the same three EntityList renders. */
const RECOVERY_NOTICE: Record<NonNullable<RecoveryReason>, string> = {
  "past-end":
    "That link pointed past the end of this list, so this is the first page.",
  "before-start":
    "That link pointed before the start of this list, so this is the first page.",
  "stale-sort":
    "That link was made under a different order, so this is the first page.",
};

function LineItems({
  orgSlug,
  eventId,
  page,
  params,
  basePath,
  artistNames,
  supplierNames,
  artistOptions,
  supplierOptions,
  disabled,
  preserve,
}: {
  orgSlug: string;
  eventId: string;
  page: Extract<ListPage<FinancialEntryRow>, { outcome: "loaded" }>;
  params: FinancialEntryParams;
  basePath: string;
  artistNames: ReadonlyMap<string, LinkedName>;
  supplierNames: ReadonlyMap<string, LinkedName>;
  artistOptions: readonly PickerOption[];
  supplierOptions: readonly PickerOption[];
  disabled: boolean;
  preserve?: RawSearchParams;
}) {
  const { rows, total } = page;

  if (rows.length === 0) {
    return (
      <div className="border border-rule bg-surface p-5">
        <h3 className="text-lg font-bold text-ink">No finance lines yet</h3>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          Add the fees, costs and income for this event. Mark each as budgeted or
          actual, and the summary above fills in as you go.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm text-ink-muted">
          {total === null ? (
            <>
              <span className="tabular-nums">{rows.length}</span>{" "}
              {rows.length === 1
                ? FINANCIAL_ENTRY_LIST.noun.one
                : FINANCIAL_ENTRY_LIST.noun.many}{" "}
              on this page
            </>
          ) : (
            <>
              <span className="tabular-nums">{total}</span>{" "}
              {total === 1
                ? FINANCIAL_ENTRY_LIST.noun.one
                : FINANCIAL_ENTRY_LIST.noun.many}
            </>
          )}
          {" · latest first"}
        </p>
        {page.recovered ? (
          <p role="status" className="text-sm text-ink-muted">
            {RECOVERY_NOTICE[page.recovered]}
          </p>
        ) : null}
      </div>

      <ul role="list" className="flex flex-col border-t border-rule">
        {rows.map((row) => {
          const label = row.description || "this finance line";
          return (
            <li key={row.id} className="flex flex-col gap-3 border-b border-rule py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <time dateTime={row.occurredOn} className="text-sm text-ink-muted tabular-nums">
                    {formatDateOnly(row.occurredOn)}
                  </time>
                  <FinanceCategoryChip category={row.category} />
                  <FinanceStatusChip status={row.status} />
                  {row.description ? (
                    <span className="break-words text-base text-ink">
                      {row.description}
                    </span>
                  ) : (
                    <span className="text-base text-ink-muted italic">
                      No description
                    </span>
                  )}
                  <LinkedNames
                    orgSlug={orgSlug}
                    artistId={row.artistId}
                    supplierContactId={row.supplierContactId}
                    artistNames={artistNames}
                    supplierNames={supplierNames}
                  />
                </div>
                <span className="text-base font-semibold text-ink tabular-nums">
                  {formatGbp(row.amountMinor)}
                </span>
              </div>

              {/* A REAL DISCLOSURE WIDGET for the edit form: correct role,
                  keyboard model and screen-reader announcement in every browser,
                  no JavaScript and no state -- the same argument room-panel.tsx
                  and the lineup's removed disclosure make. */}
              <details className="border border-rule">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
                  Edit line
                </summary>
                <div className="flex flex-col gap-3 px-3 py-3">
                  <FinanceEditForm
                    orgSlug={orgSlug}
                    eventId={eventId}
                    entryId={row.id}
                    label={label}
                    stored={storedFields(row)}
                    artistOptions={artistOptions}
                    supplierOptions={supplierOptions}
                    storedArtist={storedLink(row.artistId, artistNames)}
                    storedSupplier={storedLink(row.supplierContactId, supplierNames)}
                    disabled={disabled}
                    noteId={NOTE_ID}
                  />
                  <DeleteFinanceForm
                    orgSlug={orgSlug}
                    eventId={eventId}
                    entryId={row.id}
                    label={label}
                    disabled={disabled}
                    noteId={NOTE_ID}
                  />
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      <ListPager
        spec={FINANCIAL_ENTRY_LIST}
        params={params}
        basePath={basePath}
        hasPrevious={page.hasPrevious}
        hasNext={page.hasNext}
        firstCursor={page.firstCursor}
        lastCursor={page.lastCursor}
        shown={rows.length}
        noun={FINANCIAL_ENTRY_LIST.noun}
        preserve={preserve}
      />
    </>
  );
}

/**
 * The stored row as the edit form shows it. `amount_minor` (pence) -> a plain
 * pounds string by STRING math, no float step -- the inverse of parseGbpToMinor.
 */
function storedFields(row: FinancialEntryRow): FinanceFieldValues {
  return {
    category: row.category,
    status: row.status,
    amount: minorToPoundsInput(row.amountMinor),
    occurredOn: row.occurredOn,
    description: row.description ?? "",
    artistId: row.artistId ?? "",
    supplierContactId: row.supplierContactId ?? "",
  };
}

/** `123456` -> `"1234.56"`. Integer pence to a decimal-pounds string with no
 *  floating-point division, so a large value cannot pick up rounding error. */
function minorToPoundsInput(minor: number): string {
  const digits = String(minor);
  if (digits.length <= 2) return `0.${digits.padStart(2, "0")}`;
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** The stored link as a picker option, or null when the line links none. A
 *  name the caller cannot read falls back to a sentence rather than an id. */
function storedLink(
  id: string | null,
  names: ReadonlyMap<string, LinkedName>,
): PickerOption | null {
  if (id === null) return null;
  const found = names.get(id);
  if (!found) return { id, name: "a record outside your access" };
  return { id, name: found.deleted ? `${found.name} (deleted)` : found.name };
}

/** The artist and/or supplier a line links, as read-only names beside it. */
function LinkedNames({
  orgSlug,
  artistId,
  supplierContactId,
  artistNames,
  supplierNames,
}: {
  orgSlug: string;
  artistId: string | null;
  supplierContactId: string | null;
  artistNames: ReadonlyMap<string, LinkedName>;
  supplierNames: ReadonlyMap<string, LinkedName>;
}) {
  return (
    <>
      {artistId !== null ? (
        <LinkedName
          kind="Artist"
          href={`/${orgSlug}/artists/${artistId}`}
          entry={artistNames.get(artistId) ?? null}
        />
      ) : null}
      {supplierContactId !== null ? (
        <LinkedName
          kind="Supplier"
          href={`/${orgSlug}/contacts/${supplierContactId}`}
          entry={supplierNames.get(supplierContactId) ?? null}
        />
      ) : null}
    </>
  );
}

function LinkedName({
  kind,
  href,
  entry,
}: {
  kind: string;
  href: string;
  entry: LinkedName | null;
}) {
  if (entry === null) {
    return (
      <span className="text-sm text-ink-muted italic">
        {kind} outside your access
      </span>
    );
  }
  if (entry.deleted) {
    return (
      <span className="text-sm text-ink-muted">
        {kind}: {entry.name} (deleted)
      </span>
    );
  }
  return (
    <span className="text-sm text-ink-muted">
      {kind}:{" "}
      <Link
        href={href}
        className="text-primary underline underline-offset-4 hover:text-ink"
      >
        {entry.name}
      </Link>
    </span>
  );
}

function RemovedLines({
  orgSlug,
  eventId,
  removed,
  disabled,
}: {
  orgSlug: string;
  eventId: string;
  removed: readonly RemovedFinancialEntry[];
  disabled: boolean;
}) {
  return (
    <details className="border border-rule">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
        Removed from this list (
        <span className="tabular-nums">{removed.length}</span>)
      </summary>
      <p className="px-3 pt-1 text-sm text-ink-muted">
        Removed lines stay here so they can be put back. The hundred most
        recently removed are shown.
      </p>
      <ul role="list" className="flex flex-col px-3 pt-2 pb-3">
        {removed.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0"
          >
            <span className="flex flex-wrap items-center gap-2">
              <time dateTime={entry.occurredOn} className="text-sm text-ink-muted tabular-nums">
                {formatDateOnly(entry.occurredOn)}
              </time>
              <FinanceCategoryChip category={entry.category} />
              <FinanceStatusChip status={entry.status} />
              <span className="text-sm font-semibold text-ink tabular-nums">
                {formatGbp(entry.amountMinor)}
              </span>
              <span className="text-sm text-ink-muted">
                removed{" "}
                <time dateTime={entry.deletedAt} className="tabular-nums">
                  {formatDateTime(entry.deletedAt)}
                </time>
              </span>
            </span>
            <RestoreFinanceForm
              orgSlug={orgSlug}
              eventId={eventId}
              entryId={entry.id}
              label={entry.description || "this finance line"}
              disabled={disabled}
              noteId={NOTE_ID}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
