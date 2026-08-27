"use client";

import { useActionState, useState } from "react";
import { createOrganisationAction } from "@/lib/org/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

/**
 * Client-side slug suggestion. Deliberately identical in spirit to slugify()
 * in the action, but this one only ever SUGGESTS -- the server slugifies and
 * create_organisation() validates with its own regex and raises if it fails.
 * Three layers, and only the innermost one is authoritative.
 */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export function CreateOrgForm() {
  const [state, formAction, pending] = useActionState(
    createOrganisationAction,
    EMPTY_FORM_STATE,
  );

  // The slug mirrors the name until the user edits it, then stops -- editing
  // it is a clear signal they want something specific, and yanking it back on
  // the next keystroke in the name field is the kind of small betrayal that
  // makes a form feel broken.
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const effectiveSlug = slugTouched ? slug : suggestSlug(name);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <Field
        label="Organisation name"
        name="name"
        type="text"
        autoComplete="organization"
        hint="Your company, agency or venue as people would recognise it."
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={state.fieldErrors?.name}
      />

      <Field
        label="Workspace address"
        name="slug"
        type="text"
        autoComplete="off"
        spellCheck={false}
        hint={
          <>
            Used in links to your workspace:{" "}
            <span className="font-semibold text-ink">
              /{effectiveSlug || "your-workspace"}
            </span>
            . Lowercase letters, numbers and hyphens.
          </>
        }
        required
        value={effectiveSlug}
        onChange={(e) => {
          setSlugTouched(true);
          setSlug(e.target.value);
        }}
        error={state.fieldErrors?.slug}
      />

      <Button type="submit" pending={pending} pendingLabel="Creating…">
        Create organisation
      </Button>

      <p className="text-sm text-ink-muted">
        You&apos;ll be the owner. You can invite colleagues straight after.
      </p>
    </form>
  );
}
