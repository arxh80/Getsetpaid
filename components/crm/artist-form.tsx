"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createArtistAction, updateArtistAction } from "@/lib/crm/artists";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { SOCIAL_PLATFORMS } from "@/lib/crm/urls";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit an artist. One component, two actions.
//
// ONE FORM, NOT TWO, because the fields, their validation, their order and
// their hints are identical and the only differences are the action, the
// submit label and whether an id is carried. Two files would be two places to
// add the next field to, and the second one would be forgotten.
//
// EVERY FIELD IS PRE-FILLED FROM `defaultValue`, NOT FROM CONTROLLED STATE.
// The form then works with JavaScript disabled -- a Server Action bound to a
// `<form action>` submits as an ordinary POST -- and there is no re-render per
// keystroke. React 19 RESETS a form with an `action` prop once the action
// resolves, so `shown` below is what stops a failed submit emptying the whole
// record: the action echoes the submitted values back and the reset restores
// those instead of blanks. Task 4 found that in a browser, not in review.
//
// `noValidate` matches the rest of this codebase: the browser's own bubbles
// are unstyleable, inconsistent between engines, and disappear on blur, and
// the server validates regardless.
//
// ===========================================================================
// NO GENRE PICKER AND NO COUNTRY PICKER, AND BOTH ARE THE SCHEMA'S DECISION
// ===========================================================================
// 20260827232510: "`genres` is free text -- there is no agreed genre
// vocabulary in this industry and inventing one would be a product decision",
// and `country` is "free text, not an ISO 3166 code. No screen or integration
// consumes it as a code yet". So genres are a comma-separated input like
// contact tags, and country is a plain text box. A dropdown here would be this
// task quietly making a product decision two migrations explicitly declined to
// make.

export interface ArtistFormValues {
  id?: string;
  name: string;
  genres: string;
  country: string;
  city: string;
  website: string;
  notes: string;
  socials: Record<string, string>;
}

export function ArtistForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: ArtistFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateArtistAction : createArtistAction,
    EMPTY_FORM_STATE,
  );

  // The `??` order matters: the echo wins when there is one, because it is
  // newer than the record the page loaded with. An emptied field echoes as ""
  // rather than being dropped, so clearing a field survives a failed submit as
  // cleared -- which is the half that made the checkbox-group marker necessary
  // elsewhere and that a text input gets for free.
  const shown = (name: keyof ArtistFormValues & string, fallback: string) =>
    state.values?.[name] ?? fallback;
  const shownSocial = (key: string) =>
    state.values?.[`social_${key}`] ?? values.socials[key] ?? "";

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {/* The organisation is carried as a SLUG and re-resolved server-side
          through getCurrentOrg(), which is RLS-gated -- CLAUDE.md § Tenancy
          model, "never trust a client-supplied organisation ID". */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="artistId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Name"
          name="name"
          defaultValue={shown("name", values.name)}
          autoComplete="off"
          required
          maxLength={200}
          hint="The name they are billed under. This is what every list and search matches on."
          error={state.fieldErrors?.name}
        />
        <Field
          label="Genres"
          name="genres"
          defaultValue={shown("genres", values.genres)}
          autoComplete="off"
          hint="Comma separated. Your own labels — there is no fixed genre list."
          error={state.fieldErrors?.genres}
        />
        <Field
          label="Country"
          name="country"
          defaultValue={shown("country", values.country)}
          autoComplete="off"
          maxLength={200}
          // Said out loud because it really is free text, and a hint that
          // implies a country list the product does not have is worse than
          // none.
          hint="Free text — there is no country list yet, so write it how you say it."
          error={state.fieldErrors?.country}
        />
        <Field
          label="City"
          name="city"
          defaultValue={shown("city", values.city)}
          autoComplete="off"
          maxLength={200}
          hint="Where they are based, if it matters for routing a tour."
          error={state.fieldErrors?.city}
        />
        <Field
          label="Website"
          name="website"
          type="url"
          defaultValue={shown("website", values.website)}
          autoComplete="off"
          inputMode="url"
          hint="getsetpaid.com works — it is stored as https://getsetpaid.com."
          error={state.fieldErrors?.website}
        />
        <TextAreaField
          label="Notes"
          name="notes"
          defaultValue={shown("notes", values.notes)}
          maxLength={4000}
          hint="How they like to be booked, who to talk to first, anything the next person needs. Plain text."
          error={state.fieldErrors?.notes}
        />
      </div>

      <fieldset className="flex flex-col gap-5 border border-rule p-5">
        {/* A real <fieldset>/<legend>, so a screen reader announces "Social,
            Instagram" rather than six unrelated inputs called after
            platforms. */}
        <legend className="px-2 text-sm font-semibold tracking-[0.04em] text-ink-muted uppercase">
          Social
        </legend>
        <p className="max-w-prose text-sm text-ink-muted">
          A handle or a full link. Only http:// and https:// links are stored —
          anything else is refused, here and again when the page renders it.
        </p>
        {SOCIAL_PLATFORMS.map((platform) => (
          <Field
            key={platform.key}
            label={platform.label}
            name={`social_${platform.key}`}
            defaultValue={shownSocial(platform.key)}
            autoComplete="off"
            maxLength={300}
            error={state.fieldErrors?.[`social_${platform.key}`]}
          />
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create artist"}
        </Button>
        <Link
          href={cancelHref}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
