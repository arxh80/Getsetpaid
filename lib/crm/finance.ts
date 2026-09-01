"use server";

// Financial entries: create, edit, soft-delete, restore. PRD § 6.7, MVP scope
// budget & actuals only (CLAUDE.md § Scope discipline).
//
// The five-step shape lib/crm/events.ts states in full, with the plumbing
// imported from lib/crm/actions.ts. Three things about it are NOT a copy of the
// CRM/events modules, and each is the reason this header exists.
//
// ===========================================================================
// 1. THE WRITE GATE IS FINANCE'S, NOT THE CRM'S
// ===========================================================================
// Every other entity module authorises through `authoriseOrg` (lib/crm/
// actions.ts), whose tier term is `crm_writes`. Finance is a Pro-only module
// gated on a DIFFERENT entitlement column (`finance_module`), so this file
// authorises through `authoriseFinance` below, which calls
// getFinanceWriteAccess (lib/crm/finance-access.ts) instead. The database
// mirror is the same split: the finance policies name
// private.finance_module_organisations(), not private.crm_write_organisations()
// (20260903003000). Using authoriseOrg here would check the wrong tier and
// disagree with the policy that actually runs.
//
// It is one of the three server-side gates a finance write must pass:
//   ROLE  manage_finance   -- the permission (authoriseFinance + RLS)
//   TIER  finance_module   -- Pro only (authoriseFinance + RLS)
//   MFA   aal2             -- folded into the permission (role_requires_mfa)
// The application gate is the friendly message; the RLS policy is the
// enforcement, made independently on every attempt from any client.
//
// ===========================================================================
// 2. NO DUPLICATE SCREENING
// ===========================================================================
// A finance line is not an identity, so it is not dedup-screened and there is
// no screenAfterCreate call or dead merge branch -- like events, and unlike the
// five Phase 2 entity modules. tests/unit/crm/source-shape.ts's
// "every create screens for duplicates" names those five files explicitly and
// not this one.
//
// ===========================================================================
// 3. THE AMOUNT IS A £ TEXT INPUT, PARSED TO MINOR UNITS
// ===========================================================================
// The column is `amount_minor bigint` (pence). The form field is pounds as a
// human types them ("1,234.56", "£500"). `parsePounds` is the pure parser:
// it rejects negatives, more than two decimal places, and any value above
// Number.MAX_SAFE_INTEGER pence (the point past which a JS number stops being
// an exact integer -- the list mapper reads amount_minor back as a number, so
// a value it could not represent must never be stored). The CHECK
// `amount_minor >= 0` is the database floor behind the negative rejection.
//
// ===========================================================================
// 4. THE LINE CARRIES CUSTOM FIELDS, WRITTEN HERE (Phase 5 Task 3)
// ===========================================================================
// `financial_entry` is the seventh custom-field entity type, running through
// the UNCHANGED Phase 2 engine (lib/crm/custom-fields.ts + set_custom_field_
// values). The one difference from the other six: a finance line has no detail
// page, so its custom-field inputs live in the finance add/edit form and are
// written HERE rather than by the generic saveCustomFieldValuesAction (which
// refuses `financial_entry` for exactly this reason). Values are validated
// BEFORE the line is written -- so a bad custom field never leaves an orphan
// line -- and written by the same set_custom_field_values RPC every other
// entity uses, whose SECURITY INVOKER policies enforce manage_finance (via
// entity_is_manageable) and the line's live-ness (via entity_is_live)
// independently on every statement.

import { revalidatePath } from "next/cache";
import { getCurrentUser, getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { liveInOrg, refusedEndState, stateFor } from "@/lib/crm/actions";
import type { RecordPresence } from "@/lib/crm/write-access";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getFinanceWriteAccess } from "@/lib/crm/finance-access";
import {
  isFinanceCategory,
  isFinanceStatus,
  type FinanceCategory,
  type FinanceStatus,
} from "@/lib/crm/finance-category";
import {
  buildCustomFieldPayload,
  type CustomFieldJson,
} from "@/lib/crm/custom-fields";
import { loadCustomFieldDefinitions } from "@/lib/crm/custom-field-queries";
import type { FieldProblem } from "@/lib/crm/validate";

/** The optional free-text label, e.g. "Headliner fee". Not a paragraph. */
const MAX_DESCRIPTION = 200;

/** Shown when a line updated but its custom-field values did not save. Safe to
 *  retry -- both the UPDATE and the set_custom_field_values RPC are idempotent. */
const FINANCE_CUSTOM_FIELDS_FAILED =
  "The line was saved, but its custom fields didn’t. Try saving again.";

/**
 * The largest amount, in pence, this application will store.
 *
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991). Above it a JS number is no
 * longer an exact integer, and lib/crm/finance-list.ts reads amount_minor back
 * as a `Number` -- so a value that could not round-trip must be refused on the
 * way in rather than silently corrupted on the way out. That is ~£90 trillion,
 * comfortably above any real festival gross and still inside bigint.
 */
const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// The finance-entry form
// ---------------------------------------------------------------------------

interface FinancialEntryValues {
  eventId: string;
  category: FinanceCategory;
  status: FinanceStatus;
  amountMinor: number;
  occurredOn: string;
  description: string | null;
  supplierContactId: string | null;
  artistId: string | null;
}

/**
 * Parse a pounds-and-pence text input to minor units.
 *
 * PURE. Strips a leading £, thousands commas and surrounding whitespace, then
 * requires a plain non-negative decimal with at most two fractional digits.
 * The minor-units value is assembled as a STRING (integer part followed by the
 * two-digit fraction) rather than by multiplying by 100, so no floating-point
 * step ever touches it; `Number.isSafeInteger` is the final ceiling.
 *
 *   ""            -> required
 *   "-5"          -> rejected (negative; the regex has no sign)
 *   "5.005"       -> rejected (more than two decimal places)
 *   "1e9"         -> rejected (not a plain decimal)
 *   "90000000000000000" -> rejected (over MAX_AMOUNT_MINOR once in pence)
 *   "1,234.5"     -> 123450
 */
function parsePounds(
  raw: string | null,
):
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly message: string } {
  if (raw === null) {
    return { ok: false, message: "Enter an amount." };
  }
  const cleaned = raw.replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      message:
        "Enter an amount in pounds — digits only, up to two decimal places, no minus sign.",
    };
  }
  const [intPart, fracPart = ""] = cleaned.split(".");
  const frac = (fracPart + "00").slice(0, 2);
  // Digits of the minor-units value, leading zeros trimmed (but not to empty).
  const minorDigits = (intPart + frac).replace(/^0+(?=\d)/, "");
  const minor = Number(minorDigits);
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) {
    return { ok: false, message: "That amount is too large." };
  }
  return { ok: true, minor };
}

/**
 * Is this a real calendar date in YYYY-MM-DD form?
 *
 * PURE. The column is `date`, and PostgREST accepts the ISO calendar-date
 * string as-is (no timezone question -- a finance line is filed against a day,
 * not an instant, so there is no Europe/London wall-clock conversion the way
 * events.starts_at needs one). Rejects "2026-02-31" by round-tripping through
 * Date and checking the parts survive.
 */
function isValidDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Read and validate the finance form.
 *
 * PURE, AND IT DOES NOT TOUCH THE DATABASE. The three checks that need a query
 * -- is the event live, is the supplier contact live, is the artist live -- are
 * the caller's, because they need a client and because their refusals are
 * `refusedEndState`'s sentences rather than field errors.
 */
function readFinancialEntry(
  formData: FormData,
):
  | { readonly ok: true; readonly values: FinancialEntryValues }
  | { readonly ok: false; readonly state: FormState } {
  const category = field(formData, "category");
  const status = field(formData, "status");
  const occurredOn = field(formData, "occurredOn");
  const description = field(formData, "description");
  const supplierContactId = field(formData, "supplierContactId");
  const artistId = field(formData, "artistId");

  const problems: (FieldProblem | null)[] = [];

  // The two vocabularies. A value outside either set is a 23514 at write time
  // for every writer including one that reaches PostgREST directly; this is
  // the sentence, the CHECK is the control.
  if (!isFinanceCategory(category)) {
    problems.push({ field: "category", message: "Choose a category from the list." });
  }
  if (!isFinanceStatus(status)) {
    problems.push({ field: "status", message: "Choose a status from the list." });
  }

  const amount = parsePounds(field(formData, "amount"));
  if (!amount.ok) {
    problems.push({ field: "amount", message: amount.message });
  }

  // occurred_on is NOT NULL with a `current_date` default, but the form always
  // sends one (a date <input>), so a missing or malformed value is a real
  // error rather than a fall-through to the default.
  if (occurredOn === null) {
    problems.push({ field: "occurredOn", message: "Give the line a date." });
  } else if (!isValidDate(occurredOn)) {
    problems.push({ field: "occurredOn", message: "That doesn’t look like a date." });
  }

  if (description !== null && description.length > MAX_DESCRIPTION) {
    problems.push({
      field: "description",
      message: `That description is too long — ${MAX_DESCRIPTION} characters at most.`,
    });
  }

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) {
      fieldErrors[problem.field] = problem.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return {
    ok: true,
    values: {
      // event_id is a hidden field carrying the event the finance panel is on;
      // its presence is checked in the actions (a missing one is structural,
      // not a form the user can fix), and its liveness is an end-check there.
      eventId: field(formData, "eventId") as string,
      category: category as FinanceCategory,
      status: status as FinanceStatus,
      amountMinor: (amount as { ok: true; minor: number }).minor,
      occurredOn: occurredOn as string,
      description,
      supplierContactId,
      artistId,
    },
  };
}

/**
 * Resolve the organisation and check FINANCE write access in one step.
 *
 * The finance analogue of lib/crm/actions.ts's authoriseOrg: same shape, same
 * verbatim-explanation discipline, but through getFinanceWriteAccess (the
 * finance_module tier term) rather than getCrmWriteAccess (crm_writes). Kept
 * local rather than parameterising authoriseOrg, because the CRM helper's tier
 * check is wired to one specific entitlement and finance is the one surface
 * that gates on a different one.
 *
 * EVERY REFUSAL CARRIES THE SUBMITTED VALUES BACK: React 19 resets the form
 * after the action, so a refusal that returns no `values` throws away what the
 * user typed (lib/crm/actions.ts states the measurement).
 */
async function authoriseFinance(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };

  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * The ends a finance write must check: the parent event (required, must be
 * live and same-tenant) and the optional supplier contact / artist links.
 *
 * The event end mirrors the parent check the INSERT/UPDATE policies make
 * (`e.deleted_at is null`, same tenant) with a sentence the user can act on;
 * the composite FKs are the tenant control behind all three. A soft-deleted
 * supplier contact or artist is refused HERE and by nothing in the database --
 * the set-null FKs do not care about deleted_at -- the same division of labour
 * events.ts documents for its venue end.
 */
async function financeEnds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  values: FinancialEntryValues,
): Promise<RecordPresence[]> {
  const ends: RecordPresence[] = [];
  ends.push(await liveInOrg(supabase, "events", organisationId, values.eventId));
  if (values.supplierContactId !== null) {
    ends.push(await liveInOrg(supabase, "contacts", organisationId, values.supplierContactId));
  }
  if (values.artistId !== null) {
    ends.push(await liveInOrg(supabase, "artists", organisationId, values.artistId));
  }
  return ends;
}

// ---------------------------------------------------------------------------
// Custom fields on the line -- the seventh custom-field entity type
// ---------------------------------------------------------------------------

/** field id -> value, or `null` meaning CLEAR. The RPC's payload shape. */
type CustomFieldPayload = Record<string, CustomFieldJson | null>;

/**
 * Read and validate the line's custom-field inputs, BEFORE the line is written.
 *
 * Front-loaded on purpose: a bad custom field (a mistyped number, an unknown
 * select option) is a field error the user can fix, and validating it before
 * the INSERT means a rejected value never leaves an orphan finance line behind.
 * Reuses the exact Phase 2 helpers -- loadCustomFieldDefinitions for the live
 * `financial_entry` fields and buildCustomFieldPayload for the parse -- so
 * there is no second copy of the validation the generic panel already has. An
 * org with no finance custom fields gets an empty payload and this costs one
 * definitions query returning nothing.
 */
async function readFinanceCustomFields(
  organisationId: string,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly payload: CustomFieldPayload }
  | { readonly ok: false; readonly state: FormState }
> {
  const definitions = await loadCustomFieldDefinitions(
    organisationId,
    "financial_entry",
  );
  if (definitions.outcome === "unavailable") {
    return { ok: false, state: { error: FAILED_MESSAGE, values: echoedValues(formData) } };
  }
  const built = buildCustomFieldPayload(definitions.definitions, formData);
  if (!built.ok) {
    // Keyed by the `cf_<id>` input name, which the finance form's reused
    // CustomFieldControl renders its error beside.
    return { ok: false, state: { fieldErrors: built.fieldErrors, values: echoedValues(formData) } };
  }
  return { ok: true, payload: built.payload };
}

/**
 * Write the validated custom-field payload against a saved line, in one RPC.
 *
 * The SAME set_custom_field_values every entity uses: SECURITY INVOKER, so all
 * three custom_field_values write policies decide every statement -- the
 * manage_finance term (entity_is_manageable) and the line-live term
 * (entity_is_live) both run here, independently of the finance-line write that
 * preceded it. Skips the round trip entirely when there is nothing to write.
 * Returns the RPC's error (null on success) for the caller to act on; it does
 * NOT decide what a failure means, because create and update differ (see their
 * call sites).
 */
async function writeFinanceCustomFields(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  entryId: string,
  payload: CustomFieldPayload,
): Promise<{ readonly failed: boolean }> {
  if (Object.keys(payload).length === 0) return { failed: false };
  const { error } = await supabase.rpc("set_custom_field_values", {
    p_organisation_id: organisationId,
    p_entity_type: "financial_entry",
    p_entity_id: entryId,
    p_values: payload,
  });
  if (error) {
    console.error(
      `[crm] set custom field values on financial_entry ${entryId} failed:`,
      error.message,
    );
    return { failed: true };
  }
  return { failed: false };
}

// ---------------------------------------------------------------------------
// The four actions
// ---------------------------------------------------------------------------

export async function createFinancialEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseFinance(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readFinancialEntry(formData);
  if (!parsed.ok) return parsed.state;

  // event_id is the panel's context, a hidden field: a missing one is
  // structural, not something a user can correct, so it is FAILED_MESSAGE
  // rather than a field error.
  if (!parsed.values.eventId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();

  const blocked = refusedEndState(
    await financeEnds(supabase, org.id, parsed.values),
    formData,
  );
  if (blocked) return blocked;

  // CUSTOM FIELDS VALIDATED BEFORE THE INSERT. A bad custom field is a field
  // error the user fixes; validating first means a rejected value never leaves
  // an orphan finance line.
  const customFields = await readFinanceCustomFields(org.id, formData);
  if (!customFields.ok) return customFields.state;

  // `created_by` EXPLICITLY, though the column defaults to auth.uid(): the same
  // discipline events.ts applies to owner_user_id -- a write and a policy that
  // agree only because a column default happens to match are a latent break.
  const { data, error } = await supabase
    .from("financial_entries")
    .insert({
      organisation_id: org.id,
      created_by: user.id,
      event_id: parsed.values.eventId,
      category: parsed.values.category,
      status: parsed.values.status,
      amount_minor: parsed.values.amountMinor,
      currency: "GBP",
      occurred_on: parsed.values.occurredOn,
      description: parsed.values.description,
      supplier_contact_id: parsed.values.supplierContactId,
      artist_id: parsed.values.artistId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 42501 is the RLS refusal: a role without manage_finance, a Starter-tier
    // org (the finance_module WITH CHECK), or a below-aal2 session. All three
    // are "you cannot write here", not a fault.
    if (error.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    // 23503 is the parent-event FK, reached when the liveInOrg pre-check failed
    // open on a lookup error: the event is gone or in another tenant.
    if (error.code === "23503") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[crm] create financial entry failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  // WRITE THE CUSTOM FIELDS AGAINST THE NEW LINE. On failure we LOG and still
  // report success, deliberately: the line is saved, and surfacing an error
  // here would invite a retry that creates a SECOND line (an INSERT is not
  // idempotent). The RPC is unreachable-by-refusal for the user who just
  // created this line -- they hold manage_finance and finance_module and the
  // line is live -- so a raise is a genuine fault, logged, and the fields
  // remain fillable by editing the line. UPDATE surfaces the same failure
  // because its retry is safe; CREATE cannot.
  await writeFinanceCustomFields(supabase, org.id, data.id, customFields.payload);

  revalidatePath(`/${org.slug}/events/${parsed.values.eventId}`);
  return { message: "Saved." };
}

export async function updateFinancialEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseFinance(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entryId = field(formData, "entryId");
  if (!entryId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readFinancialEntry(formData);
  if (!parsed.ok) return parsed.state;
  if (!parsed.values.eventId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();

  const blocked = refusedEndState(
    await financeEnds(supabase, org.id, parsed.values),
    formData,
  );
  if (blocked) return blocked;

  // CUSTOM FIELDS VALIDATED BEFORE THE UPDATE, same reason as create.
  const customFields = await readFinanceCustomFields(org.id, formData);
  if (!customFields.ok) return customFields.state;

  const result = await commitWrite(`update financial entry ${entryId}`, () =>
    supabase
      .from("financial_entries")
      .update(
        {
          event_id: parsed.values.eventId,
          category: parsed.values.category,
          status: parsed.values.status,
          amount_minor: parsed.values.amountMinor,
          currency: "GBP",
          occurred_on: parsed.values.occurredOn,
          description: parsed.values.description,
          supplier_contact_id: parsed.values.supplierContactId,
          artist_id: parsed.values.artistId,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", entryId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    // WRITE THE CUSTOM FIELDS ONLY ONCE THE LINE ITSELF UPDATED. Unlike create,
    // a failure here IS surfaced: an UPDATE (and the set_custom_field_values
    // RPC) is idempotent, so the user can safely retry, and telling them the
    // custom fields did not save is more honest than a silent "Saved". The RPC
    // is otherwise unreachable-by-refusal here (manage_finance + live line), so
    // a raise is a fault, already logged by the helper.
    const written = await writeFinanceCustomFields(
      supabase,
      org.id,
      entryId,
      customFields.payload,
    );
    if (written.failed) {
      return { error: FINANCE_CUSTOM_FIELDS_FAILED, values: echoedValues(formData) };
    }
    revalidatePath(`/${org.slug}/events/${parsed.values.eventId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteFinancialEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseFinance(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entryId = field(formData, "entryId");
  if (!entryId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  // The event context is a hidden field so the panel can be revalidated; a
  // missing one only costs a stale panel, so it is not fatal.
  const eventId = field(formData, "eventId");

  const supabase = await createClient();
  const result = await commitWrite(`delete financial entry ${entryId}`, () =>
    supabase
      .from("financial_entries")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", entryId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied" && eventId) {
    revalidatePath(`/${org.slug}/events/${eventId}`);
  }
  return stateFor(result, "Deleted. It is out of the finance list.", formData);
}

export async function restoreFinancialEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseFinance(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entryId = field(formData, "entryId");
  if (!entryId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  const eventId = field(formData, "eventId");

  const supabase = await createClient();
  const result = await commitWrite(`restore financial entry ${entryId}`, () =>
    supabase
      .from("financial_entries")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", entryId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied" && eventId) {
    revalidatePath(`/${org.slug}/events/${eventId}`);
  }
  return stateFor(result, "Restored. It is back in the finance list.", formData);
}
