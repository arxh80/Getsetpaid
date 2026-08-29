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
  describeCustomFieldValue,
  isCustomFieldType,
  parseOptions,
  type CustomFieldCell,
  type CustomFieldDefinition,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";

export type DefinitionsResult =
  | { readonly outcome: "loaded"; readonly definitions: CustomFieldDefinition[] }
  | { readonly outcome: "unavailable" };

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

  const { data, error } = await query.order("label", { ascending: true });
  if (error) {
    console.error("[crm] custom field definitions lookup failed:", error.message);
    return { outcome: "unavailable" };
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
  | { readonly outcome: "unavailable" };

/**
 * How many LIVE definitions each entity type already has.
 *
 * ONE ROUND TRIP FOR ALL FIVE, counted in JavaScript rather than five
 * `head: true` count queries: the row set is bounded by the tier limit times
 * five (or by whatever a Pro workspace has chosen), the settings page needs
 * every number at once to render "3 of 5 used" per tab, and five sequential
 * count requests on one render is the shape lib/list/query.ts already warns
 * about.
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
  const { data, error } = await supabase
    .from("custom_field_definitions")
    .select("entity_type")
    .eq("organisation_id", organisationId)
    .is("deleted_at", null);

  if (error) {
    console.error("[crm] custom field count lookup failed:", error.message);
    return { outcome: "unavailable" };
  }
  const counts: Record<string, number> = {
    company: 0,
    contact: 0,
    agency: 0,
    artist: 0,
    venue: 0,
  };
  for (const row of data as { entity_type: string }[]) {
    if (row.entity_type in counts) counts[row.entity_type] += 1;
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
  | { readonly outcome: "unavailable" };

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
      .eq("entity_id", entityId),
  ]);

  if (definitions.outcome === "unavailable") return { outcome: "unavailable" };
  if (values.error) {
    console.error("[crm] custom field values lookup failed:", values.error.message);
    return { outcome: "unavailable" };
  }

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
