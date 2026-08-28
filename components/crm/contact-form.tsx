"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createContactAction, updateContactAction } from "@/lib/crm/contacts";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { SOCIAL_PLATFORMS } from "@/lib/crm/urls";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a contact. One component, two actions.
//
// ONE FORM, NOT TWO, because the fields, their validation, their order and
// their hints are identical and the only differences are the action, the
// submit label and whether an id is carried. Two files would be two places to
// add the next field to, and the second one would be forgotten -- which is the
// same argument lib/list/query.ts makes for fixing the cursor recovery in the
// query rather than in five copies of the component.
//
// EVERY FIELD IS PRE-FILLED FROM `defaultValue`, NOT FROM CONTROLLED STATE.
// An uncontrolled form keeps what the user typed across a failed submit for
// free -- `useActionState` re-renders with the same DOM nodes -- whereas a
// controlled one has to round-trip every keystroke through React to achieve
// the same thing. It also means this form works with JavaScript disabled: a
// Server Action bound to a <form action> submits as an ordinary POST.
//
// `noValidate` matches the rest of this codebase: the browser's own bubbles
// are unstyleable, inconsistent between engines, and disappear on blur, and
// the server validates regardless. See components/ui/field.tsx for the
// accessibility wiring each field gets.

export interface ContactFormValues {
  id?: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  location: string;
  website: string;
  tags: string;
  socials: Record<string, string>;
}

export function ContactForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: ContactFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateContactAction : createContactAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {/* The organisation is carried as a SLUG and re-resolved server-side
          through getCurrentOrg(), which is RLS-gated. It is not an
          organisation id and it is not trusted: CLAUDE.md § Tenancy model,
          "never trust a client-supplied organisation ID". Editing this input
          gets you a workspace you are already a member of, or nothing. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="contactId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Name"
          name="name"
          defaultValue={values.name}
          autoComplete="off"
          required
          maxLength={200}
          hint="How this person is known in the industry. This is what every list and search matches on."
          error={state.fieldErrors?.name}
        />
        <Field
          label="Role"
          name="title"
          defaultValue={values.title}
          autoComplete="off"
          maxLength={200}
          hint="Booking agent, venue manager, tour manager, driver…"
          error={state.fieldErrors?.title}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          defaultValue={values.email}
          autoComplete="off"
          inputMode="email"
          maxLength={254}
          error={state.fieldErrors?.email}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          defaultValue={values.phone}
          autoComplete="off"
          inputMode="tel"
          maxLength={40}
          // Said out loud because the validation really is this loose, and a
          // hint that promises a format the server does not enforce is worse
          // than none.
          hint="Any format. International numbers and extensions are fine."
          error={state.fieldErrors?.phone}
        />
        <Field
          label="Location"
          name="location"
          defaultValue={values.location}
          autoComplete="off"
          maxLength={200}
          hint="City or region. Free text — there is no country list yet."
          error={state.fieldErrors?.location}
        />
        <Field
          label="Website"
          name="website"
          type="url"
          defaultValue={values.website}
          autoComplete="off"
          inputMode="url"
          hint="getsetpaid.com works — it is stored as https://getsetpaid.com."
          error={state.fieldErrors?.website}
        />
        <Field
          label="Tags"
          name="tags"
          defaultValue={values.tags}
          autoComplete="off"
          hint="Comma separated. Your own labels — nothing here is a fixed list."
          error={state.fieldErrors?.tags}
        />
      </div>

      <fieldset className="flex flex-col gap-5 border border-rule p-5">
        {/* A real <fieldset>/<legend>, so a screen reader announces "Social,
            Instagram" rather than seven unrelated inputs called after
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
            defaultValue={values.socials[platform.key] ?? ""}
            autoComplete="off"
            maxLength={300}
            error={state.fieldErrors?.[`social_${platform.key}`]}
          />
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create contact"}
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
