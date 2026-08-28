"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  linkCompanyAction,
  setPrimaryCompanyAction,
  unlinkCompanyAction,
} from "@/lib/crm/contacts";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The contact_companies join, edited from EITHER SIDE by the same component.
//
// ===========================================================================
// ONE COMPONENT, TWO DIRECTIONS, BECAUSE THERE IS ONE ROW
// ===========================================================================
// On a contact this lists companies; on a company it lists contacts. The row
// being created or destroyed is identical, the three Server Actions are
// identical, and the RLS policies decide access from the CONTACT in both
// directions (contact_companies_*_via_contact -- Task 1's Q5 adjudication). So
// what actually differs is two strings and which id is fixed, and that is what
// `side` carries.
//
// Writing this twice would have produced two panels that drift: the
// company-side copy would eventually stop offering "make primary", or would
// offer it with the arguments the other way round, and nothing would fail.
//
// ===========================================================================
// "PRIMARY" IS A FACT ABOUT THE CONTACT, IN BOTH DIRECTIONS
// ===========================================================================
// `is_primary` means "this is the contact's main company affiliation", and
// `contact_companies_one_primary_per_contact` is unique on `contact_id`. Read
// from a company, that is easy to mis-say as "this is our main contact", which
// it is not -- so the company-side copy says "primary for this person" rather
// than "primary", and setting it from here really does change that PERSON's
// primary company, possibly to something that is not this company at all.
//
// The control is a submit button per row rather than a radio group, because
// setting a primary is a write and a radio group implies a client-side
// selection that is not yet saved. See public.set_contact_primary_company():
// the write is two statements in one transaction and cannot be composed
// client-side from checkbox state.

export interface LinkedRecord {
  /** The contact_companies row's other end. */
  id: string;
  name: string;
  isPrimary: boolean;
  /** The linked record is soft-deleted. Shown, not hidden -- see below. */
  isDeleted: boolean;
  /** Detail page for the linked record, or null when it is deleted. */
  href: string;
}

export interface LinkOption {
  id: string;
  name: string;
}

export function ContactCompanyPanel({
  orgSlug,
  side,
  /** The fixed end: the contact's id on a contact page, the company's on a company page. */
  anchorId,
  linked,
  options,
  disabledReason,
}: {
  orgSlug: string;
  side: "contact" | "company";
  anchorId: string;
  linked: readonly LinkedRecord[];
  options: readonly LinkOption[];
  disabledReason: string | null;
}) {
  const onContact = side === "contact";
  const heading = onContact ? "Companies" : "People";
  const addLabel = onContact ? "Link a company" : "Link a person";
  const emptyLine = onContact
    ? "No companies linked yet. A contact can work at more than one — an agent at an agency who also owns a promoter company is ordinary."
    : "Nobody linked to this company yet.";

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-ink">{heading}</h2>

      {linked.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">{emptyLine}</p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {linked.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  {row.isDeleted ? (
                    // A deleted linked record is SHOWN, not hidden. Hiding it
                    // would make the contact look unaffiliated while the join
                    // row still says otherwise, and the whole point of soft
                    // delete is that restoring puts things back as they were.
                    // Not a link: the detail page of a deleted record is
                    // reachable from the restore queue, and a link here would
                    // read as "this is fine".
                    <span className="font-semibold break-words text-ink-muted">
                      {row.name}
                    </span>
                  ) : (
                    <Link
                      href={row.href}
                      className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
                    >
                      {row.name}
                    </Link>
                  )}
                  {/* THE LABEL DIFFERS BY SIDE, and the browser is why.
                      `is_primary` is unique on CONTACT_ID: it means "this is
                      the contact's main company". Rendered from a company, a
                      bare "PRIMARY" chip on two different people reads as "two
                      primary contacts for this company", which is not a thing
                      the schema can even express. Seen on S Co One with two
                      such rows before this was changed. */}
                  {row.isPrimary ? (
                    <Chip tone="primary">
                      {onContact ? "Primary" : "Primary for them"}
                    </Chip>
                  ) : null}
                  {row.isDeleted ? <Chip tone="muted">Deleted</Chip> : null}
                </span>
              </div>

              {disabledReason === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  {row.isPrimary ? null : (
                    <PrimaryButton
                      orgSlug={orgSlug}
                      contactId={onContact ? anchorId : row.id}
                      companyId={onContact ? row.id : anchorId}
                      label={onContact ? "Make primary" : "Make primary for them"}
                    />
                  )}
                  <UnlinkButton
                    orgSlug={orgSlug}
                    contactId={onContact ? anchorId : row.id}
                    companyId={onContact ? row.id : anchorId}
                    name={row.name}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {disabledReason === null ? (
        <LinkForm
          orgSlug={orgSlug}
          side={side}
          anchorId={anchorId}
          options={options}
          label={addLabel}
        />
      ) : (
        <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
      )}
    </section>
  );
}

function Chip({ tone, children }: { tone: "primary" | "muted"; children: string }) {
  // A bordered chip, no fill and no radius -- DESIGN.md. The word carries the
  // meaning; the border is decoration, so this is legible in greyscale.
  return (
    <span
      className={
        "border px-2 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase " +
        (tone === "primary"
          ? "border-accent text-ink"
          : "border-rule text-ink-muted")
      }
    >
      {children}
    </span>
  );
}

function PrimaryButton({
  orgSlug,
  contactId,
  companyId,
  label,
}: {
  orgSlug: string;
  contactId: string;
  companyId: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(
    setPrimaryCompanyAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="companyId" value={companyId} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
        {label}
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function UnlinkButton({
  orgSlug,
  contactId,
  companyId,
  name,
}: {
  orgSlug: string;
  contactId: string;
  companyId: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(
    unlinkCompanyAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="companyId" value={companyId} />
      <Button type="submit" variant="quiet" pending={pending} pendingLabel="Removing…">
        {/* The accessible name names the record. Ten "Unlink" buttons down a
            page are ten controls a screen-reader user cannot tell apart. */}
        <span aria-hidden="true">Unlink</span>
        <span className="sr-only">Unlink {name}</span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function LinkForm({
  orgSlug,
  side,
  anchorId,
  options,
  label,
}: {
  orgSlug: string;
  side: "contact" | "company";
  anchorId: string;
  options: readonly LinkOption[];
  label: string;
}) {
  const [state, formAction, pending] = useActionState(
    linkCompanyAction,
    EMPTY_FORM_STATE,
  );
  const onContact = side === "contact";
  const selectId = `link-${side}-target`;
  const errorId = `${selectId}-error`;
  const otherName = onContact ? "companyId" : "contactId";

  if (options.length === 0) {
    return (
      <p className="max-w-prose text-sm text-ink-muted">
        {onContact
          ? "There are no other companies in this workspace to link to yet."
          : "There are no other people in this workspace to link to yet."}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 border border-rule p-4">
      {/* ERRORS ONLY, NO SUCCESS ALERT, and it is a correction rather than an
          omission. The first version rendered "Done. Linked." here, and in the
          browser it STAYED on screen through every later action -- this is a
          Client Component that is not remounted by the revalidation, so its
          `useActionState` result outlives the thing it describes. A user who
          then clicked "Make primary" was still being told "Linked."
          The confirmation this action needs is the row appearing in the list
          above, which is a better one: it shows the actual new state rather
          than asserting that something happened. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input
        type="hidden"
        name={onContact ? "contactId" : "companyId"}
        value={anchorId}
      />

      <label htmlFor={selectId} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {/* A native <select>, for the reasons components/org/workspace-switcher.tsx
          sets out at length: a real select IS a listbox, with correct roles,
          keyboard model and type-ahead, in every browser and screen reader.

          THE LIST IS BOUNDED BY THE SERVER, not by this control. The page
          passes at most a page's worth of options; a workspace with thousands
          of companies needs a search-backed picker, which is a component this
          task does not have a measured design for. Named in the task report
          rather than guessed at, because an unbounded <select> is exactly the
          "no unbounded list endpoint" rule reappearing inside a form. */}
      <select
        id={selectId}
        name={otherName}
        defaultValue=""
        aria-describedby={state.fieldErrors?.[otherName] ? errorId : undefined}
        aria-invalid={state.fieldErrors?.[otherName] ? true : undefined}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (state.fieldErrors?.[otherName]
            ? "border-danger "
            : "border-rule hover:border-ink focus:border-accent")
        }
      >
        <option value="">Choose…</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      {state.fieldErrors?.[otherName] ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {state.fieldErrors[otherName]}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Linking…">
          Link
        </Button>
      </div>
    </form>
  );
}
