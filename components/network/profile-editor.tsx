"use client";

import { useActionState, useState, useTransition } from "react";
import {
  updateNetworkProfileAction,
  publishNetworkProfileAction,
  unpublishNetworkProfileAction,
  setFieldVisibilityAction,
} from "@/lib/network/profiles";
import {
  EMPTY_FORM_STATE,
  groupMarkerName,
  selectedInGroup,
  type FormState,
} from "@/lib/forms";
import {
  PUBLISHABLE_FIELDS,
  PUBLISHABLE_FIELD_LABELS,
  VISIBILITY_LEVELS,
  isVisibilityLevel,
  visibilityOf,
  type FieldVisibility,
  type ProfileStatus,
  type PublishableField,
} from "@/lib/network/fields";
import { MAX_LONG_TEXT, MAX_NAME, MAX_SHORT_TEXT } from "@/lib/crm/validate";
import { PublishSummary } from "@/components/network/publish-summary";
import { VisibilityChip } from "@/components/network/visibility-chip";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The publish-field editor's Client Component half: the value inputs and,
// beside each, its visibility control -- CLAUDE.md's most consequential
// screen in the product.
//
// ===========================================================================
// THE RENDER GATE LIVES ON THE PAGE, NOT HERE (Constraint 12 / source-shape)
// ===========================================================================
// This component takes `disabled: boolean` and `disabledExplanation: string |
// null` as PROPS -- it does not compute its own opinion of whether the caller
// may write. The page (a Server Component) is the one place that calls
// `getNetworkPublishAccessForEntity(org, profile.entityKind)` -- combining the
// general network-publish gate with the M4 per-kind mirror of
// private.entity_is_manageable -- and hands the boolean down. That is the
// SAME discipline components/crm/finance-panel.tsx's header states
// (`disabled = disabledReason !== null`) and it is what
// tests/unit/network/source-shape.test.ts checks FOR: this file's JSX must be
// gated on the RESULT of that server call, never on a value this component
// could invent for itself (a role string compared client-side, a hardcoded
// `false`) -- the exact shape FOLLOW-UPS.md says the finance render gate never
// got a CI-visible guard for.
//
// ===========================================================================
// ONE <form>, BOTH HALVES OF EACH ROW, ONE UPDATE
// ===========================================================================
// The value input and the visibility ladder for a field submit TOGETHER,
// through updateNetworkProfileAction, which builds both the value columns and
// the field_visibility map from the SAME parsed request (lib/network/
// profiles.ts's `profileColumns`) -- so the two halves of a row can never
// disagree about what got saved. A field set to `hidden` and saved has its
// value NULLED by the server in the SAME statement (N3); the one-line note
// beside the ladder says so BEFORE the click, not after.
//
// ===========================================================================
// THE "HIDE NOW" QUICK ACTION IS THE NARROW SIBLING, WIRED HERE
// ===========================================================================
// lib/network/profiles.ts's setFieldVisibilityAction exists so a user who
// regrets publishing one field can retract JUST THAT ONE with a single click,
// without resubmitting six other fields' current values from a page that may
// be stale. It renders only next to a field that is currently NOT hidden --
// there is nothing to quick-hide about a field that already is -- and it is a
// SEPARATE <form>, so it can never be confused with the deliberate whole-row
// save the main form performs.
//
// ===========================================================================
// CONSTRAINT 11 AT ITS HIGHEST EXPOSURE
// ===========================================================================
// Seven independent 3-way radio groups (visibility_headline ... visibility_
// contact_email), each with its OWN `groupMarkerName` + `selectedInGroup` pair
// -- not because a radio group can be submitted with nothing checked through
// ordinary use (one option is always `defaultChecked`), but because the
// mechanism is what tells "this field's echo says hidden" from "this field
// was never on the submitted form at all", and a refusal must never let the
// second read as the first. Every group's wrapper carries a `key` built from
// the value it would render, forcing a full remount when that value changes
// after a refusal -- the same reason finance-forms.tsx keys every `<select>`:
// React's post-action form reset restores a checkbox/radio's `checked` state
// from what was true AT MOUNT, not from a freshly rendered `defaultChecked`.

const NOTE_ID = "network-editor-blocked";

/**
 * The quick-hide note's id, PER FIELD.
 *
 * FIX ROUND 1, I1. This used to be a bare module constant
 * (`"network-hide-warns"`), and `QuickHideButton` renders once per field
 * whose stored level is not `hidden` -- so with three fields published,
 * three `<p id="network-hide-warns">` elements landed in the DOM at once,
 * and EVERY "Hide … now" button's `aria-describedby` resolved to the
 * FIRST one regardless of which field it belonged to: a screen-reader user
 * pressing "Hide contact email now" was told "Hides Headline immediately
 * and deletes its published value." Axe could not see it because the
 * populated accessibility scan moved exactly one field off `hidden`, so
 * only one such element was ever on the page being scanned; the
 * source-shape census only asserted the attribute was PRESENT, never that
 * its target was unique. `tests/unit/network/source-shape.test.ts`'s
 * "every id this file renders is unique" test and
 * `tests/e2e/accessibility.spec.ts`'s two-field populated scan are both
 * now in this regression's reach.
 */
function hideNoteId(fieldName: PublishableField): string {
  return `network-hide-warns-${fieldName}`;
}

export interface ProfileFieldValues {
  displayName: string;
  headline: string;
  bio: string;
  city: string;
  region: string;
  country: string;
  website_url: string;
  contact_email: string;
  visibility: FieldVisibility;
}

const FIELD_LABEL =
  "text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase";

function inputClass(invalid: boolean): string {
  return (
    "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
    "transition-colors duration-[var(--dur-fast)] ease-brand " +
    "disabled:cursor-not-allowed disabled:opacity-55 " +
    (invalid ? "border-danger" : "border-rule hover:border-ink focus:border-accent")
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-semibold text-danger">
      {message}
    </p>
  );
}

/** One field's 3-way visibility radio ladder, plus its "Hide now" quick form. */
function VisibilityLadder({
  orgSlug,
  profileId,
  name,
  state,
  stored,
  disabled,
}: {
  orgSlug: string;
  profileId: string;
  name: PublishableField;
  state: FormState;
  stored: FieldVisibility;
  disabled: boolean;
}) {
  const groupName = `visibility_${name}`;
  const storedLevel = visibilityOf(stored, name);
  const selected = selectedInGroup(state.values, groupName, [storedLevel])[0] ?? "hidden";
  const legendId = `${groupName}-legend`;

  return (
    <fieldset
      // THE KEY REMOUNT. Forces every radio's `defaultChecked` to be
      // re-evaluated from the currently selected value rather than from
      // whatever was true when this fieldset last mounted.
      key={`${groupName}:${selected}`}
      // `disabled` ON THE FIELDSET, NOT ON EACH RADIO. A native
      // `<fieldset disabled>` disables every descendant form control by
      // itself, so the ONE element that carries `disabled` also carries the
      // `aria-describedby` naming why -- rather than three radios each
      // needing their own copy of both attributes, which is the shape
      // tests/unit/network/source-shape.test.ts's census would otherwise have
      // to special-case per radio.
      disabled={disabled}
      className="flex flex-col gap-2 border-0 p-0"
      aria-describedby={disabled ? NOTE_ID : undefined}
    >
      <legend id={legendId} className={FIELD_LABEL}>
        Who can see {PUBLISHABLE_FIELD_LABELS[name].toLowerCase()}
      </legend>
      <input type="hidden" name={groupMarkerName(groupName)} value="1" />
      <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-4">
        {VISIBILITY_LEVELS.map((level) => (
          <label
            key={level}
            className={
              "flex min-h-11 items-center gap-2 text-base text-ink " +
              (disabled ? "cursor-not-allowed opacity-55" : "")
            }
          >
            <input
              type="radio"
              name={groupName}
              value={level}
              defaultChecked={selected === level}
              className="h-4 w-4 border-rule accent-primary"
            />
            <VisibilityChip level={level} />
          </label>
        ))}
      </div>
      {selected === "network" ? (
        <p className="text-sm text-ink-muted">
          Hiding this field also deletes the published copy of it, if you save
          it as hidden.
        </p>
      ) : selected === "connections" ? (
        <p className="text-sm text-ink-muted">
          Visible only after an accepted connection. Hiding it also deletes
          the published copy, if you save it as hidden.
        </p>
      ) : null}
      {storedLevel !== "hidden" ? (
        <QuickHideButton
          orgSlug={orgSlug}
          profileId={profileId}
          fieldName={name}
          disabled={disabled}
        />
      ) : null}
    </fieldset>
  );
}

/**
 * The one-click retraction: this field only, to `hidden`, right now --
 * independent of whatever the surrounding whole-row form currently holds.
 *
 * NOT A `<form>`. It lives inside VisibilityLadder's `<fieldset>`, which
 * lives inside ProfileEditor's own `<form>` -- and HTML does not allow a
 * `<form>` to nest inside another `<form>` at all (measured in a browser,
 * Constraint 17: React logs "In HTML, <form> cannot be a descendant of
 * <form>... This will cause a hydration error" the moment this WAS one, and
 * the browser's own error-recovery parsing closes the OUTER form early,
 * which would have put every field after the first hidden Save button
 * outside the form it is meant to submit). A plain button calling the
 * SAME exported Server Action directly -- `setFieldVisibilityAction` is
 * `"use server"` and is callable as an ordinary async function, not only
 * through a `<form action>` -- inside `startTransition`, which is what makes
 * `pending` and the framework's own revalidation-on-completion behave
 * identically to the `<form>` path everywhere else in this file.
 */
function QuickHideButton({
  orgSlug,
  profileId,
  fieldName,
  disabled,
}: {
  orgSlug: string;
  profileId: string;
  fieldName: PublishableField;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hideNow = () => {
    const data = new FormData();
    data.set("orgSlug", orgSlug);
    data.set("profileId", profileId);
    data.set("fieldName", fieldName);
    data.set("level", "hidden");
    startTransition(async () => {
      const result = await setFieldVisibilityAction(EMPTY_FORM_STATE, data);
      setError(result.error ?? null);
    });
  };

  const noteId = hideNoteId(fieldName);

  return (
    <div className="flex flex-col items-start gap-1">
      <p id={noteId} className="sr-only">
        Hides {PUBLISHABLE_FIELD_LABELS[fieldName]} immediately and deletes its
        published value, without changing any other field.
      </p>
      <Button
        type="button"
        variant="quiet"
        onClick={hideNow}
        disabled={disabled}
        aria-describedby={disabled ? NOTE_ID : noteId}
        pending={pending}
        pendingLabel="Hiding…"
      >
        Hide {PUBLISHABLE_FIELD_LABELS[fieldName].toLowerCase()} now
      </Button>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

export function ProfileEditor({
  orgSlug,
  profileId,
  stored,
  disabled,
  disabledExplanation,
}: {
  orgSlug: string;
  profileId: string;
  stored: ProfileFieldValues;
  disabled: boolean;
  disabledExplanation: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    updateNetworkProfileAction,
    EMPTY_FORM_STATE,
  );

  const values: ProfileFieldValues = {
    displayName: state.values?.displayName ?? stored.displayName,
    headline: state.values?.headline ?? stored.headline,
    bio: state.values?.bio ?? stored.bio,
    city: state.values?.city ?? stored.city,
    region: state.values?.region ?? stored.region,
    country: state.values?.country ?? stored.country,
    website_url: state.values?.website_url ?? stored.website_url,
    contact_email: state.values?.contact_email ?? stored.contact_email,
    visibility: stored.visibility,
  };

  const describe = (field: string, errorId: string) =>
    state.fieldErrors?.[field] ? errorId : disabled ? NOTE_ID : undefined;

  // Live counts: the ECHOED selections when there are any (a refusal keeps
  // the reader's just-chosen ladder, so the summary above the form must count
  // THAT, not the stale stored map) -- otherwise the stored map.
  const liveVisibility: FieldVisibility = { ...stored.visibility };
  for (const name of PUBLISHABLE_FIELDS) {
    const groupName = `visibility_${name}`;
    const echoed = selectedInGroup(state.values, groupName, [
      visibilityOf(stored.visibility, name),
    ])[0];
    if (typeof echoed === "string" && isVisibilityLevel(echoed)) {
      liveVisibility[name] = echoed;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PublishSummary visibility={liveVisibility} />

      {disabled ? (
        <p
          id={NOTE_ID}
          className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted"
        >
          <span className="font-semibold text-ink">Read-only.</span>{" "}
          {disabledExplanation}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-6">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.message ? <Alert tone="success">{state.message}</Alert> : null}
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="profileId" value={profileId} />

        <div className="flex flex-col gap-2">
          <label htmlFor="displayName" className={FIELD_LABEL}>
            Name (always shown)
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            maxLength={MAX_NAME}
            disabled={disabled}
            defaultValue={values.displayName}
            aria-describedby={describe("displayName", "displayName-error")}
            aria-invalid={state.fieldErrors?.displayName ? true : undefined}
            className={inputClass(Boolean(state.fieldErrors?.displayName))}
          />
          <FieldError id="displayName-error" message={state.fieldErrors?.displayName} />
        </div>

        <ol role="list" className="flex flex-col gap-6 border-t border-rule pt-6">
          {PUBLISHABLE_FIELDS.map((name) => (
            <li key={name} className="flex flex-col gap-3 border-b border-rule pb-6">
              <div className="flex flex-col gap-2">
                <label htmlFor={name} className={FIELD_LABEL}>
                  {PUBLISHABLE_FIELD_LABELS[name]}
                </label>
                {name === "bio" ? (
                  <textarea
                    id={name}
                    name={name}
                    rows={4}
                    maxLength={MAX_LONG_TEXT}
                    disabled={disabled}
                    defaultValue={values[name]}
                    aria-describedby={describe(name, `${name}-error`)}
                    aria-invalid={state.fieldErrors?.[name] ? true : undefined}
                    className={inputClass(Boolean(state.fieldErrors?.[name]))}
                  />
                ) : (
                  <input
                    id={name}
                    name={name}
                    type={name === "contact_email" ? "email" : "text"}
                    maxLength={MAX_SHORT_TEXT}
                    disabled={disabled}
                    defaultValue={values[name]}
                    aria-describedby={describe(name, `${name}-error`)}
                    aria-invalid={state.fieldErrors?.[name] ? true : undefined}
                    className={inputClass(Boolean(state.fieldErrors?.[name]))}
                  />
                )}
                <FieldError id={`${name}-error`} message={state.fieldErrors?.[name]} />
              </div>

              <VisibilityLadder
                orgSlug={orgSlug}
                profileId={profileId}
                name={name}
                state={state}
                stored={stored.visibility}
                disabled={disabled}
              />
            </li>
          ))}
        </ol>

        <div>
          <Button
            type="submit"
            disabled={disabled}
            aria-describedby={disabled ? NOTE_ID : undefined}
            pending={pending}
            pendingLabel="Saving…"
          >
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Publish or unpublish -- a distinct, deliberate action with its own control,
 * never a side effect of the Save button above. `direction` picks the action
 * AND the copy; the two are never rendered together, because a profile is
 * either a draft or published (Q81) and only the one true action applies.
 */
export function PublishToggleForm({
  orgSlug,
  profileId,
  status,
  disabled,
  disabledExplanation,
}: {
  orgSlug: string;
  profileId: string;
  status: ProfileStatus;
  disabled: boolean;
  disabledExplanation: string | null;
}) {
  const action =
    status === "draft" ? publishNetworkProfileAction : unpublishNetworkProfileAction;
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  const noteId = "network-publish-blocked";

  return (
    <div className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      {disabled ? (
        <p id={noteId} className="max-w-prose text-sm text-ink-muted">
          {disabledExplanation}
        </p>
      ) : null}
      <form action={formAction}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="profileId" value={profileId} />
        {status === "draft" ? (
          <Button
            type="submit"
            variant="primary"
            disabled={disabled}
            aria-describedby={disabled ? noteId : undefined}
            pending={pending}
            pendingLabel="Publishing…"
          >
            Publish to the network
          </Button>
        ) : (
          <Button
            type="submit"
            variant="secondary"
            disabled={disabled}
            aria-describedby={disabled ? noteId : undefined}
            pending={pending}
            pendingLabel="Unpublishing…"
          >
            Unpublish
          </Button>
        )}
      </form>
    </div>
  );
}
