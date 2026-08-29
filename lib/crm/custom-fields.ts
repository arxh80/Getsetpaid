// The custom fields engine's pure half: the entity-type list, the seven field
// types, the `options` contract, per-type validation on the way IN and per-type
// classification on the way OUT.
//
// NO `import "server-only"`, deliberately, and no query builder: everything
// here is a pure function over strings and JSON, so it is unit-testable
// without a database (tests/unit/crm/custom-fields.test.ts) and the
// definition-editor component can share the option-format helpers with the
// Server Action that validates them. The database work lives in
// lib/crm/custom-field-queries.ts (server-only) and lib/crm/custom-field-
// actions.ts ("use server").
//
// ===========================================================================
// THE ENTITY-TYPE LIST BELOW IS THE FOURTH COPY, AND THAT IS ON PURPOSE
// ===========================================================================
// 20260827232512's header is explicit that the five-value allowlist is
// duplicated across three CHECK constraints rather than shared, and why:
//
//     "Phase 3 adds 'event' to all three, and having to touch three
//      constraints is the reminder that three code paths change too."
//
// This constant is a FOURTH copy, in a fourth language, and the brief asks it
// to be declared as one. It exists because the definition editor has to render
// a tab per entity type and the router has to validate `?entity=` against
// something, and neither can read a CHECK constraint at request time.
//
// HOW A PHASE 3 DEVELOPER FINDS IT WITHOUT READING THIS COMMENT:
// tests/integration/crm/custom-field-entity-types-match-db.test.ts reads all
// THREE constraint definitions out of the live catalogue (pg_get_constraintdef)
// and asserts each one's value set equals this array. Adding 'event' to the
// constraints and not to this file turns that test red with a message naming
// this file; adding it here and not to the constraints turns it red the other
// way. It is the same tripwire tiers.ts, MFA_REQUIRED_ROLES and
// PAST_DUE_GRACE_DAYS already have, applied to the one list this task adds.
//
// It is deliberately NOT a way to avoid touching the constraints -- the count
// is now four, and the reminder is louder rather than quieter.

// The URL rules live in ONE file for the whole application: normaliseWebsite()
// is the write-side protocol allowlist and safeHref() the render-side one, both
// already carrying Task 4's measurements. A `url` custom field gets those and
// not a second implementation. groupMarkerName() likewise -- the "an unticked
// checkbox submits nothing" problem is already solved in lib/forms.ts and a
// second spelling of the suffix would drift from the component that renders it.
import { groupMarkerName } from "@/lib/forms";
import { normaliseWebsite, safeHref } from "@/lib/crm/urls";

/** The five CRM entities a custom field can be attached to. Phase 3 adds 'event'. */
export const CUSTOM_FIELD_ENTITY_TYPES = [
  "company",
  "contact",
  "agency",
  "artist",
  "venue",
] as const;

export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];

export function isCustomFieldEntityType(
  value: string,
): value is CustomFieldEntityType {
  return (CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Plural, for the URL segment and the page copy. Same order as the list. */
export const ENTITY_TYPE_LABELS: Readonly<Record<CustomFieldEntityType, string>> = {
  company: "Companies",
  contact: "Contacts",
  agency: "Agencies",
  artist: "Artists",
  venue: "Venues",
};

/**
 * The CRM permission key that governs one entity type's records.
 *
 * ===========================================================================
 * A FIFTH COPY OF A MAPPING THAT LIVES IN SQL, AND IT DECIDES A SENTENCE
 * RATHER THAN AN ANSWER
 * ===========================================================================
 * private.entity_is_manageable() (20260828120500) holds this mapping in the
 * database and its comment says why it lives there: "the permission key
 * differs PER ENTITY TYPE, not per call site ... passing the key in from the
 * policy would put that mapping in twelve places."
 *
 * That function is the ENFORCEMENT and nothing here changes it -- every custom
 * field value write is decided by it, through the three write policies, before
 * it commits. What this table is for is `getCrmWriteAccess(org, key)`, which
 * produces the SENTENCE a blocked user reads ("Your role in this workspace can
 * view records but not change them") and the decision to render controls at
 * all. Getting it wrong here shows the wrong explanation or hides a control
 * from somebody who could have used it; it cannot open a write.
 *
 * BOUND TO THE SQL RATHER THAN TRUSTED: tests/unit/crm/source-shape.test.ts
 * parses entity_is_manageable()'s body out of the migration and asserts each
 * `when '<entity>'` branch names the key this table gives it. Change one,
 * change both, and the test is what tells you that you did not.
 */
export const PERMISSION_FOR_ENTITY: Readonly<
  Record<CustomFieldEntityType, string>
> = {
  company: "manage_contacts",
  contact: "manage_contacts",
  agency: "manage_contacts",
  artist: "manage_artists",
  venue: "manage_venues",
};

/**
 * The URL segment each entity type's pages live under.
 *
 * Only used to revalidate the detail page a values save came from and to link
 * back to it. It is the plural of the entity_type value in every case, but it
 * is written out rather than derived: `agency` -> `agencies` is not a suffix
 * rule, and a helper that gets four right and one wrong is worse than a table.
 */
export const ENTITY_PATH_SEGMENT: Readonly<
  Record<CustomFieldEntityType, string>
> = {
  company: "companies",
  contact: "contacts",
  agency: "agencies",
  artist: "artists",
  venue: "venues",
};

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

/** The seven values 20260827232512's CHECK constraint allows, in its order. */
export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "single_select",
  "multi_select",
  "url",
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: string): value is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

export const FIELD_TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes / no",
  single_select: "Choose one",
  multi_select: "Choose several",
  url: "Web address",
};

/** The two types the `options` list is required for -- and only allowed for. */
export const SELECT_TYPES: readonly CustomFieldType[] = [
  "single_select",
  "multi_select",
];

export function isSelectType(fieldType: CustomFieldType): boolean {
  return SELECT_TYPES.includes(fieldType);
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

export interface CustomFieldOption {
  readonly key: string;
  readonly label: string;
}

export interface CustomFieldDefinition {
  readonly id: string;
  readonly entityType: CustomFieldEntityType;
  readonly key: string;
  readonly label: string;
  readonly fieldType: CustomFieldType;
  readonly options: readonly CustomFieldOption[];
  /** Soft-deleted: the field is removed from every form, its values survive. */
  readonly deletedAt: string | null;
}

/** Everything a stored value can legitimately be, per field type. */
export type CustomFieldJson = string | number | boolean | readonly string[];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The cap on a `text` custom field's value.
 *
 * Same reasoning as MAX_SHORT_TEXT in lib/crm/validate.ts -- `value` is
 * unbounded jsonb in the schema, which is right for the schema and wrong for a
 * form, because a megabyte pasted into one renders on every load of that
 * record's page from then on. 500 rather than 200: a custom field is whatever
 * the customer needed that the product did not give them, and a stage-plot
 * note or an address is longer than a job title.
 */
export const MAX_CUSTOM_FIELD_TEXT = 500;

/**
 * The cap on a definition's label. The column's only constraint is
 * `btrim(label) <> ''`, and it is rendered on every entity form.
 */
export const MAX_CUSTOM_FIELD_LABEL = 60;

/**
 * The cap on how many options one select field may carry.
 *
 * A dropdown of 50 is already past the point where a text field would serve
 * the user better, and `options` is read on every render of every entity of
 * that type.
 */
export const MAX_CUSTOM_FIELD_OPTIONS = 50;

/**
 * The number bound.
 *
 * jsonb stores arbitrary-precision numerics, JavaScript does not: anything
 * past Number.MAX_SAFE_INTEGER round-trips through JSON.parse as a different
 * number, silently. 1e15 is comfortably inside that and past any real fee,
 * capacity or count this field would hold.
 */
export const MAX_CUSTOM_FIELD_NUMBER = 1e15;

/** The identifier shape the DB pins for both `key` and every option key. */
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function isCustomFieldKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The tier limit -- the TypeScript half of private.custom_field_limit()
// ---------------------------------------------------------------------------

/**
 * How many LIVE definitions this organisation may hold per entity type.
 * `null` means unlimited.
 *
 * MIRRORS private.custom_field_limit() CLAUSE FOR CLAUSE, and the mirror is
 * bound by a test rather than by this sentence:
 * tests/integration/crm/custom-field-limit-matches-db.test.ts drives the
 * DEPLOYED function against this one across every subscription status and both
 * sides of the past_due grace boundary. That is the fourth instance of the
 * pattern this codebase already uses for the tier matrix, the MFA role list
 * and the grace window itself.
 *
 * "no-subscription" IS UNLIMITED, NOT FREE, and that is the one clause worth
 * arguing. `entitlementsPermitCrmWrites` already reads a missing subscription
 * row as "not yet billed, therefore not yet gated" -- create_organisation()
 * writes no subscription row, so every organisation that exists today has
 * none. Reading it as Free here would resolve to a limit of ZERO and ship the
 * whole feature dead on arrival, for every customer. Phase 7 removes this
 * escape here and in the SQL in one change.
 *
 * "indeterminate" IS ZERO, and it deliberately does NOT match the database,
 * for the reason `entitlementsPermitCrmWrites` gives for the same asymmetry: a
 * failed lookup in the application is not the same event as a missing row in
 * the database, and the consequence differs. Here it hides a create form;
 * there it would open a gate. In practice this branch is unreachable through
 * the UI, because getCrmWriteAccess() already refuses the whole screen on
 * "indeterminate" before any limit is consulted.
 */
export function customFieldLimit(result: {
  status: "no-subscription" | "resolved" | "indeterminate";
  entitlements: { customFieldLimit: number | null };
}): number | null {
  if (result.status === "no-subscription") return null;
  if (result.status === "indeterminate") return 0;
  return result.entitlements.customFieldLimit;
}

/** True when one more live definition fits. `limit === null` is unlimited. */
export function slotAvailable(limit: number | null, used: number): boolean {
  if (limit === null) return true;
  return used < limit;
}

// ---------------------------------------------------------------------------
// options: the stored shape, and the textarea the definition editor uses
// ---------------------------------------------------------------------------

/**
 * Read `options` as it comes back from PostgREST.
 *
 * DEFENSIVE EVEN THOUGH A CHECK CONSTRAINT NOW GUARANTEES THE SHAPE
 * (custom_field_definitions_options_element_shape, 20260829010000). The
 * constraint is validated for rows written after it existed; this function
 * also has to survive a row written before it, and a jsonb column is a jsonb
 * column. Anything that does not parse is DROPPED rather than rendered, which
 * turns a malformed option into a missing choice rather than a crashed page.
 */
export function parseOptions(raw: unknown): CustomFieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomFieldOption[] = [];
  const seen = new Set<string>();
  for (const element of raw) {
    if (typeof element !== "object" || element === null) continue;
    const record = element as Record<string, unknown>;
    const key = record.key;
    const label = record.label;
    if (typeof key !== "string" || typeof label !== "string") continue;
    if (!isCustomFieldKey(key) || label.trim() === "") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out;
}

export type OptionsResult =
  | { readonly ok: true; readonly options: CustomFieldOption[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parse the definition editor's options textarea.
 *
 * ONE OPTION PER LINE, `key = Label`, with a bare line meaning the key and the
 * label are the same string.
 *
 * THE KEY IS EXPLICIT RATHER THAN DERIVED FROM THE LABEL, and that is the
 * decision in this function. Slugifying the label is friendlier to type and
 * silently destructive to edit: renaming "Guest list" to "Guestlist" would
 * change the key, and every stored value referencing the old key would become
 * an option that no longer exists. An explicit key means a label can be
 * corrected without touching any data.
 */
export function parseOptionsInput(raw: string | null): OptionsResult {
  const options: CustomFieldOption[] = [];
  const seen = new Set<string>();
  const lines = (raw ?? "").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const split = trimmed.indexOf("=");
    const key = (split === -1 ? trimmed : trimmed.slice(0, split)).trim();
    const label = (split === -1 ? trimmed : trimmed.slice(split + 1)).trim();

    if (!isCustomFieldKey(key)) {
      return {
        ok: false,
        message: `“${key}” can’t be a choice name. Use lowercase letters, numbers and underscores, starting with a letter — for example “guest_list = Guest list”.`,
      };
    }
    if (label === "") {
      return { ok: false, message: `“${key}” needs something to show for it.` };
    }
    if (label.length > MAX_CUSTOM_FIELD_LABEL) {
      return {
        ok: false,
        message: `“${label.slice(0, 20)}…” is too long. Use ${MAX_CUSTOM_FIELD_LABEL} characters or fewer per choice.`,
      };
    }
    if (seen.has(key)) {
      return {
        ok: false,
        message: `“${key}” is listed twice. Each choice needs its own name.`,
      };
    }
    seen.add(key);
    options.push({ key, label });
    if (options.length > MAX_CUSTOM_FIELD_OPTIONS) {
      return {
        ok: false,
        message: `Use ${MAX_CUSTOM_FIELD_OPTIONS} choices or fewer. A longer list is easier to fill in as a text field.`,
      };
    }
  }

  if (options.length === 0) {
    return {
      ok: false,
      message:
        "A choice field needs at least one choice, or nobody can fill it in.",
    };
  }
  return { ok: true, options };
}

/** The inverse, for pre-filling the editor. */
export function formatOptionsInput(
  options: readonly CustomFieldOption[],
): string {
  return options
    .map((option) =>
      option.key === option.label ? option.key : `${option.key} = ${option.label}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// The input name every custom field control carries
// ---------------------------------------------------------------------------

/**
 * The form field name for one definition.
 *
 * KEYED BY THE DEFINITION'S ID, NOT ITS `key`. The key is unique per
 * (organisation, entity type) and would be shorter and more readable in the
 * DOM -- and it can COLLIDE with the panel's own hidden inputs (`orgSlug`,
 * `entityId`) and, after a rename, with itself. The id cannot, and it is the
 * value the RPC's payload is keyed by anyway, so there is one identifier from
 * the input to the row rather than a mapping in the middle.
 */
export function customFieldInputName(definitionId: string): string {
  return `cf_${definitionId}`;
}

// ---------------------------------------------------------------------------
// Validation: form input -> the jsonb to store, or a sentence
// ---------------------------------------------------------------------------

/**
 * What one submitted field asks for.
 *
 * ===========================================================================
 * THREE OUTCOMES, AND THE THIRD WAS DOCUMENTED BEFORE IT EXISTED (I-1 of the
 * review's Important findings, fix round 1)
 * ===========================================================================
 * This used to be `{ ok: true; value: CustomFieldJson | null }`, where `null`
 * meant CLEAR -- and the comments on the `boolean` and `multi_select` branches
 * said an absent group marker "leaves the value exactly as it was", which
 * `null` is not: `saveCustomFieldValuesAction` put it in the payload
 * unconditionally, and in the RPC's payload JSON `null` is the CLEAR verb that
 * DELETES the row. Two unit tests were named after the behaviour and asserted
 * only `value: null`, so they passed while the opposite happened.
 *
 * "not asked" is a real third answer and it now has a representation. The
 * marker mechanism (`groupMarkerName` / `selectedInGroup` in lib/forms.ts)
 * exists precisely to tell "the group was submitted and the answer is none"
 * from "the group was not on this form", and `skip` is the second of those
 * reaching the write path intact: `buildCustomFieldPayload()` OMITS the field
 * from the RPC's payload, and the RPC touches only the keys it is given.
 *
 * IT APPLIES TO ALL SEVEN TYPES, not just the two with a marker. A text input
 * that is present and empty submits `name=""`; one that is not on the form
 * submits nothing at all, so `formData.has(name)` separates them for the five
 * single-value types exactly as the marker does for the two group ones. Before
 * this, a partial form -- one rendered without a field, for any reason -- would
 * have silently deleted that field's value on the next save.
 */
export type CustomFieldValueResult =
  /** Store this value. Its JSON type always matches the definition's. */
  | { readonly ok: true; readonly outcome: "set"; readonly value: CustomFieldJson }
  /** The field was submitted empty: delete the row. Nothing is stored. */
  | { readonly ok: true; readonly outcome: "clear" }
  /** The form did not carry this field: leave whatever is stored alone. */
  | { readonly ok: true; readonly outcome: "skip" }
  | { readonly ok: false; readonly message: string };

/** The two `ok` shorthands, so the branches below read as their outcome. */
const CLEAR = { ok: true, outcome: "clear" } as const;
const SKIP = { ok: true, outcome: "skip" } as const;

function setTo(value: CustomFieldJson): CustomFieldValueResult {
  return { ok: true, outcome: "set", value };
}

/**
 * Validate one submitted custom field value against its definition.
 *
 * EVERY TYPE STORES A JSON VALUE OF THE MATCHING JSON TYPE, never a string
 * standing in for one -- `12` and not `"12"`, `true` and not `"true"`. That is
 * what makes the read side able to tell a value that matches its field from
 * one that does not, which is the whole of the field_type-change story below.
 *
 * EMPTY IS "CLEAR", NOT "EMPTY STRING". Storing `""` would be a third state
 * beside "no row" and "a value", indistinguishable to a reader and different
 * to a query. A blank input therefore returns `clear` and the RPC deletes.
 *
 * ABSENT IS "SKIP", WHICH IS NOT THE SAME AS EMPTY. See
 * `CustomFieldValueResult`. Every branch below establishes that the form
 * actually carried the field before deciding anything else -- `formData.has()`
 * for the five single-value types, the group marker for the two that are
 * checkbox groups.
 *
 * THE ARGUMENT IS FormData, not a pre-read string, because two of the seven
 * types are not a single value: `multi_select` is a checkbox group and
 * `boolean` is a group of one, and both need `getAll` plus the group marker
 * from lib/forms.ts to tell "cleared" from "never asked".
 */
export function readCustomFieldValue(
  definition: CustomFieldDefinition,
  formData: FormData,
): CustomFieldValueResult {
  const name = customFieldInputName(definition.id);
  // PRESENT-AND-EMPTY IS NOT ABSENT. An `<input>` that is on the form always
  // submits its name, even with nothing typed in it; one that is not on the
  // form submits nothing at all. `has()` is the whole difference between
  // "the user cleared this" and "this form did not ask", for the five types
  // that are a single control. The two checkbox groups cannot use it -- an
  // unticked box submits nothing either -- so they use the hidden marker
  // lib/forms.ts's groupMarkerName() exists for.
  const asked = formData.has(name);
  const single = readTrimmed(formData, name);

  switch (definition.fieldType) {
    case "text": {
      if (!asked) return SKIP;
      if (single === null) return CLEAR;
      if (single.length > MAX_CUSTOM_FIELD_TEXT) {
        return {
          ok: false,
          message: `Use ${MAX_CUSTOM_FIELD_TEXT} characters or fewer.`,
        };
      }
      // NOT SANITISED, AND THAT IS THE RULE THIS CODEBASE ALREADY APPLIES to
      // artists.notes and venues.technical_info: it is untrusted content
      // rendered as TEXT, never as HTML and never through
      // dangerouslySetInnerHTML, so React escapes it on the way out. Stripping
      // here would silently rewrite what somebody typed about their own record.
      return setTo(single);
    }

    case "number": {
      if (!asked) return SKIP;
      if (single === null) return CLEAR;
      // A strict numeric literal. `Number("")` is 0 and `Number("1,200")` is
      // NaN but `parseFloat("1,200")` is 1 -- neither is a good way to read a
      // form, so the shape is checked before the conversion. Same discipline
      // as checkCapacity() in lib/crm/validate.ts.
      if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(single)) {
        return {
          ok: false,
          message: "Use a number, like 250 or 12.5. Leave it blank if there isn’t one.",
        };
      }
      const parsed = Number(single);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: "That isn’t a number this field can hold." };
      }
      if (Math.abs(parsed) > MAX_CUSTOM_FIELD_NUMBER) {
        return {
          ok: false,
          message: "That number is too large for this field.",
        };
      }
      return setTo(parsed);
    }

    case "date": {
      if (!asked) return SKIP;
      if (single === null) return CLEAR;
      const problem = checkCalendarDate(single);
      if (problem) return { ok: false, message: problem };
      // THE STRING, NEVER A `Date`. A calendar date is not an instant: the
      // same reasoning lib/crm/validate.ts's checkDate() spells out for
      // artist_representations.started_at applies unchanged -- `new
      // Date("2026-03-03")` is UTC midnight, and formatting that in
      // Europe/London during BST renders "2 March". CLAUDE.md's "UTC in the
      // database, UK local in the UI" is about INSTANTS; a date has no
      // instant to convert.
      return setTo(single);
    }

    case "boolean": {
      // A GROUP OF ONE. An unticked checkbox submits nothing, so `getAll` is
      // empty for "no" and for "this form never had the field" alike -- which
      // is exactly why the panel renders a hidden marker beside it. An absent
      // marker means the form did not ask, and `skip` is what keeps the stored
      // value: it is omitted from the RPC's payload, and the RPC touches only
      // the keys it is given. This branch RETURNED `value: null` until fix
      // round 1, which the RPC reads as the CLEAR verb -- so the comment said
      // "left exactly as it was" while the row was being deleted.
      if (formData.get(groupMarkerName(name)) === null) {
        return SKIP;
      }
      const ticked = formData
        .getAll(name)
        .some((entry) => typeof entry === "string" && entry === "true");
      // UNTICKED CLEARS RATHER THAN STORING `false`. A checkbox can express
      // two states and the field has three (yes / no / not answered), so
      // storing `false` for an untouched box would assert an answer nobody
      // gave. Clearing keeps "no" and "not answered" the same thing on a
      // control that cannot tell them apart -- and a `false` written by some
      // other path still reads back as "No" rather than as broken.
      return ticked ? setTo(true) : CLEAR;
    }

    case "single_select": {
      if (!asked) return SKIP;
      if (single === null) return CLEAR;
      if (!definition.options.some((option) => option.key === single)) {
        return {
          ok: false,
          message: "Pick one of the choices on this field.",
        };
      }
      return setTo(single);
    }

    case "multi_select": {
      // Same marker rule, and the same correction, as `boolean` above.
      if (formData.get(groupMarkerName(name)) === null) {
        return SKIP;
      }
      const raw = formData
        .getAll(name)
        .filter((entry): entry is string => typeof entry === "string");
      const allowed = new Set(definition.options.map((option) => option.key));
      const chosen: string[] = [];
      for (const entry of raw) {
        if (!allowed.has(entry)) {
          return { ok: false, message: "Pick from the choices on this field." };
        }
        // DUPLICATES ARE DROPPED, NOT REFUSED. A checkbox group cannot produce
        // one, so the only source is a hand-built POST -- and ["a","a"] means
        // the same thing as ["a"], so refusing it would be a sentence about a
        // difference that does not exist. Order follows the DEFINITION rather
        // than the submission, so the stored array is stable across saves.
        if (!chosen.includes(entry)) chosen.push(entry);
      }
      if (chosen.length === 0) return CLEAR;
      const ordered = definition.options
        .map((option) => option.key)
        .filter((key) => chosen.includes(key));
      return setTo(ordered);
    }

    case "url": {
      if (!asked) return SKIP;
      if (single === null) return CLEAR;
      // REUSED, NOT REWRITTEN. lib/crm/urls.ts's normaliseWebsite() is the
      // write-side protocol allowlist Task 4 already built for
      // companies.website and venues.website: it upgrades a bare host to
      // https://, refuses anything that is not http(s) -- javascript:, data:,
      // vbscript: -- and caps the length. A second implementation here would
      // be a second thing to keep in step with safeHref() on the render side.
      const normalised = normaliseWebsite(single);
      if (!normalised.ok) return { ok: false, message: normalised.message };
      // `normaliseWebsite` returns `value: null` for an input it reads as
      // empty. `single` is already non-null here, so this is unreachable
      // today -- it is written out rather than cast away because `CLEAR` is
      // the honest answer if that ever changes, and a cast would make the
      // next reader trust a `string` that is typed `string | null`.
      if (normalised.value === null) return CLEAR;
      return setTo(normalised.value);
    }
  }
}

/**
 * The whole panel's submission, turned into the RPC's payload.
 *
 * ===========================================================================
 * PURE, AND EXPORTED, BECAUSE "skip IS OMITTED" IS THE CLAIM THAT NEEDED A TEST
 * ===========================================================================
 * The Server Action used to build this inline, which made the one thing worth
 * asserting -- that a field the form did not carry never reaches the RPC --
 * unprovable without driving a Server Action, which `tests/unit` cannot do (it
 * is pure functions only, by the vitest config's own rule). Two unit tests were
 * named after that behaviour and asserted something else entirely.
 *
 * Here it is a function over a `FormData` and a definition list, so
 * tests/unit/crm/custom-fields.test.ts can assert the payload's KEYS directly:
 * a skipped field has no key, a cleared one has a `null`, and a set one has its
 * JSON value. The RPC's half -- that a key it is not given is left untouched --
 * is asserted in rls_phase2_crm.sql § V against the deployed function.
 *
 * AN EXHAUSTIVE SWITCH WITH NO `default`, for the reason lib/crm/actions.ts's
 * `failureState` has one: a fourth outcome added later is a compile error here
 * rather than a value silently dropped from the payload. `pnpm typecheck` is
 * what runs it.
 */
export function buildCustomFieldPayload(
  definitions: readonly CustomFieldDefinition[],
  formData: FormData,
):
  | {
      readonly ok: true;
      /** Field id -> the value to store, or `null` meaning CLEAR. */
      readonly payload: Record<string, CustomFieldJson | null>;
    }
  | { readonly ok: false; readonly fieldErrors: Record<string, string> } {
  const payload: Record<string, CustomFieldJson | null> = {};
  const fieldErrors: Record<string, string> = {};

  for (const definition of definitions) {
    const read = readCustomFieldValue(definition, formData);
    if (!read.ok) {
      fieldErrors[customFieldInputName(definition.id)] = read.message;
      continue;
    }
    switch (read.outcome) {
      case "set":
        payload[definition.id] = read.value;
        break;
      case "clear":
        // JSON null IS THE CLEAR INSTRUCTION. A transport verb, never stored --
        // see set_custom_field_values()'s header for the SQL-NULL-versus-
        // JSON-null contract this implements.
        payload[definition.id] = null;
        break;
      case "skip":
        // NO KEY AT ALL. The RPC deletes only the ids it is given a null for
        // and upserts only the ids it is given a value for, so an absent key
        // leaves whatever is stored exactly where it is.
        break;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, payload };
}

/** `field()` from lib/forms.ts, inlined so this module imports no server code. */
function readTrimmed(formData: FormData, name: string): string | null {
  const raw = formData.get(name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The calendar check from lib/crm/validate.ts's checkDate(), as a sentence. */
function checkCalendarDate(value: string): string | null {
  const bad = "Enter a real date.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return bad;
  }
  if (y < 1900 || y > 2200) return bad;
  return null;
}

// ---------------------------------------------------------------------------
// Classification: stored jsonb -> what to render
// ---------------------------------------------------------------------------

/**
 * What one stored value is, from the renderer's point of view.
 *
 * ===========================================================================
 * "invalid" IS A REAL STATE THAT WILL OCCUR, NOT A DEFENSIVE BRANCH
 * ===========================================================================
 * Two ordinary operations produce it and neither can be prevented:
 *
 *   1. CHANGING A DEFINITION'S field_type WHILE VALUES EXIST. Task 5 ALLOWS
 *      this rather than forbidding it (see the module's own decision note in
 *      lib/crm/custom-field-actions.ts): a field created with the wrong type
 *      is the same defect as a field created with the wrong key, and the
 *      soft-delete this task adds exists precisely because that defect must be
 *      correctable. Forbidding the change would also not remove this state --
 *      see (2) -- so it would buy a restriction and no simplification.
 *   2. REMOVING AN OPTION a stored single_select/multi_select still names.
 *      There is no way to forbid that without forbidding option edits.
 *
 * Both are rendered as the stored text, inert, with a visible "needs fixing"
 * note and the raw value shown so the user can see what to re-enter. Nothing
 * crashes and nothing is silently rewritten. A migration of stored values was
 * considered and rejected: "text 12x" becoming a number has no correct answer,
 * and guessing one loses what somebody typed with no undo and no audit row.
 *
 * ===========================================================================
 * SQL NULL AND JSON null BOTH ARRIVE AS `null`, MEASURED
 * ===========================================================================
 * `select row_to_json(t) from (select null::jsonb a, 'null'::jsonb b) t` is
 * `{"a":null,"b":null}` on this stack, so PostgREST cannot distinguish them
 * and neither can this function. Both mean "no usable value" to a reader, so
 * both are `empty`. They stay distinct IN THE DATABASE, where a round trip
 * never converts one into the other because the write path stores NEITHER --
 * clearing deletes the row. rls_phase2_crm.sql § V plants one of each and
 * asserts they survive a save unchanged.
 */
export type CustomFieldCellState = "empty" | "valid" | "invalid";

export interface CustomFieldCell {
  readonly definition: CustomFieldDefinition;
  readonly state: CustomFieldCellState;
  /** A valid value, rendered for a human. "" when empty or invalid. */
  readonly display: string;
  /** Selected option LABELS, for the two select types. */
  readonly chips: readonly string[];
  /**
   * For a `url` field only: `safeHref()`'s answer, or null.
   *
   * NULL IS THE COMMON, CORRECT ANSWER for anything that is not an absolute
   * http(s) URL, and a stored `javascript:` -- from an import, a merge, or a
   * direct PostgREST call that never met normaliseWebsite() -- lands here as
   * null and is rendered as inert text. That is the render-side half of the
   * protocol rule, identical to what venues.website already does.
   */
  readonly href: string | null;
  /** What to prefill a text-shaped control with. "" for empty or invalid. */
  readonly inputValue: string;
  /** Which option keys to tick. Empty for empty or invalid. */
  readonly inputKeys: readonly string[];
  /** Whether to tick a boolean's box. */
  readonly inputChecked: boolean;
  /** One sentence, only when `state === "invalid"`. */
  readonly problem: string | null;
  /** The stored value verbatim, so an invalid one can be shown and fixed. */
  readonly rawText: string;
}

const EMPTY_CELL = {
  state: "empty" as const,
  display: "",
  chips: [] as readonly string[],
  href: null,
  inputValue: "",
  inputKeys: [] as readonly string[],
  inputChecked: false,
  problem: null,
  rawText: "",
};

export function describeCustomFieldValue(
  definition: CustomFieldDefinition,
  raw: unknown,
): CustomFieldCell {
  if (raw === null || raw === undefined) {
    return { definition, ...EMPTY_CELL };
  }

  const rawText = renderRaw(raw);
  const invalid = (problem: string): CustomFieldCell => ({
    definition,
    ...EMPTY_CELL,
    state: "invalid",
    problem,
    rawText,
  });

  switch (definition.fieldType) {
    case "text":
      if (typeof raw !== "string") return invalid(MISMATCH);
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: raw,
        inputValue: raw,
        rawText,
      };

    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) return invalid(MISMATCH);
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        // DESIGN.md § Numerals: grouped, and rendered with tabular figures by
        // whatever displays it.
        display: raw.toLocaleString("en-GB", { maximumFractionDigits: 10 }),
        inputValue: String(raw),
        rawText,
      };

    case "date":
      if (typeof raw !== "string" || checkCalendarDate(raw) !== null) {
        return invalid(MISMATCH);
      }
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: formatCalendarDate(raw),
        inputValue: raw,
        rawText,
      };

    case "boolean":
      if (typeof raw !== "boolean") return invalid(MISMATCH);
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: raw ? "Yes" : "No",
        inputChecked: raw,
        rawText,
      };

    case "single_select": {
      if (typeof raw !== "string") return invalid(MISMATCH);
      const option = definition.options.find((entry) => entry.key === raw);
      if (!option) return invalid(REMOVED_OPTION);
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: option.label,
        chips: [option.label],
        inputValue: option.key,
        inputKeys: [option.key],
        rawText,
      };
    }

    case "multi_select": {
      if (!Array.isArray(raw)) return invalid(MISMATCH);
      const labels: string[] = [];
      const keys: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string") return invalid(MISMATCH);
        const option = definition.options.find((candidate) => candidate.key === entry);
        if (!option) return invalid(REMOVED_OPTION);
        labels.push(option.label);
        keys.push(option.key);
      }
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: labels.join(", "),
        chips: labels,
        inputKeys: keys,
        rawText,
      };
    }

    case "url":
      if (typeof raw !== "string") return invalid(MISMATCH);
      return {
        definition,
        ...EMPTY_CELL,
        state: "valid",
        display: raw,
        // Never `raw`. safeHref() returns the URL parser's normalised output
        // for http(s) only, and null for everything else -- which the renderer
        // shows as plain text.
        href: safeHref(raw),
        inputValue: raw,
        rawText,
      };
  }
}

const MISMATCH =
  "This value was saved when the field had a different type, so it can’t be shown properly. Enter it again to replace it.";

const REMOVED_OPTION =
  "This value is a choice that has since been removed from the field. Pick a current one to replace it.";

/** The stored jsonb as text, for the "needs fixing" line. Never linkified. */
function renderRaw(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? "";
  } catch {
    return "";
  }
}

/**
 * A calendar date for a UK reader.
 *
 * Formatted from the PARTS, never from `new Date(iso)`. The latter parses
 * `2026-03-03` as UTC midnight, and rendering that in Europe/London during BST
 * is how the 3rd becomes the 2nd -- the same trap lib/crm/validate.ts's
 * checkDate() documents, one layer up.
 */
function formatCalendarDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

