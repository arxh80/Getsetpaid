"use client";

import { useActionState, useState } from "react";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { createNetworkLinkAction } from "@/lib/network/links";
import { searchNetworkDirectoryForLinkAction } from "@/lib/network/link-search";
import { EMPTY_LINK_PICKER_SEARCH_STATE } from "@/lib/network/link-search-state";
import { NETWORK_ENTITY_KIND_LABELS, type NetworkEntityKind } from "@/lib/network/fields";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Task 4 / Gap B (Q73): link one of this organisation's own private records
// to a network profile it found in discovery -- explicitly, one at a time,
// never suggested.
//
// ===========================================================================
// THE REFUSAL, STATED HERE BECAUSE IT IS THE DESIGN DECISION, NOT AN OMISSION
// ===========================================================================
// The brief, verbatim: "No ranking by similarity, no search term pre-filled
// from the record, no 'suggested match' section -- the search box starts
// empty and the user types." This component takes NO PROP carrying the
// private record's own name, city, website or any other field it could have
// used to pre-fill the search or to score a candidate -- only `entityType`
// and `entityId`, which are the link's TARGET identifiers and never touch the
// search box. The search input's `defaultValue` is always
// `searchState.query`, which starts at `""` (`EMPTY_LINK_PICKER_SEARCH_STATE`)
// and is set ONLY by what the user typed and submitted -- never by a prop.
// Results render ONLY after a real search (`searchState.query !== ""`); there
// is no default candidate list, ranked or otherwise.
//
// This is a design decision this codebase could easily reach for by copying
// lib/crm/dedup.ts's fuzzy-match machinery, and the reason it does not: Q73
// treats "suggest a link" as a step toward silently merging a private record
// with a network identity, which is a materially bigger consent question than
// the exact-email auto-merge dedup already performs on CONTACTS WITHIN one
// tenant. Linking crosses a tenant boundary -- it says "this is the same
// entity as something published by an organisation I do not control" -- so it
// stays entirely opt-in and entirely manual.
//
// ===========================================================================
// SEARCH AND LINK ARE TWO SEPARATE SERVER ACTIONS, TWO SEPARATE FORMS
// ===========================================================================
// The search form posts `q` to `searchNetworkDirectoryForLinkAction`
// (lib/network/link-search.ts), which reuses Task 3's `loadNetworkDirectory`
// -- same masking view, same page-size ceiling, same ILIKE search. Each
// result row gets its OWN tiny form posting to `createNetworkLinkAction`
// (lib/network/links.ts, Task 1), so pressing "Link" on one candidate cannot
// be confused with searching for another, and a page with JavaScript disabled
// still works: both are ordinary `<form action>` posts.
export function LinkPicker({
  orgSlug,
  entityType,
  entityId,
  disabledReason,
}: {
  orgSlug: string;
  entityType: NetworkEntityKind;
  entityId: string;
  /** Non-null renders an explanation instead of the picker -- suspended,
   *  wrong tier, or the permission (getNetworkConnectionAccess). */
  disabledReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Keyboard-a11y pass: the trigger unmounts when the panel opens (and the
  // panel when it closes), so without this both transitions dropped focus to
  // <body>. Open → focus the search box (the panel's one job); close/Escape →
  // back to the trigger. See use-reveal-focus.ts.
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLInputElement,
    HTMLButtonElement
  >(open, () => setOpen(false));
  const [searchState, searchAction, searching] = useActionState(
    searchNetworkDirectoryForLinkAction,
    EMPTY_LINK_PICKER_SEARCH_STATE,
  );
  const [linkState, linkAction, linking] = useActionState(
    createNetworkLinkAction,
    EMPTY_FORM_STATE,
  );

  if (disabledReason !== null) {
    return <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>;
  }

  if (!open) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
      >
        Link to a network profile
      </Button>
    );
  }

  return (
    <div
      onKeyDown={onRevealKeyDown}
      className="flex flex-col gap-4 border border-rule bg-surface p-4"
    >
      {linkState.error ? <Alert tone="error">{linkState.error}</Alert> : null}
      {linkState.message ? <Alert tone="success">{linkState.message}</Alert> : null}

      <form action={searchAction} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <label htmlFor="link-picker-q" className="text-sm font-semibold text-ink">
            Search the network by name
          </label>
          {/* NO defaultValue OTHER THAN THE PRIOR SEARCH. Never the private
              record's own name -- see the header. */}
          <input
            ref={revealRef}
            id="link-picker-q"
            name="q"
            type="text"
            defaultValue={searchState.query}
            placeholder="Type a name…"
            className="h-11 w-full border border-rule bg-surface px-3 text-base text-ink hover:border-ink focus:border-accent"
          />
        </div>
        <Button type="submit" variant="secondary" pending={searching} pendingLabel="Searching…">
          Search
        </Button>
        <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </form>

      {searchState.error ? <Alert tone="error">{searchState.error}</Alert> : null}

      {searchState.query === "" ? null : searchState.results.length === 0 ? (
        <p className="text-base text-ink-muted">
          Nothing on the network is called “{searchState.query}”. Try a
          shorter piece of the name.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {searchState.results.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold break-words text-ink">
                  {row.displayName}
                </span>
                <span className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
                  {NETWORK_ENTITY_KIND_LABELS[row.entityKind]}
                </span>
              </span>
              <form action={linkAction}>
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <input type="hidden" name="privateEntityType" value={entityType} />
                <input type="hidden" name="privateEntityId" value={entityId} />
                <input type="hidden" name="networkProfileId" value={row.id} />
                <Button
                  type="submit"
                  variant="secondary"
                  pending={linking}
                  pendingLabel="Linking…"
                >
                  Link
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
