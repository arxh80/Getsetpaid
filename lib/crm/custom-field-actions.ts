"use server";

// The custom fields engine's writes: four on the DEFINITION and one on the
// VALUES.
//
// The five-step shape lib/crm/contacts.ts states in full, with the plumbing
// imported from lib/crm/actions.ts:
//
//   1. Resolve the org through getCurrentOrg(). RLS-gated.
//   2. Ask getCrmWriteAccess() BEFORE validating, so a read_only role, a
//      suspended workspace and a Free-tier organisation each get a sentence
//      naming their situation.
//   3. Validate. Server-side, always.
//   4. Write through the CALLER'S OWN client, never the service-role one.
//   5. Read the ROW COUNT -- `commitWrite` / `classifyWrite`. A 204 is not a
//      save.
//
// ===========================================================================
// TWO PERMISSIONS, AND THE SPLIT IS THE POINT OF THE FEATURE
// ===========================================================================
// A DEFINITION is schema: who may create one is `manage_custom_fields`, which
// role_permissions gives to Owner and Admin ONLY -- read out of the seeded
// table rather than assumed (rls_phase2_crm.sql § A), and Manager is
// deliberately excluded because changing what fields exist is an admin act.
//
// A VALUE is an ordinary CRM write on the record it hangs off. A Booker who
// can edit an artist fills in that artist's custom fields WITHOUT holding
// manage_custom_fields, and the database is what says so:
// custom_field_values' three write policies gate on
// private.entity_is_manageable(), which resolves to manage_artists for an
// artist, manage_venues for a venue and manage_contacts for the relationship
// layer, and never to manage_custom_fields. Confirmed by reading the shipped
// policies rather than the plan; asserted in rls_phase2_crm.sql § F.
//
// `manage_custom_fields.survives_suspension` is false and stays false
// (20260828210000). A suspended workspace is read-only (founder decision Q6),
// so all five actions here close -- through getCrmWriteAccess()'s existing
// `org.isSuspended` branch, which is the same signal the banner uses, not a
// second one.
//
// ===========================================================================
// THE KEY IS IMMUTABLE AFTER CREATION, AND THAT IS WHY SOFT DELETE EXISTS
// ===========================================================================
// `updateCustomFieldAction` writes `label`, `field_type` and `options`. It
// does not write `key`, and the edit form renders it read-only.
//
// The alternative -- allowing a rename -- would fix the typo this task's first
// migration exists for (`contct_ref` -> `contact_ref`) more cheaply, and it is
// the wrong fix. The key is the field's stable external name: it is what an
// export, an import mapping and any later API would address the field by, and
// silently repointing that at a different string is the kind of edit that is
// free today and expensive in Phase 5, which reuses this engine verbatim for
// finance fields. Removing the mistyped field and creating the right one keeps
// the values visible under "Removed fields" and leaves an honest history.
//
// ===========================================================================
// CHANGING field_type WITH VALUES ALREADY STORED IS ALLOWED
// ===========================================================================
// The three options were: forbid the change while values exist, migrate the
// values, or allow it and render what no longer matches as inert.
//
// MIGRATION IS OUT: `"12x"` becoming a number has no correct answer, and
// guessing one destroys what somebody typed with no undo and no audit row
// until Phase 7.
//
// FORBIDDING IT BUYS NOTHING, and that is the argument that actually decides
// it. The mismatched-value state is reachable WITHOUT a type change --
// removing an option from a select that stored values still name does it, and
// so does any direct PostgREST write with the anon key -- so the renderer has
// to survive a mismatch either way (lib/crm/custom-fields.ts's `invalid`
// state, `describeCustomFieldValue`). Forbidding the change would therefore
// add a restriction and remove no code path, while making a field created with
// the wrong type as permanent as the mistyped key was.
//
// So the change is allowed, the entity panel renders the old values inert with
// a visible "needs fixing" note and the stored text beside the empty input,
// and saving the form replaces them. tests/unit/crm/custom-fields.test.ts
// drives every mismatch shape; the browser walk in task-5-report.md § 6 is the
// half a unit test cannot do.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import {
  authoriseOrg,
  failureState,
  liveInOrg,
  refusedEndState,
  stateFor,
  type ParentTable,
} from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import {
  buildCustomFieldPayload,
  customFieldLimit,
  ENTITY_PATH_SEGMENT,
  isCustomFieldEntityType,
  isCustomFieldType,
  isSelectType,
  MAX_CUSTOM_FIELD_LABEL,
  customFieldLimitMessage,
  parseOptionsInput,
  PERMISSION_FOR_ENTITY,
  slotAvailable,
  type CustomFieldEntityType,
  type CustomFieldOption,
} from "@/lib/crm/custom-fields";
import { loadCustomFieldDefinitions } from "@/lib/crm/custom-field-queries";

const DEFINITION_PERMISSION = "manage_custom_fields";

/** The definition editor's own page, per entity type. */
function settingsPath(orgSlug: string, entityType: CustomFieldEntityType): string {
  return `/${orgSlug}/settings/custom-fields?entity=${entityType}`;
}

const KEY_MESSAGE =
  "Use lowercase letters, numbers and underscores, starting with a letter — for example contact_ref.";

const KEY_TAKEN_MESSAGE =
  "A field on this entity already uses that name. If it was removed, restore it below instead of creating a second one — the name stays reserved so restoring can never collide.";

/** The organisation's remaining slots for one entity type, measured now. */
async function slotsLeft(
  organisationId: string,
  entityType: CustomFieldEntityType,
): Promise<
  | { readonly ok: true; readonly available: boolean; readonly limit: number | null }
  | { readonly ok: false }
> {
  const [entitlements, definitions] = await Promise.all([
    getOrganisationEntitlements(organisationId),
    loadCustomFieldDefinitions(organisationId, entityType),
  ]);
  if (definitions.outcome === "unavailable") return { ok: false };
  const limit = customFieldLimit(entitlements);
  return {
    ok: true,
    limit,
    available: slotAvailable(limit, definitions.definitions.length),
  };
}

interface ParsedDefinition {
  readonly label: string;
  readonly fieldType: string;
  readonly options: CustomFieldOption[] | null;
}

function readDefinition(
  formData: FormData,
  { withKey }: { withKey: boolean },
):
  | { readonly ok: true; readonly parsed: ParsedDefinition; readonly key: string | null }
  | { readonly ok: false; readonly state: FormState } {
  const values = echoedValues(formData);
  const fail = (fieldName: string, message: string) => ({
    ok: false as const,
    state: { fieldErrors: { [fieldName]: message }, values },
  });

  const label = field(formData, "label");
  if (label === null) return fail("label", "Give the field a name people will read.");
  if (label.length > MAX_CUSTOM_FIELD_LABEL) {
    return fail("label", `Use ${MAX_CUSTOM_FIELD_LABEL} characters or fewer.`);
  }

  const fieldType = field(formData, "fieldType");
  if (fieldType === null || !isCustomFieldType(fieldType)) {
    return fail("fieldType", "Choose what kind of field this is.");
  }

  let options: CustomFieldOption[] | null = null;
  if (isSelectType(fieldType)) {
    const parsed = parseOptionsInput(field(formData, "options"));
    if (!parsed.ok) return fail("options", parsed.message);
    options = parsed.options;
  }

  let key: string | null = null;
  if (withKey) {
    key = field(formData, "key");
    // The same pattern the column's CHECK holds. Checked here so the user gets
    // a sentence rather than a 23514 rendered as "something went wrong".
    if (key === null || !/^[a-z][a-z0-9_]{0,62}$/.test(key)) {
      return fail("key", KEY_MESSAGE);
    }
  }

  return { ok: true, parsed: { label, fieldType, options }, key };
}

/** Read and validate the `entityType` hidden field. */
function readEntityType(
  formData: FormData,
): CustomFieldEntityType | null {
  const raw = field(formData, "entityType");
  if (raw === null || !isCustomFieldEntityType(raw)) return null;
  return raw;
}

export async function createCustomFieldAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    DEFINITION_PERMISSION,
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityType = readEntityType(formData);
  if (entityType === null) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const parsed = readDefinition(formData, { withKey: true });
  if (!parsed.ok) return parsed.state;

  // THE PRE-CHECK IS FOR THE SENTENCE, NOT FOR THE ENFORCEMENT. The trigger in
  // 20260829010500 is what a direct PostgREST POST meets; this is what turns
  // the resulting 403 into a message that names the plan instead of the
  // generic "your access may have changed".
  const slots = await slotsLeft(org.id, entityType);
  if (!slots.ok) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (!slots.available && slots.limit !== null) {
    return { error: customFieldLimitMessage(slots.limit, entityType), values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("custom_field_definitions").insert({
    // NEVER FROM THE FORM. `org` is resolved from the slug through
    // getCurrentOrg(), which is RLS-gated -- CLAUDE.md § Tenancy model.
    organisation_id: org.id,
    entity_type: entityType,
    key: parsed.key,
    label: parsed.parsed.label,
    field_type: parsed.parsed.fieldType,
    options: parsed.parsed.options,
  });

  // AN INSERT IS THE ONE VERB WHERE THE STATUS CODE IS HONEST: a row refused
  // by WITH CHECK -- or by the tier trigger, which raises the same 42501 on
  // purpose -- is a 403, unlike UPDATE and DELETE which match nothing and
  // answer 204.
  if (error) {
    if (error.code === "23505") {
      return { fieldErrors: { key: KEY_TAKEN_MESSAGE }, values: echoedValues(formData) };
    }
    if (error.code === "42501") {
      // RE-MEASURED, NOT GUESSED. The pre-check above said there was a slot,
      // so either somebody took the last one between the two statements (the
      // race 20260829010500's header measures and accepts) or the refusal is
      // something else entirely. Asking again is the difference between
      // telling the user a true thing and telling them a plausible one.
      const again = await slotsLeft(org.id, entityType);
      if (again.ok && !again.available && again.limit !== null) {
        return {
          error: customFieldLimitMessage(again.limit, entityType),
          values: echoedValues(formData),
        };
      }
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[crm] create custom field failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidatePath(settingsPath(org.slug, entityType));
  return { message: `Added. “${parsed.parsed.label}” is now on every ${entityType}.` };
}

export async function updateCustomFieldAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    DEFINITION_PERMISSION,
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityType = readEntityType(formData);
  const fieldId = field(formData, "fieldId");
  if (entityType === null || !fieldId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const parsed = readDefinition(formData, { withKey: false });
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update custom field ${fieldId}`, () =>
    supabase
      .from("custom_field_definitions")
      .update(
        {
          label: parsed.parsed.label,
          field_type: parsed.parsed.fieldType,
          // NULL when the new type is not a select. The column's CHECK only
          // requires options for the two select types; leaving a stale list on
          // a field that is now `text` would resurrect it on the next retype.
          options: parsed.parsed.options,
        },
        // THE WHOLE POINT. Without this the response is 204/null/null whether
        // one row changed or none did. See lib/crm/write.ts.
        { count: "exact" },
      )
      // The tenant filter is explicit even though RLS already scopes it, and
      // `entity_type` is here for the same reason the child writes carry their
      // parent's id: a forged fieldId belonging to a DIFFERENT entity type in
      // the same workspace is permitted by the policy, which asks whether the
      // caller may write the row and not whether the row is the one this tab
      // is about.
      .eq("organisation_id", org.id)
      .eq("entity_type", entityType)
      .eq("id", fieldId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidatePath(settingsPath(org.slug, entityType));
  return stateFor(result, "Saved.", formData);
}

/**
 * Soft delete. `deleted_at`, never a hard delete.
 *
 * THE VALUES ARE NOT TOUCHED. The composite FK is ON DELETE CASCADE, so a hard
 * delete would take every stored value with it -- which is why there is no
 * DELETE policy and no DELETE grant on this table, and why this is an UPDATE.
 * The values stay in custom_field_values, keep rendering read-only under
 * "Removed fields" on each entity, and come back attached if the definition is
 * restored.
 *
 * `.is("deleted_at", null)` makes it idempotent in the honest direction:
 * removing an already-removed field matches no rows and is reported as refused
 * rather than silently re-stamping when it happened.
 */
export async function deleteCustomFieldAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    DEFINITION_PERMISSION,
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityType = readEntityType(formData);
  const fieldId = field(formData, "fieldId");
  if (entityType === null || !fieldId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const result = await commitWrite(`remove custom field ${fieldId}`, () =>
    supabase
      .from("custom_field_definitions")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("entity_type", entityType)
      .eq("id", fieldId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidatePath(settingsPath(org.slug, entityType));
  return stateFor(
    result,
    "Removed. It is off every form; anything already filled in is kept and shown under “Removed fields” on the record.",
    formData,
  );
}

/**
 * Restore a removed definition.
 *
 * A SLOT-CONSUMING WRITE, because a removed definition frees its slot (founder
 * decision Q12). So this is pre-checked exactly like a create, and the trigger
 * refuses it in the database if the pre-check was stale.
 */
export async function restoreCustomFieldAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    DEFINITION_PERMISSION,
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityType = readEntityType(formData);
  const fieldId = field(formData, "fieldId");
  if (entityType === null || !fieldId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const slots = await slotsLeft(org.id, entityType);
  if (!slots.ok) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (!slots.available && slots.limit !== null) {
    return {
      error: customFieldLimitMessage(slots.limit, entityType),
      values: echoedValues(formData),
    };
  }

  const supabase = await createClient();
  const result = await commitWrite(`restore custom field ${fieldId}`, () =>
    supabase
      .from("custom_field_definitions")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("entity_type", entityType)
      .eq("id", fieldId)
      // Mirror of the remove predicate: restoring a live field matches nothing
      // rather than reporting a success that changed nothing.
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") revalidatePath(settingsPath(org.slug, entityType));
  return stateFor(result, "Restored. It is back on every form, with its values.", formData);
}

// ===========================================================================
// VALUES
// ===========================================================================

/** entity_type -> the table liveInOrg() checks the record in. */
const PARENT_TABLE: Readonly<Record<CustomFieldEntityType, ParentTable>> = {
  company: "companies",
  contact: "contacts",
  agency: "agencies",
  artist: "artists",
  venue: "venues",
  // PHASE 3 TASK 1. public.events exists and carries RLS from
  // 20260901000000; its POLICIES land in Task 2, so until then this entry
  // resolves to a table that answers every caller with zero rows -- which
  // liveInOrg reads as "gone", the fail-closed direction. No screen reaches
  // it before Task 3 in any case.
  event: "events",
};

/**
 * Save every custom field on one entity row, in one transaction.
 *
 * ===========================================================================
 * ONE RPC, NOT ONE REQUEST PER FIELD
 * ===========================================================================
 * supabase-js issues one HTTP request per statement, so writing six fields
 * from here would be six requests and a form that can half-save. The whole
 * panel therefore goes through public.set_custom_field_values(), which does
 * the clear and the upsert inside one function and rolls both back together.
 * It is SECURITY INVOKER, so every custom_field_values policy still decides
 * every statement -- including the `entity_is_live` term 20260829011000 adds.
 *
 * `p_organisation_id` is passed and there is no overload without it, following
 * 20260828234500 in as many words: PostgREST resolves an RPC by argument name,
 * so an unscoped variant would be one omitted key away.
 *
 * ===========================================================================
 * THE COUNT CHANNEL IS NOT IN PLAY, AND THAT IS DELIBERATE
 * ===========================================================================
 * The function RAISES on every refusal -- the upsert by RLS, a shortfall
 * against what was asked for, and a survivor of a refused clear -- so a
 * returned value can never mean "refused". `count: 1` below is therefore not a
 * measured row count and is not pretending to be one; only the error
 * vocabulary is reused (42501 refused, 23505 conflict, anything else a fault).
 * Identical to setPrimaryCompanyAction, and its comment says the same thing.
 */
export async function saveCustomFieldValuesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const entityType = readEntityType(formData);
  if (entityType === null) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // THE ENTITY'S OWN PERMISSION, NOT manage_custom_fields. A Booker editing an
  // artist fills in its custom fields; they cannot define one.
  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    PERMISSION_FOR_ENTITY[entityType],
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityId = field(formData, "entityId");
  if (!entityId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();

  // BOTH HALVES OF THE PARENT CHECK. The database now backs this one
  // (20260829011000 puts private.entity_is_live() into the three write
  // policies), so this is the sentence rather than the only control -- and it
  // is tri-state, so a record in another workspace is not told to "restore it
  // first".
  const presence = await liveInOrg(
    supabase,
    PARENT_TABLE[entityType],
    org.id,
    entityId,
  );
  const blocked = refusedEndState([presence], formData);
  if (blocked) return blocked;

  const definitions = await loadCustomFieldDefinitions(org.id, entityType);
  if (definitions.outcome === "unavailable") {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (definitions.definitions.length === 0) {
    // Nothing to save, and nothing to apologise for. Reaching here means the
    // last definition was removed between the page rendering and the submit.
    return { message: "There are no custom fields on this record any more." };
  }

  // BUILT BY A PURE FUNCTION, so the one property worth asserting -- that a
  // field this form did not carry is OMITTED from the payload rather than sent
  // as the CLEAR verb -- is a unit test rather than a claim. See
  // buildCustomFieldPayload()'s own header, and I-2 of the fix round 1
  // findings: the `skip` outcome was documented in three comments and two test
  // names before it existed, and until it did an absent group marker deleted
  // the row it claimed to leave alone.
  const built = buildCustomFieldPayload(definitions.definitions, formData);
  if (!built.ok) {
    return { fieldErrors: built.fieldErrors, values: echoedValues(formData) };
  }
  const payload = built.payload;

  const result = await commitWrite(
    `save custom field values on ${entityType} ${entityId}`,
    async () => {
      const { error } = await supabase.rpc("set_custom_field_values", {
        p_organisation_id: org.id,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_values: payload,
      });
      return { error, count: 1 };
    },
  );

  if (result.outcome !== "applied") return failureState(result, formData);

  revalidatePath(`/${org.slug}/${ENTITY_PATH_SEGMENT[entityType]}/${entityId}`);
  return { message: "Custom fields saved." };
}
