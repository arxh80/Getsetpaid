import "server-only";

// The duplicate review queue and the merge history: specs, shapes and reads.
//
// ===========================================================================
// WHAT LIVES HERE AND WHAT DOES NOT
// ===========================================================================
// No writes. `lib/crm/merge.ts` owns those, for the same reason every other
// entity in this phase splits them: the list specs and row shapes are imported
// by page components, and a module carrying the server-action directive exports
// every symbol in it as a Server Action.
//
// ===========================================================================
// THE QUEUE IS A LIST LIKE EVERY OTHER LIST IN THIS PHASE
// ===========================================================================
// Same `lib/list/` machinery: an allowlisted sort with a named index behind
// it, keyset pagination, a server-side page-size ceiling, and a role-aware
// empty state. The one thing it does differently is what `scope: "deleted"`
// means -- for the five entity lists that is the restore view, and here it is
// the RESOLVED queue. `merge_candidates.deleted_at` is set when a candidate is
// merged or dismissed, so "off the queue" and "soft-deleted" are the same
// state and the two views are one surface with two scopes.
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  ENTITY_PATH_SEGMENT,
  ENTITY_TYPE_LABELS,
  isCustomFieldEntityType,
  parseOptions,
  type CustomFieldEntityType,
  type CustomFieldDefinition,
} from "@/lib/crm/custom-fields";
import { defineListSpec } from "@/lib/list/spec";
import { commitWrite } from "@/lib/crm/write";
import { createClient } from "@/lib/supabase/server";

/**
 * The entity types a merge can touch.
 *
 * The SAME five as custom fields, and deliberately the same constant rather
 * than a sixth copy: `merges_entity_type_allowed` and
 * `custom_field_values_entity_type_allowed` are two renderings of one list, and
 * tests/integration/crm/custom-field-entity-types-match-db.test.ts already
 * binds this constant to both. Phase 3 adds 'event' in one place.
 */
export type MergeEntityType = CustomFieldEntityType;
export const MERGE_ENTITY_TYPES = CUSTOM_FIELD_ENTITY_TYPES;
export const isMergeEntityType = isCustomFieldEntityType;

/**
 * The columns a merge may choose between, per entity type.
 *
 * A MIRROR OF `private.dedup_mergeable_columns()`, and it has to be, because
 * the merge screen has to render a row per field before the function runs and
 * a request cannot consult a SQL function's body. Bound to the database by
 * tests/integration/crm/mergeable-columns-match-db.test.ts, which is the same
 * treatment the four other rules written in two languages get (record scope,
 * the tier table, the grace window, the entity-type allowlist).
 *
 * The ORDER is this list's own: it decides the order of the rows on the merge
 * screen, and `name` first is not how the catalogue happens to store them.
 */
export const MERGEABLE_COLUMNS: Readonly<Record<MergeEntityType, readonly string[]>> = {
  company: ["name", "type"],
  contact: ["name", "email", "phone", "title", "location", "website", "socials", "tags"],
  agency: ["name"],
  artist: ["name", "genres", "country", "city", "socials", "website", "notes"],
  venue: ["name", "address", "location", "capacity", "socials", "website", "technical_info"],
};

/** Human labels for those columns. A field with no entry falls back to the key. */
const COLUMN_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  title: "Role",
  location: "Location",
  website: "Website",
  socials: "Socials",
  tags: "Tags",
  type: "Type",
  genres: "Genres",
  country: "Country",
  city: "City",
  notes: "Notes",
  address: "Address",
  capacity: "Capacity",
  technical_info: "Technical info",
};

export function columnLabel(column: string): string {
  return COLUMN_LABELS[column] ?? column;
}

/** Why a pair was flagged. The DB constrains it; this renders it. */
export const CANDIDATE_REASONS = ["exact_email", "fuzzy_name"] as const;
export type CandidateReason = (typeof CANDIDATE_REASONS)[number];

export const REASON_LABELS: Readonly<Record<CandidateReason, string>> = {
  // NAMED FOR WHAT IT MEANS TO THE READER, not for the column it matched on.
  // "Same email" is a fact about the two records; "exact_email" is a value in
  // a CHECK constraint.
  exact_email: "Same email address",
  fuzzy_name: "Similar name",
};

export function reasonLabel(reason: string): string {
  return (REASON_LABELS as Record<string, string>)[reason] ?? "Possible duplicate";
}

/** The record's own page, for the two links on every queue row. */
export function entityHref(
  orgSlug: string,
  entityType: MergeEntityType,
  id: string,
): string {
  return `/${orgSlug}/${ENTITY_PATH_SEGMENT[entityType]}/${id}`;
}

export function entityLabel(entityType: MergeEntityType): string {
  return ENTITY_TYPE_LABELS[entityType];
}

// ---------------------------------------------------------------------------
// The open queue.
// ---------------------------------------------------------------------------
export const CANDIDATE_SELECT =
  "id, entity_type, keep_id, duplicate_id, label, reason, similarity, detected_at";

export interface CandidateRow {
  id: string;
  entityType: MergeEntityType;
  keepId: string;
  duplicateId: string;
  label: string;
  reason: string;
  similarity: number | null;
  detectedAt: string;
}

export function mapCandidate(raw: Record<string, unknown>): CandidateRow {
  const entityType = String(raw.entity_type);
  return {
    id: String(raw.id),
    // A row whose entity_type is outside the allowlist cannot exist (a CHECK
    // constraint), so this narrowing is a type assertion rather than a
    // validation -- but it is written as a fallback rather than a cast so a
    // future widened constraint renders something instead of throwing.
    entityType: isMergeEntityType(entityType) ? entityType : "contact",
    keepId: String(raw.keep_id),
    duplicateId: String(raw.duplicate_id),
    label: String(raw.label),
    reason: String(raw.reason),
    similarity: raw.similarity === null ? null : Number(raw.similarity),
    detectedAt: String(raw.detected_at),
  };
}

export const DUPLICATE_LIST = defineListSpec({
  entity: "merge-candidates",
  noun: { one: "possible duplicate", many: "possible duplicates" },
  // `label` is the subject's name AT DETECTION. It is what a person searching
  // this queue types, and it is the only free-text column on the table -- the
  // two records themselves are polymorphic uuids with no name to search.
  searchColumn: "label",
  searchLabel: "Search possible duplicates by name",
  sort: {
    detected: {
      column: "detected_at",
      label: "Flagged",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "merge_candidates_org_detected_id_live_idx",
    },
    // NOT `similarity`, which is the obvious second sort and is NULLABLE (an
    // exact-email match has no name similarity worth recording). lib/list's
    // `notNull` exists for exactly this: a NULL in the sort column drops a
    // whole band of rows out of the middle of a keyset-paginated list and
    // nothing errors.
  },
  defaultSort: "detected",
  filters: {
    // The first choice must filter nothing -- lib/list/spec.ts's rule, and the
    // reason is sharper here than anywhere else in the phase: a queue whose
    // default state hides rows tells a reviewer there is nothing to review.
    reason: {
      label: "Why",
      choices: [
        { value: "any", label: "Any reason" },
        { value: "exact_email", label: "Same email" },
        { value: "fuzzy_name", label: "Similar name" },
      ],
    },
  },
});

export type CandidateSortKey = keyof (typeof DUPLICATE_LIST)["sort"];
export type CandidateFilterKey = keyof (typeof DUPLICATE_LIST)["filters"];

export const RESOLVED_SELECT =
  "id, entity_type, keep_id, duplicate_id, label, reason, similarity, resolution, deleted_at";

export interface ResolvedCandidateRow extends Omit<CandidateRow, "detectedAt"> {
  resolution: string;
  resolvedAt: string;
}

export function mapResolvedCandidate(
  raw: Record<string, unknown>,
): ResolvedCandidateRow {
  const base = mapCandidate({ ...raw, detected_at: raw.deleted_at });
  return {
    ...base,
    resolution: String(raw.resolution ?? ""),
    resolvedAt: String(raw.deleted_at),
  };
}

export const RESOLVED_LIST = defineListSpec({
  entity: "merge-candidates-resolved",
  noun: { one: "resolved duplicate", many: "resolved duplicates" },
  searchColumn: "label",
  searchLabel: "Search resolved duplicates by name",
  sort: {
    resolved: {
      column: "deleted_at",
      label: "Resolved",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      // TRUE OF THE ROWS THIS LIST READS rather than of the column: `scope:
      // "deleted"` puts `deleted_at is not null` on every query, which is also
      // the index's partial predicate. Same note as the five entity restore
      // lists carry.
      notNull: true,
      backedBy: "merge_candidates_org_deleted_at_id_idx",
    },
  },
  defaultSort: "resolved",
  filters: {},
});

export type ResolvedSortKey = keyof (typeof RESOLVED_LIST)["sort"];
export type ResolvedFilterKey = keyof (typeof RESOLVED_LIST)["filters"];

// ---------------------------------------------------------------------------
// The merge history.
// ---------------------------------------------------------------------------
export const MERGE_SELECT =
  "id, entity_type, winner_id, loser_id, merged_at, field_resolution";

export interface MergeHistoryRow {
  id: string;
  entityType: MergeEntityType;
  winnerId: string;
  loserId: string;
  mergedAt: string;
  winnerName: string | null;
  loserName: string | null;
  fieldsFromLoser: readonly string[];
}

export function mapMerge(raw: Record<string, unknown>): MergeHistoryRow {
  const entityType = String(raw.entity_type);
  const resolution = (raw.field_resolution ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    entityType: isMergeEntityType(entityType) ? entityType : "contact",
    winnerId: String(raw.winner_id),
    loserId: String(raw.loser_id),
    mergedAt: String(raw.merged_at),
    // READ OUT OF field_resolution RATHER THAN JOINED. The two ids are
    // polymorphic, so there is no embed to write, and a merge whose loser has
    // since been hard-deleted still has to render -- which is the whole reason
    // the snapshot is in the row. Null for a merges row written before Task 6
    // or by a path that recorded nothing.
    winnerName: snapshotName(resolution, "winner"),
    loserName: snapshotName(resolution, "loser"),
    fieldsFromLoser: fieldsFromLoser(resolution),
  };
}

function snapshotName(
  resolution: Record<string, unknown>,
  side: "winner" | "loser",
): string | null {
  const record = resolution[side];
  if (!record || typeof record !== "object") return null;
  const before = (record as Record<string, unknown>).before;
  if (!before || typeof before !== "object") return null;
  const name = (before as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function fieldsFromLoser(resolution: Record<string, unknown>): string[] {
  const fields = resolution.fields;
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields as Record<string, unknown>)
    .filter(
      ([, value]) =>
        !!value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).from === "loser",
    )
    .map(([key]) => key)
    .sort();
}

export const MERGE_LIST = defineListSpec({
  entity: "merges",
  noun: { one: "merge", many: "merges" },
  // THE ONLY SEARCHABLE COLUMN ON THIS TABLE IS entity_type. There is no name
  // and no label -- winner_id and loser_id are polymorphic, and the names live
  // inside field_resolution, which is jsonb and cannot be ILIKE'd through
  // lib/list's grammar. Searching the type is honest and cheap; searching the
  // names would need a denormalised column this table does not have and does
  // not need yet.
  searchColumn: "entity_type",
  searchLabel: "Search merges by record type",
  sort: {
    merged: {
      column: "merged_at",
      label: "Merged",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "merges_org_merged_at_id_idx",
    },
  },
  defaultSort: "merged",
  filters: {},
});

export type MergeSortKey = keyof (typeof MERGE_LIST)["sort"];
export type MergeFilterKey = keyof (typeof MERGE_LIST)["filters"];

// ---------------------------------------------------------------------------
// The merge screen's read.
// ---------------------------------------------------------------------------

/** One record, as the merge screen needs it. */
export interface MergeRecord {
  readonly id: string;
  readonly name: string;
  readonly deleted: boolean;
  readonly createdAt: string;
  /** Allowlisted mergeable columns only, as raw JSON values. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Custom field values, keyed by definition id. */
  readonly custom: Readonly<Record<string, unknown>>;
}

export interface MergePair {
  readonly candidate: CandidateRow | null;
  readonly keep: MergeRecord;
  readonly duplicate: MergeRecord;
  readonly definitions: readonly CustomFieldDefinition[];
}

/**
 * Load a candidate and both of its records.
 *
 * EVERY QUERY HERE RUNS AS THE CALLER. There is no service-role client in this
 * file: a record outside the caller's scope simply is not returned, and the
 * page renders a 404 rather than a partially populated merge screen. The
 * candidate row itself is already gated by a policy requiring BOTH records to
 * be visible, so a caller who can read the candidate can read both records --
 * but the two reads are still made through RLS rather than trusted, because
 * "the policy implies it" is not the same as "the database enforced it here".
 *
 * `deleted_at is null` IS WRITTEN OUT ON EVERY READ. RLS deliberately does not
 * filter soft-deleted rows (20260828121000 design note (g)), so nothing errors
 * if it is omitted -- a merged-away record simply appears as a live merge
 * candidate. The one place it is deliberately NOT applied is the loser of a
 * completed merge, which the history has to be able to show.
 */
export async function loadMergePair(
  organisationId: string,
  candidateId: string,
): Promise<MergePair | null> {
  const supabase = await createClient();

  const { data: candidateRow, error } = await supabase
    .from("merge_candidates")
    .select(CANDIDATE_SELECT)
    .eq("organisation_id", organisationId)
    .eq("id", candidateId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error(
      `[crm] merge candidate lookup failed for organisation ${organisationId}:`,
      error.message,
    );
    return null;
  }
  if (!candidateRow) return null;

  const candidate = mapCandidate(candidateRow as Record<string, unknown>);
  const pair = await loadRecordPair(
    organisationId,
    candidate.entityType,
    candidate.keepId,
    candidate.duplicateId,
  );
  if (!pair) return null;
  return { ...pair, candidate };
}

/**
 * The same two records without a candidate row behind them.
 *
 * Split out because a merge does not require a queue entry: a user who has two
 * records open and knows they are the same should not have to wait for the
 * screening to notice. The queue is how duplicates are FOUND, not how they are
 * merged.
 */
export async function loadRecordPair(
  organisationId: string,
  entityType: MergeEntityType,
  keepId: string,
  duplicateId: string,
): Promise<Omit<MergePair, "candidate"> | null> {
  const supabase = await createClient();
  const table = ENTITY_TABLE[entityType];
  const columns = MERGEABLE_COLUMNS[entityType];
  // A LITERAL BUILT FROM AN ALLOWLIST, never from a request: `columns` comes
  // from MERGEABLE_COLUMNS above, keyed by an entity type that has already
  // been narrowed by isMergeEntityType().
  const select = ["id", "name", "created_at", "deleted_at", ...columns].join(", ");

  const [records, values, definitions] = await Promise.all([
    supabase
      .from(table)
      .select(select)
      .eq("organisation_id", organisationId)
      .in("id", [keepId, duplicateId]),
    supabase
      .from("custom_field_values")
      .select("field_id, entity_id, value")
      .eq("organisation_id", organisationId)
      .eq("entity_type", entityType)
      .in("entity_id", [keepId, duplicateId]),
    supabase
      .from("custom_field_definitions")
      .select("id, key, label, field_type, options, deleted_at")
      .eq("organisation_id", organisationId)
      .eq("entity_type", entityType)
      .is("deleted_at", null)
      .order("label", { ascending: true }),
  ]);

  if (records.error || !records.data) {
    console.error(
      `[crm] merge pair lookup failed for organisation ${organisationId}:`,
      records.error?.message ?? "no data returned",
    );
    return null;
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of records.data as unknown as Record<string, unknown>[]) {
    byId.set(String(row.id), row);
  }
  const keepRow = byId.get(keepId);
  const duplicateRow = byId.get(duplicateId);
  // BOTH, OR NEITHER. One of the two missing means the caller cannot see it,
  // it is in another workspace, or it does not exist -- three cases that share
  // one answer, the same rule every other page in this phase follows.
  if (!keepRow || !duplicateRow) return null;
  // A merge needs two LIVE records. Merging into or out of a soft-deleted one
  // writes a history entry describing something that did not happen, and
  // merge_records() refuses it -- so the screen refuses to offer it.
  if (keepRow.deleted_at !== null || duplicateRow.deleted_at !== null) return null;

  const customFor = (id: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const row of (values.data ?? []) as Record<string, unknown>[]) {
      if (String(row.entity_id) === id) out[String(row.field_id)] = row.value;
    }
    return out;
  };

  const toRecord = (row: Record<string, unknown>): MergeRecord => ({
    id: String(row.id),
    name: String(row.name),
    deleted: row.deleted_at !== null,
    createdAt: String(row.created_at),
    values: Object.fromEntries(columns.map((c) => [c, row[c] ?? null])),
    custom: customFor(String(row.id)),
  });

  return {
    keep: toRecord(keepRow),
    duplicate: toRecord(duplicateRow),
    definitions: ((definitions.data ?? []) as Record<string, unknown>[]).map(
      (row) => ({
        id: String(row.id),
        entityType,
        key: String(row.key),
        label: String(row.label),
        fieldType: String(row.field_type) as CustomFieldDefinition["fieldType"],
        options: parseOptions(row.options),
        // Always null here -- the query filters `deleted_at is null`, because a
        // removed field must not be offered as a choice on a merge screen. It
        // is carried because CustomFieldDefinition declares it and a cast would
        // be the shape of a bug rather than a narrowing.
        deletedAt: (row.deleted_at as string | null) ?? null,
      }),
    ),
  };
}

/**
 * entity_type -> table, mirroring `private.dedup_entity_table()`.
 *
 * Two copies of one mapping, and the same test that binds MERGEABLE_COLUMNS
 * binds this one. It cannot be shared: the SQL function is what the merge's
 * dynamic statements resolve, and a request cannot call it to build a
 * PostgREST path.
 */
export const ENTITY_TABLE: Readonly<Record<MergeEntityType, string>> = {
  company: "companies",
  contact: "contacts",
  agency: "agencies",
  artist: "artists",
  venue: "venues",
};

/**
 * Render one stored value for the merge screen.
 *
 * Every value here is USER CONTENT out of another user's record, so nothing is
 * linkified and nothing is interpreted -- `socials` and `website` in
 * particular. The record's own page renders those through `safeHref()`; this
 * screen shows what is stored, as text, because the question it asks is "which
 * of these two strings survives" and a rendered link answers a different one.
 */
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    return items.length === 0 ? null : items.join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== "",
    );
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Screening, on create.
//
// HERE RATHER THAN IN lib/crm/merge.ts, AND THAT IS A SECURITY DECISION.
// A module carrying the server-action directive exports every function in it as
// a PUBLIC HTTP endpoint. This one takes an `organisationId` -- a raw uuid --
// because its
// callers are Server Actions that have already resolved the workspace from a
// slug through getCurrentOrg(), which is RLS-gated. Exporting it as an action
// would put a uuid-taking entry point on the network, which is the shape
// CLAUDE.md § Tenancy model says never to build ("never trust a client-supplied
// organisation ID"), even though the database would refuse it -- every
// statement it makes is gated by crm_write_organisations() and
// entity_is_manageable(), and the whole point of the convention is not having
// to make that argument at every call site.
// ---------------------------------------------------------------------------

/** What a screening call found. */
export interface ScreenResult {
  /**
   * Candidates flagged by this call that the CALLER CAN SEE.
   *
   * Only the visible ones: a match outside the caller's record scope is
   * written to the queue and not counted, because "we found 1" about a record
   * they are not entitled to know exists is an existence oracle.
   *
   * THE CREATE PATH DOES NOT RENDER IT TODAY, and that is worth saying rather
   * than leaving as an unused field. A create ends in `redirect()`, which
   * carries no message, so the number has nowhere to go on that journey -- and
   * the durable place a flag lives is the queue, which is a page. It is
   * returned because the caller that will want it (a record page saying "2
   * possible duplicates of this one") is the next screen to build, and because
   * a function that computed it and threw it away would be the more confusing
   * of the two shapes.
   */
  readonly flagged: number;
  /** Non-null when the record was auto-merged away into an older one. */
  readonly mergedInto: string | null;
}

/**
 * Screen a freshly created record for duplicates, and auto-merge on an exact
 * email match.
 *
 * ===========================================================================
 * WHY THE TWO CALLS ARE SEPARATE, WHICH IS NOT A STYLE CHOICE
 * ===========================================================================
 * public.screen_for_duplicates() is SECURITY DEFINER, because a duplicate the
 * caller cannot see is exactly the one that must reach a full-scope reviewer.
 * public.merge_records() is SECURITY INVOKER, because every statement a merge
 * runs has to be decided by the caller's own policies. Calling the second from
 * inside the first would run the whole merge as postgres with RLS not applied
 * -- SECURITY INVOKER means "the rights of the calling context", and inside a
 * definer body that context IS the definer. So the split is here, in the
 * application, and the merge meets the caller's own policies.
 *
 * Nothing is lost by it: the candidate row is written first, so a merge that
 * is then refused leaves the pair sitting in the queue rather than vanishing.
 *
 * ===========================================================================
 * A FAILURE HERE NEVER FAILS THE CREATE
 * ===========================================================================
 * The record has already been written and the user has already been told it
 * exists. Screening is a convenience on top of that, so its failure is logged
 * and swallowed rather than turned into an error about a save that worked.
 * The queue is not the only path to a merge -- a person who spots the
 * duplicate can still merge it by hand -- so a missed screening is a missed
 * hint, not lost data.
 */
export async function screenAfterCreate(
  organisationId: string,
  entityType: MergeEntityType,
  entityId: string,
): Promise<ScreenResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("screen_for_duplicates", {
    p_organisation_id: organisationId,
    p_entity_type: entityType,
    p_entity_id: entityId,
  });
  if (error) {
    console.error(`[crm] duplicate screening failed for ${entityType} ${entityId}:`, error.message);
    return { flagged: 0, mergedInto: null };
  }

  const result = (data ?? {}) as Record<string, unknown>;
  const flagged = typeof result.flagged === "number" ? result.flagged : 0;
  const winnerId = result.auto_merge_winner_id;
  const loserId = result.auto_merge_loser_id;

  // AUTO-MERGE IS EMAIL-ONLY AND FIRES ONLY WHEN THE DATABASE PROPOSES IT.
  // The two ids come from screen_for_duplicates(), which populates them only
  // for a case-insensitive email equality where BOTH records are manageable by
  // this caller. Nothing here decides it.
  if (typeof winnerId !== "string" || typeof loserId !== "string") {
    return { flagged, mergedInto: null };
  }

  const merge = await commitWrite(
    `auto-merge ${entityType} ${loserId} into ${winnerId}`,
    async () => {
      const { error: mergeError } = await supabase.rpc("merge_records", {
        p_organisation_id: organisationId,
        p_entity_type: entityType,
        p_winner_id: winnerId,
        p_loser_id: loserId,
        // NO CHOICES. An unattended merge must not pick a side: the function's
        // default keeps the older record's values and carries across only the
        // fields it has nothing in, so the auto-merge is additive to the
        // surviving record and destroys no value that was ever entered.
      });
      return { error: mergeError, count: 1 };
    },
  );

  // A REFUSED AUTO-MERGE IS NOT AN ERROR THE USER NEEDS. The candidate row is
  // already in the queue, so the pair is not lost -- it has become somebody's
  // review item instead of a silent merge, which is the safer of the two
  // outcomes and the one this whole feature defaults to.
  if (merge.outcome !== "applied") return { flagged, mergedInto: null };
  return { flagged, mergedInto: winnerId };
}
