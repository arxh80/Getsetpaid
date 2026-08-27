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
  return (
    <form action={switchWorkspaceAction} className="flex items-center gap-2">
      <label
        htmlFor="workspace-switcher"
        className="hidden text-sm text-ink-muted sm:inline"
      >
        Workspace
      </label>
      <select
        id="workspace-switcher"
        name="organisationId"
        defaultValue={current.id}
        className={
          "h-11 min-w-0 max-w-40 truncate border bg-surface px-3 text-base text-ink " +
          "border-rule hover:border-ink focus:border-accent " +
          "transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]"
        }
      >
        {memberships.map((m) => (
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
