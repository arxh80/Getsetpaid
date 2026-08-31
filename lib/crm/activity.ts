import "server-only";

// The shared activity timeline: the spec, the row shape, and the one read.
//
// ===========================================================================
// THE CONTRACT, IN THE ORDER A PHASE 4 IMPLEMENTER NEEDS IT
// ===========================================================================
// A SOURCE is a `union all` branch in `public.activity_events`
// (20260829040000). To plug a new one in, a later phase supplies exactly four
// things and changes nothing else:
//
//   1. A BRANCH producing the view's nine columns, added with
//      `create or replace view`. Postgres refuses that statement if the column
//      list changes, which is how the shape stays fixed.
//        id             md5('<kind>:<subject_type>:<subject_id>:<row id>')::uuid
//        organisation_id, subject_type, subject_id
//        occurred_at    NOT NULL. If your source's timestamp is nullable, the
//                       branch filters the nulls out; a null sort value drops
//                       a whole band of rows out of a keyset page and nothing
//                       errors (lib/list/spec.ts, `notNull`).
//        kind           a new literal, added to ACTIVITY_KINDS below.
//        actor_user_id / actor_name   or nulls. Most sources have no actor.
//        detail         jsonb; whatever your renderer reads, and nothing else.
//   2. AN ENTRY IN `ACTIVITY_KINDS`. The `Record<ActivityKind, ...>` in
//      components/crm/activity-timeline.tsx is keyed on that union, so adding
//      a kind without a renderer is a COMPILE ERROR rather than a blank row.
//   3. A RENDERER for the kind, reading only the `detail` keys its own branch
//      writes. `detail` is deliberately `Record<string, unknown>` here: one
//      flat interface covering every source would grow a field per phase and
//      every renderer would have to defend against the other phases' nulls.
//   4. AN INDEX ON THE SOURCE, covering the subject key -- and if your branch
//      is POLYMORPHIC (keyed on an `entity_type` column rather than emitting a
//      literal subject_type, as `merges` and `custom_field_values` are), that
//      index must LEAD on `entity_type`. A literal branch is eliminated at
//      plan time on every read of a different entity type; a polymorphic one
//      is not, and executes on all of them. Measured, and both are fine: see
//      20260829050000, which corrects 20260829040000's header on this --
//      pruning is PARTIAL, and the numbers moved in Phase 3 Task 6.
//
//      MEASURED AGAIN IN TASK 6, on 20,018 events / 40,054 lineup rows /
//      40,320 status rows, VACUUM ANALYZEd, as a real `authenticated` role.
//      The view is now 13 top-level branches, the first a CTE unioning 6
//      entity tables, so the planner considers 18 branch scans. FIFTEEN emit a
//      literal subject_type and are eliminated at plan time; the same THREE
//      are polymorphic and are not. Every one of the three reads executes
//      exactly SIX of the 18:
//        event   events (CTE) + merges x2 + custom_field_values
//                + event_lineup (event side)  -> event_lineup_event_id_org_idx
//                + event_status_changes       -> event_status_changes_event_id_org_changed_at_idx
//        artist  artists (CTE) + merges x2 + custom_field_values
//                + artist_representations + event_lineup (artist side)
//                                             -> event_lineup_artist_id_org_idx
//        venue   venues (CTE) + merges x2 + custom_field_values
//                + venue_rooms + events (venue side)
//                                             -> events_venue_id_org_idx
//      Every branch shipped today reaches an index that already existed,
//      except the status table's own, which ships with it.
//
// WHAT THE CONTRACT DOES NOT PROMISE, and a Phase 4 source must not assume:
//   * NOT O(page). The union has no covering index, so each page SORTS every
//     event on the record and takes the top n. Measured on a warm cache over a
//     workspace of ~160,000 events: 8.4 ms for a five-event contact, 55.6 ms
//     for an 805-event one. It is O(events on THIS record) -- fine for a CRM
//     record, and NOT fine for a feed. A record with 10,000 notes would sort
//     10,000 rows on every page click, and at that point the answer is a real
//     table with a real index rather than another branch here.
//   * NO ACTOR unless your source stores one. TWO sources do: `merges`
//     (merged_by, with a name joined from profiles) and, since Phase 3 Task 6,
//     `event_status_changes` (changed_by, with NO name -- the renderer for
//     that kind says what changed, and joining profiles on every row of every
//     timeline to say who would be a join the surface does not use).
//   * NO HISTORY unless your source keeps one. `record_updated` and
//     `custom_field_set` are last-changed markers that MOVE; the schema keeps
//     no per-edit history and this file does not invent one. THE ONE
//     EXCEPTION IS `status_changed`, and it is an exception because Phase 3
//     Task 6 built the table that keeps the history -- not because the branch
//     is cleverer. That is the shape a later phase needing real history has to
//     copy: a source table, not a smarter projection of `updated_at`.
//
// ===========================================================================
// PAGINATION IS lib/list/, UNMODIFIED
// ===========================================================================
// CLAUDE.md names "cursor/keyset pagination for activity feeds" specifically,
// and lib/list/ already implements it -- a second cursor in one codebase is a
// defect. `fetchListPage` reads ONE relation, which is the reason the
// aggregation is a view rather than N queries merged in TypeScript: N queries
// merged in memory cannot be keyset-paginated without a second cursor.
//
// The one thing the union needed was a tie-break, because `occurred_at` is not
// unique across source tables -- two sources writing in one transaction share
// `now()` to the microsecond. The view's synthetic `id` supplies it; the
// migration header explains the digest and rls_phase2_crm.sql § T asserts it
// on a constructed tie.
//
// ===========================================================================
// THE TIMELINE'S QUERY PARAMETERS ARE NAMESPACED, AND THAT WAS NOT OPTIONAL
// ===========================================================================
// This surface sits on a record's detail page, and the ARTIST detail page
// already had a list on it before Task 7 -- the fee history. Two lists reading
// `after` off one query string is not a hypothetical collision: the timeline's
// cursor would have been handed to `ARTIST_FEE_LIST`, which would have
// compared a timestamp against `occurred_on`, taken a PostgREST 400, and
// rendered "we couldn't load fees" on a page where nothing was wrong.
//
// `Cursor.sort` does not close it. That field exists so a cursor made under a
// different SORT degrades to page one, and it works because both cursors
// belong to the same spec; here they belong to different specs whose sort keys
// are different strings, either of which could legitimately be the one in the
// cursor.
//
// So `ACTIVITY_LIST` carries `paramPrefix: "activity_"` and lib/list/ applies
// it in `parseListParams` and `buildListHref` together (added by Task 7; every
// other spec omits it and is unchanged). The pages that carry both lists also
// pass `preserve`, so paging one no longer returns the other to page one.

import {
  ENTITY_PATH_SEGMENT,
  ENTITY_TYPE_LABELS,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { defineListSpec } from "@/lib/list/spec";
import {
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListPage } from "@/lib/list/query";

/**
 * The records a timeline can hang off: the same SIX as custom fields, and
 * deliberately the same constant rather than another copy.
 *
 * IT IS NO LONGER "the same as merges" -- Phase 3 Task 1 widened the custom
 * field allowlists to six and left the merge ones at five, so
 * `MERGE_ENTITY_TYPES` in lib/crm/dedup.ts is now its own tuple. That does not
 * affect this alias: a timeline hangs off a record, and an event is a record.
 *
 * `event` is in the union from 20260901001000, and SINCE PHASE 3 TASK 6 the
 * view really emits event rows: 20260901030000 puts public.events into the
 * `subjects` CTE and adds both directions of the lineup plus the venue side,
 * and 20260901031000 adds `status_changed`. Until that pair landed this alias
 * widened the type and nothing else -- which was the right order, because the
 * renderer's `Record<ActivityKind, ...>` and `SUBJECT_NOUN` were total over
 * `event` before any row could arrive.
 */
export type ActivitySubjectType = CustomFieldEntityType;

/**
 * Every kind the view can emit.
 *
 * THE UNION IS THE EXTENSION POINT. components/crm/activity-timeline.tsx keys
 * a `Record<ActivityKind, KindRenderer>` on it, so a kind added here without a
 * renderer fails `pnpm typecheck` -- which is the only gate that runs `tsc`
 * (CLAUDE.md § Current state).
 */
export const ACTIVITY_KINDS = [
  "record_created",
  "record_updated",
  "record_deleted",
  "merge_absorbed",
  "merge_into",
  "link_added",
  "link_removed",
  "custom_field_set",
  // PHASE 3 TASK 6, and the ONLY kind that task adds. Its source is
  // public.event_status_changes (20260901031000), the one table in this CRM
  // that keeps a real per-change history rather than a last-changed marker --
  // which is why it could not be expressed as a `record_updated`.
  //
  // NOTHING ELSE THAT TASK ADDED IS A NEW KIND. Both lineup branches and the
  // venue branch reuse `link_added` / `link_removed`, per the rule
  // 20260829040000's venue_rooms branch set: "one more entry meaning something
  // was attached to this record is worse than reusing the entry that already
  // means it."
  "status_changed",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}

export const ACTIVITY_SELECT =
  "id, occurred_at, kind, actor_name, detail";

export interface ActivityRow {
  /** The view's synthetic uuid. Stable, and the cursor's tie-break. */
  readonly id: string;
  /**
   * `null` when the database emitted a kind this build does not know.
   *
   * REACHABLE, and not only in theory: a migration that adds a source is
   * applied before the deployment that renders it, so for the length of a
   * rolling deploy the view emits kinds the running code has never heard of.
   * Dropping those rows would make the count line and the pager disagree with
   * the list; throwing would take out the whole record page. The component
   * renders a neutral entry instead -- see UNKNOWN_KIND there.
   */
  readonly kind: ActivityKind | null;
  /** The raw kind string, for the neutral rendering and for logs. */
  readonly rawKind: string;
  readonly occurredAt: string;
  readonly actorName: string | null;
  /**
   * The source branch's own payload. UNTYPED ON PURPOSE -- see the header,
   * point 3. Each renderer reads the keys its own branch writes.
   */
  readonly detail: Readonly<Record<string, unknown>>;
}

export function mapActivity(raw: Record<string, unknown>): ActivityRow {
  const rawKind = String(raw.kind ?? "");
  const detail =
    raw.detail && typeof raw.detail === "object" && !Array.isArray(raw.detail)
      ? (raw.detail as Record<string, unknown>)
      : {};
  return {
    id: String(raw.id),
    kind: isActivityKind(rawKind) ? rawKind : null,
    rawKind,
    occurredAt: String(raw.occurred_at),
    actorName:
      typeof raw.actor_name === "string" && raw.actor_name !== ""
        ? raw.actor_name
        : null,
    detail,
  };
}

export const ACTIVITY_LIST = defineListSpec({
  entity: "activity",
  noun: { one: "entry", many: "entries" },
  // NOTHING ON THIS SURFACE SEARCHES. `spec.searchColumn` is only reached when
  // `params.q !== ""`, and `activityParams()` below drops the search key before
  // parsing so that cannot happen -- see the note there for what it costs when
  // it does. It is still a REAL column rather than a placeholder, because a
  // spec naming a column that does not exist is a PostgREST 400 waiting for the
  // first person who removes that guard.
  searchColumn: "kind",
  searchLabel: "Search activity by kind",
  sort: {
    occurred: {
      column: "occurred_at",
      label: "When",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // TRUE OF EVERY BRANCH: each one either reads a NOT NULL column or
      // filters `occurred_at is not null` (the two lateral branches).
      notNull: true,
      // A VIEW HAS NO INDEX OF ITS OWN, so this names the per-branch set that
      // actually does the work. `backedBy`'s contract was written for tables
      // ("required to be a real index name") and this is the first spec in the
      // codebase that is not one -- recorded in the Task 7 report rather than
      // quietly fudged. Every name below existed before Task 7; the migration
      // added none.
      //
      // THE FOUR PHASE 3 TASK 6 NAMES ARE THE LAST FOUR, and all four existed
      // before that task: 20260901030000 and 20260901031000 create no index
      // between them except the status table's own. `event_lineup_*_id_org_idx`
      // are Task 1's FK-covering pair, `events_venue_id_org_idx` is Task 1's
      // too, and `event_status_changes_event_id_org_changed_at_idx` ships with
      // the table it covers. rls_phase3_events.sql sections EX and EL assert
      // that a `backedBy` name is a REAL index name for the two events specs;
      // tests/unit/crm/activity.test.ts asserts these four are present here,
      // which is the half a unit test can do.
      backedBy:
        "per-branch (a view has no index): contacts/companies/agencies/artists/venues/events _id_org_unique, " +
        "merges_entity_winner_idx, merges_entity_loser_idx, " +
        "contact_companies_contact_company_unique, contact_companies_company_id_idx, " +
        "artist_representations_artist_id_idx, artist_representations_agency_id_idx, " +
        "venue_rooms_venue_id_idx, custom_field_values_entity_idx, " +
        "event_lineup_event_id_org_idx, event_lineup_artist_id_org_idx, " +
        "events_venue_id_org_idx, event_status_changes_event_id_org_changed_at_idx",
    },
  },
  defaultSort: "occurred",
  filters: {},
  // See the header. Without this the artist detail page has two lists reading
  // one `after`.
  paramPrefix: "activity_",
});

export type ActivitySortKey = keyof (typeof ACTIVITY_LIST)["sort"];
export type ActivityFilterKey = keyof (typeof ACTIVITY_LIST)["filters"];
export type ActivityParams = ListParams<ActivitySortKey, ActivityFilterKey>;

/**
 * The one query-string key this surface refuses to honour.
 *
 * `ACTIVITY_LIST.paramPrefix` + the spec's search key. Written out rather than
 * built from the spec so that renaming the prefix without renaming this is a
 * mismatch a reader can see, instead of a guard that silently stops guarding.
 * `tests/unit/crm/activity.test.ts` asserts it against the spec.
 */
export const ACTIVITY_SEARCH_PARAM = "activity_q";

/**
 * The timeline's parameters, out of the detail page's query string.
 *
 * THE WHOLE OBJECT IS SAFE TO PASS, because `ACTIVITY_LIST.paramPrefix` means
 * `parseListParams` only ever reads keys beginning `activity_`. A `?merged=1`,
 * a `?after=` belonging to the fee history, and anything a later phase adds to
 * a detail page are all invisible to it.
 *
 * ===========================================================================
 * EXCEPT `activity_q`, WHICH IS DROPPED, AND THAT IS NOT TIDINESS
 * ===========================================================================
 * The spec declares a `searchColumn` because it must (a spec naming a column
 * that does not exist is a 400), and there is no search control anywhere on
 * this surface. So `?activity_q=zzz` in a hand-edited or pasted URL would
 * narrow the timeline through `ilike(kind, …)` with nothing on screen saying
 * so -- and because the timeline renders ONE empty state rather than the list
 * surface's narrowed/unnarrowed pair, a reader would be told
 *
 *     No activity recorded
 *     Nothing has been recorded against this contact yet.
 *
 * about a record with a full history. That is the same class of lie Task 3's
 * browser pass found on the contacts list ("No contacts yet" in a 71-contact
 * workspace), reached through a query parameter instead of through a role.
 *
 * Two ways to close it: honour the search and render a second empty state for
 * it, or refuse the search. Refusing is right, because the first would build
 * copy and a "clear search" affordance for a control this surface does not
 * have and is not getting.
 */
export function activityParams(raw: RawSearchParams): ActivityParams {
  return parseListParams(ACTIVITY_LIST, {
    ...raw,
    [ACTIVITY_SEARCH_PARAM]: undefined,
  });
}

/**
 * One record's timeline, one page of it.
 *
 * `subjectType` and `subjectId` are applied through `applyFilters`, which
 * `fetchListPage` puts on BOTH the page query and the count -- so the total is
 * a total for this record, not for the workspace. They are a literal and a
 * route parameter, never a request-supplied column name.
 */
export async function fetchActivityPage(
  organisationId: string,
  subjectType: ActivitySubjectType,
  subjectId: string,
  params: ActivityParams,
): Promise<ListPage<ActivityRow>> {
  return fetchListPage<ActivityRow, ActivitySortKey, ActivityFilterKey>({
    spec: ACTIVITY_LIST,
    params,
    organisationId,
    table: "activity_events",
    select: ACTIVITY_SELECT,
    mapRow: mapActivity,
    applyFilters: (query) =>
      query.eq("subject_type", subjectType).eq("subject_id", subjectId),
  });
}

// ---------------------------------------------------------------------------
// Reading the `detail` payload.
//
// Every accessor below is total: it takes `unknown` and returns something
// renderable or null. The payload is jsonb built by a view, so today it cannot
// hold anything but what the branch put there -- but jsonb has no schema, a
// later branch can write anything, and a renderer that assumes a string is one
// `.toLowerCase()` away from taking out a record page.
// ---------------------------------------------------------------------------

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function detailText(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = detail[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A uuid out of the payload, or null.
 *
 * THE SHAPE CHECK IS NOT DECORATION EVEN THOUGH TODAY IT CANNOT FAIL. Every
 * `other_id` in the shipped view is projected from a uuid COLUMN, so it is a
 * uuid or it is JSON null. What it guards is the next branch: `detail` is
 * jsonb, `otherHref()` interpolates this value into a path, and a value
 * carrying `../` would build a link out of the record it came from. The same
 * discipline lib/crm/urls.ts applies to stored URLs, applied to a stored id.
 */
export function detailUuid(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = detail[key];
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** The `fields` array a merge took from the record it absorbed. */
export function detailStrings(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = detail[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * The other record's own page, or null when there is nothing to link to.
 *
 * Null for a ROOM (`other_type: 'room'`), which is a child record with a name
 * and no page of its own, and null for any other_type this build does not
 * know -- a link to `/{slug}/undefined/{id}` is worse than plain text.
 */
export function otherHref(
  orgSlug: string,
  otherType: string | null,
  otherId: string | null,
): string | null {
  if (!otherType || !otherId) return null;
  if (!Object.hasOwn(ENTITY_PATH_SEGMENT, otherType)) return null;
  const segment = ENTITY_PATH_SEGMENT[otherType as CustomFieldEntityType];
  return `/${orgSlug}/${segment}/${otherId}`;
}

/** The singular, lower-case noun for prose about the record being viewed. */
export const SUBJECT_NOUN: Readonly<Record<ActivitySubjectType, string>> = {
  company: "company",
  contact: "contact",
  agency: "agency",
  artist: "artist",
  venue: "venue",
  event: "event",
};

/** Plural labels, reused from the custom-field tab strip. */
export { ENTITY_TYPE_LABELS };

/**
 * Does this viewer see less of the timeline than a colleague would?
 *
 * The SAME rule the five lists use (`isRecordScopedRole`), because the reason
 * is the same one lib/crm/record-scope.ts's header gives: a short list is not
 * an empty workspace, and only the role can tell the page which sentence is
 * true. It matters MORE here than on a list, because the sources have
 * different visibility from each other -- a record-scoped reader can see this
 * record and still not see a merge it survived, since merges_select_via_winner
 * requires BOTH sides to be theirs.
 */
export function activityIsScoped(role: string): boolean {
  return isRecordScopedRole(role);
}
