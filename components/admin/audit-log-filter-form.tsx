import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  AUDIT_LOG_FILTER_PARAMS,
  auditLogIsFiltered,
  type AuditLogFilters,
} from "@/lib/admin/audit-log";
import { knownAuditActions } from "@/lib/admin/audit-actions";
import { instantToLondonWallClock } from "@/lib/format/date";

/** The `<datalist>`'s id. Static, because this form renders once per page
 *  and the id must match the input's `list` attribute exactly. */
const ACTION_DATALIST_ID = "audit-log-known-actions";

// The audit log's filter strip.
//
// A PLAIN NATIVE `<form method="get">`, AND DELIBERATELY NOT
// components/list/list-toolbar.tsx's Client Component (router.push +
// strip-defaults) idiom every entity list on this product uses. Two things
// are genuinely different here, not merely simpler:
//
//   - This form has no <select> that needs to auto-submit on change (every
//     field here is free text/date, so ListToolbar's onPick wiring buys
//     nothing).
//   - This page is viewed by exactly one account, rarely. The one-frame
//     "hard navigation instead of a soft one" cost ListToolbar's header goes
//     to some length to avoid is not worth a second copy of that machinery
//     for an audience of one.
//
// It still WORKS WITHOUT JAVASCRIPT (a real GET form, the browser submits
// it unaided) and every input is a labelled components/ui/field.tsx Field,
// so the accessibility wiring (bound <label>, aria-describedby) is the same
// as every other form in the product even though the submission mechanics
// differ.
//
// THE CURSOR IS ABSENT FROM THIS FORM, same reasoning as ListToolbar's own:
// a new filter starts at page one, because a cursor made under the OLD
// filtered set need not exist in the new one.
export function AuditLogFilterForm({
  filters,
  basePath,
}: {
  filters: AuditLogFilters;
  basePath: string;
}) {
  const narrowed = auditLogIsFiltered(filters);

  return (
    <form
      action={basePath}
      method="get"
      className="flex flex-wrap items-end gap-x-4 gap-y-4 border-y border-rule py-4"
    >
      {/* Field (components/ui/field.tsx) already renders its own
          `flex flex-col gap-2` wrapper -- these outer divs carry ONLY sizing,
          so the two flex contexts don't double up on gap. */}
      <div className="min-w-0 basis-56">
        <Field
          label="Organisation ID"
          name={AUDIT_LOG_FILTER_PARAMS.organisationId}
          defaultValue={filters.organisationId ?? ""}
          hint="Exact UUID match."
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="min-w-0 basis-56">
        <Field
          label="Actor user ID"
          name={AUDIT_LOG_FILTER_PARAMS.actorUserId}
          defaultValue={filters.actorUserId ?? ""}
          hint="Exact UUID match."
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="min-w-0 basis-56">
        {/* PHASE 7 TASK 6b: the field stays FREE TEXT (lib/admin/audit-log.ts's
            parser is the allowlist, and an action it has never heard of must
            still be filterable), but it now offers the catalogue as a native
            <datalist> so "contact." completes to the four contact actions.
            A <datalist> is a suggestion list, not a constraint: it works with
            JavaScript off, is announced by screen readers as a combobox with
            autocomplete, and never blocks a value that is not in it. */}
        <Field
          label="Action"
          name={AUDIT_LOG_FILTER_PARAMS.action}
          defaultValue={filters.action ?? ""}
          hint={'Exact match, e.g. "contact.updated". Start typing for known actions.'}
          autoComplete="off"
          spellCheck={false}
          list={ACTION_DATALIST_ID}
        />
        <datalist id={ACTION_DATALIST_ID}>
          {knownAuditActions().map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      </div>
      <div className="min-w-0">
        <Field
          label="From"
          name={AUDIT_LOG_FILTER_PARAMS.dateFrom}
          type="datetime-local"
          defaultValue={
            filters.dateFrom ? instantToLondonWallClock(filters.dateFrom) : ""
          }
          hint="UK local time."
        />
      </div>
      <div className="min-w-0">
        <Field
          label="To"
          name={AUDIT_LOG_FILTER_PARAMS.dateTo}
          type="datetime-local"
          defaultValue={
            filters.dateTo ? instantToLondonWallClock(filters.dateTo) : ""
          }
          hint="UK local time."
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
