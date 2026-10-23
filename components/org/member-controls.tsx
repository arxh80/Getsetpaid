"use client";

import { useActionState, useState } from "react";
import { changeMemberRoleAction, removeMemberAction } from "@/lib/org/actions";
import { INVITABLE_ROLES } from "@/lib/org/roles";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";

// One member row's controls: change role, and remove (or cancel an invitation).
//
// Rendered only for a caller the server confirmed holds manage_members, and
// that is a rendering decision, not the control: both actions write through
// the caller's own RLS-bound client, and the policies, the keep-an-owner
// trigger and the audit triggers decide (Phase 10 Task 21).
//
// Outcomes go to the page's <ActionOutcome> region: a successful removal
// revalidates the page into a tree without this row, which would take a
// message held here with it (components/ui/action-outcome.tsx).
//
// Remove asks first, inline, with the delete-confirmation pattern of
// components/crm/delete-restore.tsx: focus to the question on open, back to
// the trigger on "Keep" or Escape.
export function MemberControls({
  orgSlug,
  orgName,
  membershipId,
  name,
  role,
  invited,
  canGrantOwner,
}: {
  orgSlug: string;
  orgName: string;
  membershipId: string;
  /** Names the row for a screen reader: a person's name, or an invitation's role and date. */
  name: string;
  role: string;
  invited: boolean;
  /** Only an Owner may hand out Owner (Q248); the database refuses it anyway. */
  canGrantOwner: boolean;
}) {
  const reportedRemove = useReportedAction(removeMemberAction);
  const reportedChange = useReportedAction(changeMemberRoleAction);
  const [, removeAction, removing] = useActionState(reportedRemove, EMPTY_FORM_STATE);
  const [, changeAction, changing] = useActionState(reportedChange, EMPTY_FORM_STATE);
  const [asking, setAsking] = useState(false);
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLParagraphElement,
    HTMLButtonElement
  >(asking, () => setAsking(false));

  const roles = canGrantOwner
    ? [{ key: "owner", label: "Owner" }, ...INVITABLE_ROLES]
    : INVITABLE_ROLES;
  const selectId = `role-${membershipId}`;
  const verb = invited ? "Cancel invitation" : "Remove";

  if (asking) {
    return (
      <form action={removeAction} onKeyDown={onRevealKeyDown} className="flex flex-col gap-3">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <p ref={revealRef} tabIndex={-1} role="status" className="max-w-prose text-base text-ink">
          {invited
            ? `Cancel this invitation to ${orgName}? The link in their email stops working.`
            : `Remove ${name} from ${orgName}? They lose access on their next page load.`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="danger" pending={removing} pendingLabel="Removing…">
            {invited ? "Yes, cancel it" : "Yes, remove"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAsking(false)}>
            {invited ? "Keep it" : "Keep them"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Native select, as in the invite form: keyboard and screen-reader
          correct for free. No auto-submit on change -- an arrow key through
          the list must not rewrite someone's access. An invitation is
          cancelled and re-sent, not re-roled. */}
      {invited ? null : (
        <form action={changeAction} className="flex items-center gap-2">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="membershipId" value={membershipId} />
          <label htmlFor={selectId} className="sr-only">
            Role for {name}
          </label>
          <select
            id={selectId}
            name="role"
            defaultValue={role}
            className={
              "h-11 border border-rule bg-surface px-3 text-base text-ink " +
              "transition-colors duration-[var(--dur-fast)] ease-brand hover:border-ink focus:border-accent"
            }
          >
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" pending={changing} pendingLabel="Saving…">
            Save role<span className="sr-only"> for {name}</span>
          </Button>
        </form>
      )}
      <Button ref={triggerRef} type="button" variant="danger" onClick={() => setAsking(true)}>
        {verb}
        <span className="sr-only"> {name}</span>
      </Button>
    </div>
  );
}
