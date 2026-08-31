import type { ReactNode } from "react";
import Link from "next/link";
import { STATUS_LABELS, type EventStatus } from "@/lib/crm/event-status";
import {
  detailStrings,
  detailText,
  detailUuid,
  otherHref,
  type ActivityKind,
  type ActivityRow,
  type ActivityParams,
  type ActivitySubjectType,
  ACTIVITY_LIST,
  SUBJECT_NOUN,
} from "@/lib/crm/activity";
import { columnLabel } from "@/lib/crm/dedup";
import type { RawSearchParams } from "@/lib/list/params";
import type { ListPage, RecoveryReason } from "@/lib/list/query";
import { ListPager } from "@/components/list/list-pager";
import { formatDateTime } from "@/lib/format/date";

// The shared activity timeline. One component, every entity, every phase.
//
// ===========================================================================
// A SERVER COMPONENT, AND AN <ol>
// ===========================================================================
// No client JavaScript: the entries are HTML, the pager is two links, and
// paging is a navigation. Nothing here has state.
//
// An ORDERED list, not the `<ul>` of components/ui/ruled-row.tsx and not the
// `<table>` of components/list/entity-list.tsx, and the choice is semantic
// rather than visual in both directions:
//
//   * NOT A TABLE. entity-list.tsx is a table because its columns SORT, and
//     `aria-sort` lives on a `<th>`. Nothing here sorts -- there is one order,
//     and it is the subject of the surface.
//   * NOT A `<ul>`. Sequence is the meaning. A screen reader announcing
//     "list item 3 of 26" in an ordered list is telling the user where they
//     are in a chronology; in an unordered one it would be telling them
//     nothing.
//
// ruled-row.tsx's header says a later timeline "should extend it rather than
// inventing a second one", and this is the answer to that instruction rather
// than a decision taken around it: the VISUAL language is the same -- border-t
// on the list, border-b per entry, hairline rules and typographic weight, no
// cards -- and what could not be reused is the markup, because `RuledRow`
// renders an `<li>` inside a `<ul>` with a one-line `truncate`d title, and an
// entry here is an ordered item with a sentence that must wrap.
//
// THE ONE STRUCTURAL DEVICE is the rule between the time column and the
// entry. It is not a decorative spine: it separates the axis the list is
// ordered on from the content, which is the single fact a reader needs to
// scan this surface, and it is the same 1px --rule hairline everything else in
// this product is built from.
//
// ===========================================================================
// WHAT THE COPY MUST NOT CLAIM
// ===========================================================================
// Two of the nine kinds are LAST-CHANGED MARKERS, not log entries -- one row
// per record (`record_updated`) or per field (`custom_field_set`) whose
// timestamp moves on every edit. The schema keeps no per-edit history
// (20260829040000's header). So neither sentence says "edited" as though it
// were one event among several; both say "last".
//
// `status_changed` IS THE ONE KIND THAT MAY SAY MORE, and the copy is allowed
// to be specific precisely because public.event_status_changes really does
// keep every transition (20260901031000). It names both statuses in TEXT --
// DESIGN.md's "status must never be colour-only" applies to a timeline entry
// as much as to a chip, and there is no chip here.
//
// And nothing outside `merge_absorbed` / `merge_into` names a person, because
// nothing outside `merges` records one. `owner_user_id` is the record-scope
// column, not an author -- rendering "created by" from it would be a false
// statement about the customer's own data, which is the class of defect this
// phase has found in a browser three times.

interface ActivityTimelineProps {
  orgSlug: string;
  subjectType: ActivitySubjectType;
  page: ListPage<ActivityRow>;
  params: ActivityParams;
  /** The record's own URL. The pager builds its links from it. */
  basePath: string;
  /** True for standard_user and read_only -- see lib/crm/activity.ts. */
  recordScoped: boolean;
  /**
   * The page's whole `searchParams`, so the pager's links keep the query
   * parameters of anything ELSE on the page -- the artist detail page's fee
   * history is the one that exists today. See HrefOverrides.preserve.
   */
  preserve?: RawSearchParams;
}

export function ActivityTimeline({
  orgSlug,
  subjectType,
  page,
  params,
  basePath,
  recordScoped,
  preserve,
}: ActivityTimelineProps) {
  const noun = SUBJECT_NOUN[subjectType];

  return (
    <section
      aria-labelledby={HEADING_ID}
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <h2 id={HEADING_ID} className="text-xl font-bold text-ink">
        Activity
      </h2>

      {/* A FAILED QUERY IS NOT AN EMPTY TIMELINE. The same rule the list
          surface, the members page and the custom-fields panel follow: "there
          is no activity" is a claim about the customer's data, and making it
          because a query failed reads as data loss. */}
      {page.outcome === "unavailable" ? (
        <p
          role="status"
          className="border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t
          load this {noun}’s activity just now. Refresh the page to try again —
          nothing has been deleted.
        </p>
      ) : (
        <Loaded
          ctx={{ orgSlug, subjectType, noun }}
          page={page}
          params={params}
          basePath={basePath}
          recordScoped={recordScoped}
          preserve={preserve}
        />
      )}
    </section>
  );
}

const HEADING_ID = "activity-heading";

function Loaded({
  ctx,
  page,
  params,
  basePath,
  recordScoped,
  preserve,
}: {
  ctx: EntryContext;
  page: Extract<ListPage<ActivityRow>, { outcome: "loaded" }>;
  params: ActivityParams;
  basePath: string;
  recordScoped: boolean;
  preserve?: RawSearchParams;
}) {
  const { rows, total } = page;
  const noun = ctx.noun;

  return (
    <>
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm text-ink-muted">
          {total === null ? (
            <>
              <span className="tabular-nums">{rows.length}</span>{" "}
              {rows.length === 1 ? "entry" : "entries"} on this page
            </>
          ) : (
            <>
              <span className="tabular-nums">{total}</span>{" "}
              {total === 1 ? "entry" : "entries"}
            </>
          )}
          {" · newest first"}
        </p>

        {/* THE SCOPE NOTE IS NOT OPTIONAL, and it says more here than it does
            on a list. A record-scoped reader can see this record and still not
            see a merge it survived, because merges_select_via_winner requires
            BOTH of a merge's records to be theirs. Without this line, a
            timeline missing half its entries looks complete. */}
        {recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing the entries your access covers. A merge appears only
            when both of its records were assigned to you; others in this
            workspace may see more.
          </p>
        ) : null}

        {page.recovered ? (
          <p role="status" className="text-sm text-ink-muted">
            {RECOVERY_NOTICE[page.recovered]}
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        // BOTH BRANCHES ARE DEFENSIVE, and saying so beats implying this is a
        // state anyone reaches. A rendered detail page has already proved the
        // record is visible to this caller, and the `record_created` branch of
        // the view reads that same record under that same policy -- so a
        // visible record always has at least one entry. If that ever stops
        // being true, the record-scoped reader must not be told nothing
        // happened, which is exactly the lie Task 3's browser pass found on
        // the contacts list.
        <div className="border border-rule bg-surface p-5">
          <h3 className="text-lg font-bold text-ink">
            {recordScoped ? "No activity you can see" : "No activity recorded"}
          </h3>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? `Your access covers the records assigned to you. This being empty doesn’t mean nothing has happened to this ${noun}.`
              : `Nothing has been recorded against this ${noun} yet.`}
          </p>
        </div>
      ) : (
        <>
          <ol className="border-t border-rule">
            {rows.map((row) => (
              <Entry key={row.id} row={row} ctx={ctx} />
            ))}
          </ol>

          <ListPager
            spec={ACTIVITY_LIST}
            params={params}
            basePath={basePath}
            hasPrevious={page.hasPrevious}
            hasNext={page.hasNext}
            firstCursor={page.firstCursor}
            lastCursor={page.lastCursor}
            shown={rows.length}
            noun={ACTIVITY_LIST.noun}
            preserve={preserve}
          />
        </>
      )}
    </>
  );
}

/** One sentence per recovery cause -- the same three EntityList renders. */
const RECOVERY_NOTICE: Record<NonNullable<RecoveryReason>, string> = {
  "past-end":
    "That link pointed past the end of this timeline, so this is the most recent page.",
  "before-start":
    "That link pointed before the start of this timeline, so this is the most recent page.",
  "stale-sort":
    "That link was made under a different order, so this is the most recent page.",
};

/**
 * What every renderer needs, and nothing more.
 *
 * ONE OBJECT RATHER THAN THREE POSITIONAL ARGUMENTS, so a Phase 4 source that
 * needs a fourth fact adds a field here instead of re-threading every entry in
 * RENDER.
 */
interface EntryContext {
  readonly orgSlug: string;
  /** The record the timeline is on -- also the type of both sides of a merge. */
  readonly subjectType: ActivitySubjectType;
  /** Its singular, lower-case noun, for prose. */
  readonly noun: string;
}

function Entry({ row, ctx }: { row: ActivityRow; ctx: EntryContext }) {
  const rendered =
    row.kind === null ? UNKNOWN_KIND(row) : RENDER[row.kind](row, ctx);

  return (
    <li className="grid grid-cols-1 gap-x-3 gap-y-1 border-b border-rule py-3 sm:grid-cols-[8.5rem_1fr]">
      {/* The time axis. `tabular-nums` because DESIGN.md § Numerals requires
          it on every date column, and here it also keeps the left edge of the
          entries aligned when the list is scanned vertically. */}
      <time
        dateTime={row.occurredAt}
        className="text-sm tabular-nums text-ink-muted"
      >
        {formatDateTime(row.occurredAt)}
      </time>

      {/* The rule between the axis and the entry -- the one structural device
          on this surface. `sm:` only: stacked, a left border would be a
          dangling line under the date. */}
      <div className="flex flex-col gap-1 sm:border-l sm:border-rule sm:pl-3">
        <p className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
          {rendered.label}
        </p>
        <p className="max-w-prose text-base break-words text-ink">
          {rendered.body}
        </p>
        {rendered.footnote ? (
          <p className="text-sm break-words text-ink-muted">
            {rendered.footnote}
          </p>
        ) : null}
      </div>
    </li>
  );
}

interface Rendered {
  /** The uppercase eyebrow: what kind of thing this entry is. */
  readonly label: string;
  /** The sentence. */
  readonly body: ReactNode;
  /** A second, quieter line -- the actor, or what a merge took. */
  readonly footnote?: ReactNode;
}

/**
 * THE EXTENSION POINT, AND IT IS A COMPILE-TIME ONE.
 *
 * Keyed on `ActivityKind`, so a kind added to lib/crm/activity.ts without an
 * entry here fails `pnpm typecheck` -- the only gate in this repository that
 * runs `tsc`. The alternative shape, a `switch` with a `default`, would render
 * the neutral fallback for a kind somebody meant to write copy for, and
 * nothing would say so.
 */
const RENDER: Record<
  ActivityKind,
  (row: ActivityRow, ctx: EntryContext) => Rendered
> = {
  record_created: (_row, ctx) => ({
    label: "Created",
    body: `This ${ctx.noun} was added to the workspace.`,
  }),

  // "LAST EDITED", NOT "EDITED". One row, one moving timestamp -- see the
  // file header and 20260829040000's. The second sentence is what stops a
  // reader concluding the earlier edits are further down the list.
  record_updated: (_row, ctx) => ({
    label: "Last edited",
    body: `Someone changed this ${ctx.noun}.`,
    footnote: "Only the most recent edit is kept — individual changes aren’t recorded.",
  }),

  record_deleted: (_row, ctx) => ({
    label: "Deleted",
    body: `This ${ctx.noun} was deleted. It’s out of the list and out of search until it’s restored.`,
  }),

  merge_absorbed: (row, ctx) => ({
    label: "Merged",
    body: (
      <>
        <OtherRecord row={row} ctx={ctx} fallback="Another record" /> was merged
        into this {ctx.noun}.
      </>
    ),
    footnote: mergeFootnote(row, "the merged-away record"),
  }),

  merge_into: (row, ctx) => ({
    label: "Merged away",
    body: (
      <>
        This {ctx.noun} was merged into{" "}
        <OtherRecord row={row} ctx={ctx} fallback="another record" />.
      </>
    ),
    footnote: mergeFootnote(row, "this record"),
  }),

  link_added: (row, ctx) =>
    detailText(row.detail, "other_type") === "room"
      ? {
          label: "Room added",
          // A room's name is user content and is rendered as text, never as a
          // link: it has no page. `otherHref` returns null for it anyway, and
          // this branch exists so the eyebrow says the right noun.
          body: detailText(row.detail, "other_name") ?? "A room was added.",
        }
      : {
          label: "Linked",
          body: (
            <>
              Linked to{" "}
              <OtherRecord row={row} ctx={ctx} fallback="another record" />.
            </>
          ),
        },

  link_removed: (row, ctx) =>
    detailText(row.detail, "other_type") === "room"
      ? {
          label: "Room closed",
          body: detailText(row.detail, "other_name") ?? "A room was closed.",
        }
      : {
          label: "Unlinked",
          body: (
            <>
              <OtherRecord row={row} ctx={ctx} fallback="Another record" /> is
              no longer linked to this one.
            </>
          ),
        },

  // THE LABEL, NEVER THE VALUE. A custom field's value is often the most
  // sensitive thing on a record, and a timeline that reprinted it would put a
  // second copy of it on the page in a surface with different controls. The
  // panel above shows the value; this says when it last changed.
  // BOTH STATUSES BY NAME, AS TEXT. `STATUS_LABELS` is the same record the
  // chip and the filter read (lib/crm/event-status.ts), so a ninth status
  // added to the vocabulary reaches this sentence with no edit here.
  //
  // AND IT FALLS BACK RATHER THAN THROWING. `detail` is jsonb and the accessor
  // contract in lib/crm/activity.ts is that every reader is total: a value
  // outside EVENT_STATUSES cannot be produced by the branch today (two CHECK
  // constraints stand between it and the table) but `STATUS_LABELS[x]` on an
  // unknown key is `undefined`, which React renders as nothing -- an entry
  // reading "Status changed from to Confirmed". `statusLabel` returns the raw
  // string instead, which is ugly and true.
  status_changed: (row) => ({
    label: "Status",
    body: (
      <>
        Status changed from{" "}
        <span className="font-semibold">
          {statusLabel(detailText(row.detail, "from"))}
        </span>{" "}
        to{" "}
        <span className="font-semibold">
          {statusLabel(detailText(row.detail, "to"))}
        </span>
        .
      </>
    ),
  }),

  custom_field_set: (row) => ({
    label: "Custom field",
    body: (
      <>
        {detailText(row.detail, "field_label") ?? "A custom field"} was last
        saved.
      </>
    ),
    footnote:
      "Only the most recent value is kept — earlier values aren’t recorded.",
  }),
};

/**
 * One end of a status change, as a human reads it.
 *
 * NULL IS REACHABLE FOR `from`, in exactly one way: Branch 5 of the view
 * filters `from_status is not null`, so the create-time row never arrives --
 * but a row whose payload lost the key (a hand-written insert, a future branch)
 * would. "an earlier status" is the honest rendering of "we do not know", and
 * it keeps the sentence grammatical instead of leaving a hole in it.
 */
function statusLabel(value: string | null): string {
  if (value === null) return "an earlier status";
  return STATUS_LABELS[value as EventStatus] ?? value;
}

/**
 * A kind the database emits and this build has no copy for.
 *
 * NEUTRAL, NOT ALARMING, and NOT DROPPED. See ActivityRow.kind: the reachable
 * cause is a migration applied ahead of the deployment that renders it, which
 * is ordinary. Dropping the row would put the count line, the pager and the
 * list into disagreement; an error would take out the record page.
 */
function UNKNOWN_KIND(row: ActivityRow): Rendered {
  return {
    label: "Activity",
    body: "Something was recorded against this record.",
    footnote: `This version of GetSetPaid doesn’t have a description for “${row.rawKind}”. Reload the page — it may have been added since this tab was opened.`,
  };
}

/**
 * The other record in a link or a merge: a link when it has a page, plain
 * text when it does not, and a fallback when nothing is recorded.
 *
 * THE NAME IS A SNAPSHOT ON A MERGE and a live join on a link. The merge
 * branches read it out of `field_resolution` rather than joining, exactly as
 * the merge history page does, because the loser may since have been
 * hard-deleted; it therefore goes stale on a rename. lib/crm/dedup.ts's
 * mapMerge carries the same trade and the same note.
 *
 * `detailUuid` and not `detailText` for the id: the href is built by
 * interpolation, so the id is shape-checked before it can reach a path.
 */
function OtherRecord({
  row,
  ctx,
  fallback,
}: {
  row: ActivityRow;
  ctx: EntryContext;
  fallback: string;
}) {
  const name = detailText(row.detail, "other_name");
  // The merge branches write no `other_type`, and that is not an omission:
  // `merges.entity_type` covers BOTH sides, so the other side of a merge is
  // always the same type as the record being viewed. Falling back to the
  // subject's type is a fact about that table's schema, not a guess.
  const type = detailText(row.detail, "other_type") ?? ctx.subjectType;
  const href = otherHref(ctx.orgSlug, type, detailUuid(row.detail, "other_id"));

  if (!href) {
    return name ? (
      <span translate="no" className="break-words">
        {name}
      </span>
    ) : (
      <>{fallback}</>
    );
  }
  return (
    <Link
      href={href}
      className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
    >
      {name ?? fallback}
    </Link>
  );
}

/**
 * The quiet second line on a merge: who did it, and what it kept.
 *
 * THE ONLY PLACE IN THIS COMPONENT THAT NAMES A PERSON, because `merges` is
 * the only source in the view that records one (20260829040000's header).
 * "Someone in this workspace" when the name is null -- the profile row is
 * normally readable through the fellow-member policy, but the account may
 * since have been erased and the merge still has to render.
 *
 * ORDINARY COLUMNS ONLY. `field_resolution.fields` covers the mergeable
 * columns; custom fields taken in a merge live under a different key, and are
 * not reported here exactly as the merge history page does not report them.
 *
 * ===========================================================================
 * THE `source` ARGUMENT IS NOT DECORATION, AND ONE SENTENCE WAS WRONG WITHOUT
 * IT
 * ===========================================================================
 * One merges row is an entry on BOTH records, and the fields it took are the
 * same fields from either side -- so the first draft rendered one sentence for
 * both. On the WINNER's page "Kept from the merged-away record" is exactly
 * right. On the LOSER's page -- which this product serves, because that is
 * where a merged-away record's history lives -- it says "the merged-away
 * record" about the record the reader is looking at, and asks them to work out
 * that it means this one.
 *
 * Found in a browser on a real soft-deleted contact; the behaviour was correct
 * (the right fields, the right actor, the right link) and the noun was about
 * somebody else. The same class of defect Task 4b's browser pass found in
 * DELETED_RECORD_EXPLANATION, and it is invisible to tsc, eslint and every
 * test in this repository, because both strings are grammatical English.
 */
function mergeFootnote(
  row: ActivityRow,
  source: "the merged-away record" | "this record",
): ReactNode {
  const by = `By ${row.actorName ?? "someone in this workspace"}.`;
  const fields = detailStrings(row.detail, "fields");
  if (fields.length === 0) return by;
  return `${by} Kept from ${source}: ${fields.map(columnLabel).join(", ")}.`;
}
