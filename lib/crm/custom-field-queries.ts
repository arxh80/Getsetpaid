import "server-only";

// Reads for the custom fields engine: the definitions a workspace has, and the
// values one entity row carries.
//
// Separate from lib/crm/queries.ts because that file is per-entity (loadVenue,
// loadArtist, ...) and this is the one read that is the same for all five, and
// separate from lib/crm/custom-fields.ts because that one is pure and this one
// needs a client. Nothing here mutates -- every write goes through
// lib/crm/custom-field-actions.ts and lib/crm/write.ts.
//
// EVERY QUERY RUNS THROUGH THE CALLER'S OWN RLS-SCOPED CLIENT. There is no
// service-role path in this file and there must not be one: a definition is
// readable on `view_crm`, a value additionally on the entity being visible
// (custom_field_values_select_via_entity), and both of those are the product's
// answer to who sees what. A privileged read here would quietly bypass record
// scope for a standard_user.
//
// ===========================================================================
// A FAILED QUERY IS NOT AN EMPTY WORKSPACE
// ===========================================================================
// "The empty state must not lie" -- a read_only user in a workspace with 40
// custom fields must not be told there are none, and neither must anybody
// whose query simply failed. So every function here returns a discriminated
// result rather than `[]` on error, and the callers render "we couldn't load
// this" instead of "no custom fields yet". That is the same distinction
// lib/crm/queries.ts draws with `RecordResult` and deliberately NOT the one
// lib/auth/index.ts's getMemberships() still collapses.

import { createClient } from "@/lib/supabase/server";
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  describeCustomFieldValue,
  isCustomFieldType,
  parseOptions,
  type CustomFieldCell,
  type CustomFieldDefinition,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";

// ===========================================================================
// AND A TRUNCATED READ IS NOT A WHOLE ONE (Phase 10 Task 14, G5)
// ===========================================================================
// Pro's custom fields are unlimited and removed definitions accumulate on
// every tier, while PostgREST returns at most `[api] max_rows` (1000) rows and
// says nothing when it stops. So every read here is bounded, and one that
// reaches its bound returns `unavailable` with `reason: "too_many"` rather
// than a short list: a form that silently drops fields would save over them.

/** The most definitions of one entity type a page will render (G5). */
export const CUSTOM_FIELD_READ_CEILING = 500;

/** supabase/config.toml `[api] max_rows`: a longer response is cut here, silently. */
export const POSTGREST_MAX_ROWS = 1000;

/** Unavailable: the read failed, or (`reason: "too_many"`) it passed a ceiling. */
export type Unavailable = { readonly outcome: "unavailable"; readonly reason?: "too_many" };

const TOO_MANY: Unavailable = { outcome: "unavailable", reason: "too_many" };

/** What a page says instead of rendering a truncated set of custom fields. */
export const TOO_MANY_CUSTOM_FIELDS_MESSAGE = `This record type has more than ${CUSTOM_FIELD_READ_CEILING} custom fields, counting removed ones, which is more than this page can show. Nothing has been changed; contact support and we will help you tidy them up.`;

export type DefinitionsResult =
  | { readonly outcome: "loaded"; readonly definitions: CustomFieldDefinition[] }
  | Unavailable;

/** The columns every read below selects. One list, so they cannot drift. */
const DEFINITION_COLUMNS =
  "id, entity_type, key, label, field_type, options, deleted_at";

interface DefinitionRow {
  id: string;
  entity_type: string;
  key: string;
  label: string;
  field_type: string;
  options: unknown;
  deleted_at: string | null;
}

/**
 * Map a row, or null when it names a field_type this build does not know.
 *
 * FAIL CLOSED ON AN UNKNOWN field_type, for the same reason
 * lib/entitlements/tiers.ts's isTierKey() exists: the CHECK constraint
 * guarantees one of seven values TODAY, and Phase 3 or a later phase adding an
 * eighth would otherwise reach a `switch` with no arm for it. Dropping the row
 * renders a field short; rendering it would render a page wrong.
 */
function toDefinition(
  row: DefinitionRow,
  entityType: CustomFieldEntityType,
): CustomFieldDefinition | null {
  if (!isCustomFieldType(row.field_type)) {
    console.error(
      `[crm] custom field ${row.id} has field_type "${row.field_type}", which this build does not know; omitting it rather than rendering it wrong.`,
    );
    return null;
  }
  return {
    id: row.id,
    entityType,
    key: row.key,
    label: row.label,
    fieldType: row.field_type,
    options: parseOptions(row.options),
    deletedAt: row.deleted_at,
  };
}

/**
 * The definitions for one entity type in one workspace.
 *
 * `includeRemoved` is false by default -- an entity form shows live fields
 * only. The two callers that pass true are the definition editor (which lists
 * removed fields so they can be restored) and the entity panel (which renders
 * the values of removed fields read-only, because that is what makes "the
 * values survive a removal" a true statement rather than a claim about rows
 * nobody can reach).
 *
 * Ordered by label so the form's field order is stable and human, rather than
 * insertion order, which is invisible to the person filling it in.
 */
export async function loadCustomFieldDefinitions(
  organisationId: string,
  entityType: CustomFieldEntityType,
  options: { readonly includeRemoved?: boolean } = {},
): Promise<DefinitionsResult> {
  const supabase = await createClient();
  let query = supabase
    .from("custom_field_definitions")
    .select(DEFINITION_COLUMNS)
    // The tenant filter is explicit even though RLS already scopes it:
    // multi-org membership ships at MVP, so RLS alone would serve this
    // workspace's page the caller's OTHER workspace's fields.
    .eq("organisation_id", organisationId)
    .eq("entity_type", entityType);
  if (!options.includeRemoved) query = query.is("deleted_at", null);

  const { data, error } = await query
    .order("label", { ascending: true })
    .limit(CUSTOM_FIELD_READ_CEILING + 1);
  if (error) {
    console.error("[crm] custom field definitions lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  if (data.length > CUSTOM_FIELD_READ_CEILING) {
    console.error(
      `[crm] more than ${CUSTOM_FIELD_READ_CEILING} ${entityType} custom field definitions in organisation ${organisationId}; refusing a truncated list.`,
    );
    return TOO_MANY;
  }
  const definitions = (data as DefinitionRow[])
    .map((row) => toDefinition(row, entityType))
    .filter((definition): definition is CustomFieldDefinition => definition !== null);
  return { outcome: "loaded", definitions };
}

export type CountsResult =
  | {
      readonly outcome: "loaded";
      /** Live definitions per entity type. Every key present, zeros included. */
      readonly counts: Readonly<Record<CustomFieldEntityType, number>>;
    }
  | Unavailable;

/**
 * How many LIVE definitions each entity type already has.
 *
 * ONE `head: true` COUNT PER ENTITY TYPE, in parallel (G5). It used to read
 * every live definition and count in JavaScript, which past max_rows counted
 * only the first 1000 -- a Pro workspace has no limit -- and said nothing.
 * A count returns no rows, so it has no ceiling to pass.
 *
 * IT COUNTS WHAT THE TRIGGER COUNTS -- `deleted_at is null`, per entity type
 * -- because it is what the UI compares against the limit. It is NOT the
 * enforcement: private.custom_field_slot_available() is, and this number can
 * be stale by the time a submit lands. The action re-measures.
 */
export async function loadCustomFieldCounts(
  organisationId: string,
): Promise<CountsResult> {
  const supabase = await createClient();
  // SEEDED FROM THE VOCABULARY, NOT A HAND-KEPT LIST, so every entity type
  // gets a count -- iterating a literal was how `event` (Phase 3) and
  // `financial_entry` (Phase 5) reached the tab strip with a blank count.
  const results = await Promise.all(
    CUSTOM_FIELD_ENTITY_TYPES.map((type) =>
      supabase
        .from("custom_field_definitions")
        .select("id", { count: "exact", head: true })
        .eq("organisation_id", organisationId)
        .eq("entity_type", type)
        .is("deleted_at", null),
    ),
  );
  const counts: Record<string, number> = {};
  for (const [i, type] of CUSTOM_FIELD_ENTITY_TYPES.entries()) {
    const { count, error } = results[i]!;
    if (error || count === null) {
      console.error("[crm] custom field count lookup failed:", error?.message ?? "no count returned");
      return { outcome: "unavailable" };
    }
    counts[type] = count;
  }
  return {
    outcome: "loaded",
    counts: counts as Record<CustomFieldEntityType, number>,
  };
}

export interface CustomFieldPanel {
  /** Live fields, in label order. Rendered as inputs. */
  readonly live: readonly CustomFieldCell[];
  /**
   * Values whose definition has been REMOVED. Rendered read-only, and only
   * when there are any -- a workspace that has never removed a field sees no
   * such block at all.
   */
  readonly removed: readonly CustomFieldCell[];
}

export type PanelResult =
  | { readonly outcome: "loaded"; readonly panel: CustomFieldPanel }
  | Unavailable;

/**
 * Everything one entity row's custom fields panel needs, in two round trips.
 *
 * The values are fetched for the ENTITY, not for the definition list, so a
 * value whose definition is removed still arrives -- that is the row the
 * "Removed fields" block exists to show, and filtering by the live definition
 * ids would silently hide exactly the data this task promises survives.
 */
export async function loadCustomFieldPanel(
  organisationId: string,
  entityType: CustomFieldEntityType,
  entityId: string,
): Promise<PanelResult> {
  const supabase = await createClient();
  const [definitions, values] = await Promise.all([
    loadCustomFieldDefinitions(organisationId, entityType, { includeRemoved: true }),
    supabase
      .from("custom_field_values")
      .select("field_id, value")
      .eq("organisation_id", organisationId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      // At most one value per definition, and the definitions are capped above.
      .limit(CUSTOM_FIELD_READ_CEILING + 1),
  ]);

  if (definitions.outcome === "unavailable") return definitions;
  if (values.error) {
    console.error("[crm] custom field values lookup failed:", values.error.message);
    return { outcome: "unavailable" };
  }
  if (values.data.length > CUSTOM_FIELD_READ_CEILING) return TOO_MANY;

  const stored = new Map<string, unknown>();
  for (const row of values.data as { field_id: string; value: unknown }[]) {
    stored.set(row.field_id, row.value);
  }

  const live: CustomFieldCell[] = [];
  const removed: CustomFieldCell[] = [];
  for (const definition of definitions.definitions) {
    const cell = describeCustomFieldValue(definition, stored.get(definition.id));
    if (definition.deletedAt === null) {
      live.push(cell);
    } else if (cell.state !== "empty") {
      // A removed field with NO value is nothing to show. Listing it would
      // fill the block with rows that say "—" and bury the ones that matter.
      removed.push(cell);
    }
  }
  return { outcome: "loaded", panel: { live, removed } };
}

export interface EntityCustomFields {
  /** The LIVE definitions, in label order. */
  readonly definitions: readonly CustomFieldDefinition[];
  /** entityId -> its LIVE fields as cells, described from stored values. Only
   *  entities that had at least one stored value appear; the caller falls back
   *  to empty cells (definitions described against `undefined`) for the rest. */
  readonly cellsByEntity: ReadonlyMap<string, readonly CustomFieldCell[]>;
}

export type EntityCustomFieldsResult =
  | { readonly outcome: "loaded"; readonly fields: EntityCustomFields }
  | Unavailable;

/**
 * The LIVE custom fields for MANY entity rows of one type, in two round trips.
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE loadCustomFieldPanel
 * ===========================================================================
 * `loadCustomFieldPanel` is one entity's detail page: it fetches removed-field
 * values too and is one round trip PER entity. A finance line has NO detail
 * page -- its custom-field inputs render inside the finance add/edit form on
 * the EVENT page, where a whole page of lines shows at once. Calling the panel
 * loader once per line would be one query per line; this batches all of them
 * into a single `entity_id in (...)` read. It also drops the removed-field
 * half, because the inline finance form renders LIVE fields only (there is no
 * "Removed fields" disclosure on a form that is not a standalone panel).
 *
 * Same RLS discipline as every read here: the caller's own client, so a value
 * is returned only when custom_field_values_select_via_entity admits it
 * (view_crm + entity_is_visible, which for `financial_entry` is view_finance).
 */
export async function loadCustomFieldCellsForEntities(
  organisationId: string,
  entityType: CustomFieldEntityType,
  entityIds: readonly string[],
): Promise<EntityCustomFieldsResult> {
  // Removed definitions too: their values come back for these entities as
  // well, so they count toward how many rows one entity can carry.
  const definitions = await loadCustomFieldDefinitions(organisationId, entityType, {
    includeRemoved: true,
  });
  if (definitions.outcome === "unavailable") return definitions;

  const live = definitions.definitions.filter((d) => d.deletedAt === null);
  // Nothing defined, or nothing to look up: the definitions still travel back
  // (the ADD form renders empty cells from them), but there are no values to
  // fetch, so the second round trip is skipped.
  if (live.length === 0 || entityIds.length === 0) {
    return { outcome: "loaded", fields: { definitions: live, cellsByEntity: new Map() } };
  }

  // G5: a page of entities times every definition can pass max_rows, so the
  // ids go in chunks whose worst case stays under it. A chunk that still
  // fills max_rows was cut short, and the read refuses rather than truncate.
  const perChunk = Math.max(1, Math.floor((POSTGREST_MAX_ROWS - 1) / definitions.definitions.length));
  const chunks: string[][] = [];
  for (let i = 0; i < entityIds.length; i += perChunk) chunks.push(entityIds.slice(i, i + perChunk));
  const supabase = await createClient();
  const results = await Promise.all(
    chunks.map((ids) =>
      supabase
        .from("custom_field_values")
        .select("entity_id, field_id, value")
        .eq("organisation_id", organisationId)
        .eq("entity_type", entityType)
        .in("entity_id", ids)
        .limit(POSTGREST_MAX_ROWS),
    ),
  );

  const rows: { entity_id: string; field_id: string; value: unknown }[] = [];
  for (const { data, error } of results) {
    if (error) {
      console.error("[crm] custom field values (batch) lookup failed:", error.message);
      return { outcome: "unavailable" };
    }
    if (data.length >= POSTGREST_MAX_ROWS) return TOO_MANY;
    rows.push(...(data as typeof rows));
  }

  // entityId -> (fieldId -> value)
  const stored = new Map<string, Map<string, unknown>>();
  for (const row of rows) {
    let perEntity = stored.get(row.entity_id);
    if (perEntity === undefined) {
      perEntity = new Map<string, unknown>();
      stored.set(row.entity_id, perEntity);
    }
    perEntity.set(row.field_id, row.value);
  }

  const cellsByEntity = new Map<string, readonly CustomFieldCell[]>();
  for (const [entityId, perEntity] of stored) {
    cellsByEntity.set(
      entityId,
      live.map((definition) =>
        describeCustomFieldValue(definition, perEntity.get(definition.id)),
      ),
    );
  }

  return { outcome: "loaded", fields: { definitions: live, cellsByEntity } };
}
