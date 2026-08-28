"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createVenueAction, updateVenueAction } from "@/lib/crm/venues";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { SOCIAL_PLATFORMS } from "@/lib/crm/urls";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a venue. Same shape as ArtistForm.
//
// ===========================================================================
// `capacity` IS THE ONE NUMBER IN THE PHASE, AND BLANK MEANS UNKNOWN
// ===========================================================================
// `type="number"` with no `defaultValue` fallback to "0". The column is
// nullable because 20260827232510 says an unknown capacity is a real state and
// "0 would be a lie that then renders as a real number in the UI", and
// `checkCapacity` in lib/crm/validate.ts is what keeps an empty input from
// becoming `Number("") === 0` on the way through. The hint says so, because a
// user who leaves it blank should know that is a supported answer rather than
// a field they forgot.
//
// `inputMode="numeric"` alongside `type="number"`: the type gives desktop the
// stepper and the validation, the inputMode gives a phone the digit keypad
// rather than the full keyboard.
//
// ===========================================================================
// TWO ADDRESS-SHAPED FIELDS, AND THE LABELS HAVE TO DO THE WORK
// ===========================================================================
// `address` (postal) and `location` (the searchable place -- "Bristol", "South
// London") are both PRD 6.4 fields and are not duplicates of each other. Two
// adjacent inputs that look like the same question get the same answer typed
// into both, so the hints name the difference and the list column is the one
// that shows `location`.

export interface VenueFormValues {
  id?: string;
  name: string;
  address: string;
  location: string;
  capacity: string;
  website: string;
  technicalInfo: string;
  socials: Record<string, string>;
}

export function VenueForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: VenueFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateVenueAction : createVenueAction,
    EMPTY_FORM_STATE,
  );

  // React 19 resets a `<form action>` once the action resolves, so the
  // submitted values have to come back as the defaults or a failed submit
  // empties the form. The echo wins when there is one -- it is newer than the
  // record the page loaded with.
  const shown = (name: keyof VenueFormValues & string, fallback: string) =>
    state.values?.[name] ?? fallback;
  const shownSocial = (key: string) =>
    state.values?.[`social_${key}`] ?? values.socials[key] ?? "";

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="venueId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Name"
          name="name"
          defaultValue={shown("name", values.name)}
          autoComplete="off"
          required
          maxLength={200}
          hint="The venue as it is billed. This is what every list and search matches on."
          error={state.fieldErrors?.name}
        />
        <Field
          label="Location"
          name="location"
          defaultValue={shown("location", values.location)}
          autoComplete="off"
          maxLength={200}
          hint="The city or area, for finding it in a list — “Bristol”, “South London”."
          error={state.fieldErrors?.location}
        />
        <TextAreaField
          label="Address"
          name="address"
          rows={3}
          defaultValue={shown("address", values.address)}
          maxLength={4000}
          hint="The full postal address, for getting a van to the door."
          error={state.fieldErrors?.address}
        />
        <Field
          label="Capacity"
          name="capacity"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          defaultValue={shown("capacity", values.capacity)}
          autoComplete="off"
          hint="Leave it blank if you don’t know it — blank means unknown, not zero."
          error={state.fieldErrors?.capacity}
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
          label="Technical information"
          name="technicalInfo"
          defaultValue={shown("technicalInfo", values.technicalInfo)}
          maxLength={4000}
          hint="PA, rigging, load-in, power, curfew — whatever the production team asks. Plain text."
          error={state.fieldErrors?.technicalInfo}
        />
      </div>

      <fieldset className="flex flex-col gap-5 border border-rule p-5">
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
          {editing ? "Save changes" : "Create venue"}
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
