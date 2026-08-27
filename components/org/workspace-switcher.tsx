import { switchWorkspaceAction } from "@/lib/org/workspace-actions";
import { Button } from "@/components/ui/button";
import type { CurrentOrg, Membership } from "@/lib/auth";

// The workspace switcher.
//
// WIDGET CHOICE: a native <select>, not a custom listbox. Task 10's pre-merge
// gate names "the workspace switcher dropdown" as the example of a custom
// widget that needs full ARIA role/state wiring and real listbox keyboard
// behaviour -- but that requirement is about a component that reinvents
// listbox semantics in a <div>. A real <select> already IS a listbox: correct
// role, aria-expanded and the activedescendant-equivalent state are the
// browser's job, and arrow keys, Home/End, Escape-to-close-without-changing-
// value, and type-ahead are all implemented natively and exercised daily by
// every screen reader's own <select> support. Reimplementing any of that in a
// <div> with onClick handlers would throw away behaviour that is already
// correct to ship a worse, hand-rolled version of it -- exactly the case the
// brief calls out as a legitimate reason to prefer the native control.
//
// NOT AUTO-SUBMITTED ON CHANGE. WCAG 2.2 SC 3.2.2 (On Input) treats a form
// control that changes context (here: navigates to another workspace) purely
// as a side effect of its value changing, with no other way to trigger it, as
// a failure -- arrowing through options with a screen reader, or even just
// exploring them with a mouse before deciding, would otherwise fire a
// navigation the user never asked for. The visible "Switch" button is the
// sanctioned trigger; selecting an option alone never navigates. This also
// means the whole component needs no client-side JavaScript at all -- see
// lib/auth/actions.ts's file header for why a plain <form action={...}> is
// this codebase's default for anything that changes what the user sees.
//
// A single-org user is never shown this at all -- see app/(app)/layout.tsx,
// which renders their workspace name as plain text instead. A switcher with
// exactly one option is not a control, it is a label pretending to be one.
export function WorkspaceSwitcher({
  current,
  memberships,
}: {
  current: CurrentOrg;
  memberships: Membership[];
}) {
  // ALPHABETICAL, NOT THE QUERY'S ORDER (Task 10 gate).
  //
  // getMemberships() returns `invited_at DESC` -- newest membership first --
  // which is the right default for the /invites list it also feeds ("what
  // arrived most recently"), but it is meaningless as a PICKER order: the
  // position of a workspace in this list would change every time the user is
  // invited to another one, so the item they reach for keeps moving. A
  // picker's order should be stable and predictable, and for names the
  // predictable order is alphabetical -- it also makes the native <select>'s
  // built-in type-ahead (press "n" to jump) land somewhere sensible instead
  // of cycling through an arbitrary sequence.
  //
  // Sorted HERE rather than in getMemberships() on purpose: this is a
  // presentation choice belonging to this one control, and changing the
  // shared query would silently re-order the invitations list and the
  // "Your other workspaces" list too, neither of which asked for it.
  //
  // en-GB collation with numeric:true so "Studio 2" sorts before "Studio 10"
  // rather than after it, and accented names sort where a UK reader expects.
  const options = [...memberships].sort((a, b) =>
    a.organisation.name.localeCompare(b.organisation.name, "en-GB", {
      numeric: true,
      sensitivity: "base",
    }),
  );

  return (
    <form action={switchWorkspaceAction} className="flex items-center gap-2">
      {/*
        `sr-only` (not `hidden`/display:none) below the `sm` breakpoint: a
        display:none label is removed from the accessibility tree, and
        accessible-name computation from a display:none <label> is
        inconsistent across browser/AT combinations -- unlike sr-only, which
        keeps the element in the tree (just visually clipped), the same
        technique components/ui/skip-link.tsx uses. That alone would already
        give the <select> a reliable accessible name at every width via the
        <label for>. The redundant aria-label on the <select> is a second,
        belt-and-braces floor: it wins over the <label> association per the
        accessible-name computation spec, so it does not create a doubled or
        conflicting name -- it makes the association robust even against a
        future markup change that breaks the htmlFor/id link between them.
      */}
      <label htmlFor="workspace-switcher" className="sr-only text-sm text-ink-muted sm:not-sr-only sm:inline">
        Workspace
      </label>
      <select
        id="workspace-switcher"
        name="organisationId"
        defaultValue={current.id}
        aria-label="Workspace"
        className={
          "h-11 min-w-0 max-w-40 truncate border bg-surface px-3 text-base text-ink " +
          "border-rule hover:border-ink focus:border-accent " +
          "transition-colors duration-[var(--dur-fast)] ease-brand"
        }
      >
        {options.map((m) => (
          <option key={m.organisationId} value={m.organisationId}>
            {m.organisation.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary">
        Switch
      </Button>
    </form>
  );
}
