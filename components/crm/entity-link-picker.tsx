"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addLinkAction, removeLinkAction } from "@/lib/crm/link-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { linkTargetToken, type LinkEntityType } from "@/lib/crm/links";
import type { LinkParent } from "@/lib/crm/links";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The entity-link picker + the list of what a task/meeting/note is linked to.
//
// One component edits BOTH ends of the operation: it lists the CRM records this
// task links to, removes any of them, and adds a new one -- the same "one panel,
// two directions" shape as components/crm/link-panel.tsx.
//
// ===========================================================================
// THE PICKER IS ONE NATIVE `<select>`, GROUPED BY ENTITY TYPE
// ===========================================================================
// The brief describes "a `<select>` of entity type + a typeahead of that type's
// records". With JavaScript OFF there is no cascade to keep a second `<select>`
// in step with the first, so -- exactly as the event form's room picker renders
// every room grouped by venue with `<optgroup>` and lets the server refuse a
// wrong pick -- this renders every linkable record grouped by its TYPE under an
// `<optgroup>`, and each option's value is the `type:id` token
// (`linkTargetToken`). The optgroup label IS the "entity type" half; the option
// is the record. `addLinkAction` parses the token and the DB policy validates
// the target. A native `<select>` already gives type-ahead, the listbox role and
// the keyboard model in every browser and screen reader.
//
// THE LIST IS BOUNDED BY THE SERVER (loadLinkOptions, capped at
// LINK_PANEL_LIMIT per type), not by this control -- the same "no unbounded
// list endpoint inside a form" note link-panel.tsx carries. A workspace with
// thousands of records per type needs a search-backed picker, which is a
// component this task does not have a measured design for; named in the report.
//
// THE `<select>` CARRIES A `key` (rule 11): React does not restore a
// `<select>`'s selected option on the post-action reset, so without it a
// refused add would leave the control showing a stale choice. Keyed on the
// error/success cycle, the control remounts to its placeholder after each
// submit.

const TYPE_LABEL: Record<LinkEntityType, string> = {
  company: "Companies",
  contact: "Contacts",
  agency: "Agencies",
  artist: "Artists",
  venue: "Venues",
  event: "Events",
};

const TYPE_SEGMENT: Record<LinkEntityType, string> = {
  company: "companies",
  contact: "contacts",
  agency: "agencies",
  artist: "artists",
  venue: "venues",
  event: "events",
};

const TYPE_SINGULAR: Record<LinkEntityType, string> = {
  company: "company",
  contact: "contact",
  agency: "agency",
  artist: "artist",
  venue: "venue",
  event: "event",
};

export interface LinkedEntityView {
  linkId: string;
  entityType: LinkEntityType;
  entityId: string;
  /** Null when the caller cannot read the target. */
  name: string | null;
  isDeleted: boolean;
}

/** One entity type's linkable records, already bounded by the server. */
export interface LinkOptionGroup {
  entityType: LinkEntityType;
  records: readonly { id: string; name: string }[];
}

export function EntityLinkPicker({
  orgSlug,
  parentTable,
  parentId,
  linked,
  optionGroups,
  disabledReason,
}: {
  orgSlug: string;
  parentTable: LinkParent;
  parentId: string;
  linked: readonly LinkedEntityView[];
  optionGroups: readonly LinkOptionGroup[];
  disabledReason: string | null;
}) {
  const hasOptions = optionGroups.some((g) => g.records.length > 0);

  return (
    <section className="flex flex-col gap-4 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Linked records</h2>

      {linked.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          Not linked to anything yet. Link it to the contacts, companies,
          artists, venues, agencies or events it is about.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {linked.map((row) => (
            <li
              key={row.linkId}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <TypeChip entityType={row.entityType} />
                {row.name === null ? (
                  // A target the caller cannot read: named by situation, not by
                  // record. Discloses no attribute -- the same collision every
                  // other name lookup makes.
                  <span className="text-ink-muted">A record outside your access</span>
                ) : row.isDeleted ? (
                  // A deleted target is SHOWN, not hidden, and not linked -- the
                  // link still exists and hiding the target would misrepresent it.
                  <span className="font-semibold break-words text-ink-muted">
                    {row.name} <span className="text-ink-muted">(deleted)</span>
                  </span>
                ) : (
                  <Link
                    href={`/${orgSlug}/${TYPE_SEGMENT[row.entityType]}/${row.entityId}`}
                    className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
                  >
                    {row.name}
                  </Link>
                )}
              </span>

              {disabledReason === null ? (
                <RemoveLinkButton
                  orgSlug={orgSlug}
                  parentTable={parentTable}
                  parentId={parentId}
                  linkId={row.linkId}
                  name={row.name ?? "this record"}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {disabledReason === null ? (
        hasOptions ? (
          <AddLinkForm
            orgSlug={orgSlug}
            parentTable={parentTable}
            parentId={parentId}
            optionGroups={optionGroups}
          />
        ) : (
          <p className="max-w-prose text-sm text-ink-muted">
            There are no records in this workspace to link to yet. Add a contact,
            company, artist, venue, agency or event first.
          </p>
        )
      ) : (
        <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
      )}
    </section>
  );
}

function TypeChip({ entityType }: { entityType: LinkEntityType }) {
  return (
    <span className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
      {TYPE_SINGULAR[entityType]}
    </span>
  );
}

function AddLinkForm({
  orgSlug,
  parentTable,
  parentId,
  optionGroups,
}: {
  orgSlug: string;
  parentTable: LinkParent;
  parentId: string;
  optionGroups: readonly LinkOptionGroup[];
}) {
  const [state, formAction, pending] = useActionState(addLinkAction, EMPTY_FORM_STATE);
  const selectId = "link-target";
  const errorId = `${selectId}-error`;
  const invalid = Boolean(state.fieldErrors?.target);

  return (
    <form action={formAction} className="flex flex-col gap-3 border border-rule p-4">
      {/* Errors only, no success alert -- the row appearing in the list above is
          the confirmation, and a stale "Linked." message outliving the thing it
          describes is the defect link-panel.tsx's header records. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="parentTable" value={parentTable} />
      <input type="hidden" name="parentId" value={parentId} />

      <label htmlFor={selectId} className="text-sm font-semibold text-ink">
        Link a record
      </label>
      <select
        // rule 11: remount to the placeholder after each submit, since React
        // does not restore a `<select>`'s option on the action reset.
        key={`target:${state.error ?? ""}:${state.message ?? ""}`}
        id={selectId}
        name="target"
        defaultValue=""
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid ? true : undefined}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (invalid ? "border-danger " : "border-rule hover:border-ink focus:border-accent")
        }
      >
        <option value="">Choose a record…</option>
        {optionGroups
          .filter((group) => group.records.length > 0)
          .map((group) => (
            <optgroup key={group.entityType} label={TYPE_LABEL[group.entityType]}>
              {group.records.map((record) => (
                <option
                  key={record.id}
                  value={linkTargetToken(group.entityType, record.id)}
                >
                  {record.name}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {state.fieldErrors?.target}
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

function RemoveLinkButton({
  orgSlug,
  parentTable,
  parentId,
  linkId,
  name,
}: {
  orgSlug: string;
  parentTable: LinkParent;
  parentId: string;
  linkId: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(removeLinkAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="parentTable" value={parentTable} />
      <input type="hidden" name="parentId" value={parentId} />
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" variant="quiet" pending={pending} pendingLabel="Removing…">
        <span aria-hidden="true">Unlink</span>
        <span className="sr-only">Unlink {name}</span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}
