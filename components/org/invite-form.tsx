"use client";

import { useActionState, useEffect, useRef } from "react";
import { inviteMemberAction } from "@/lib/org/actions";
import { INVITABLE_ROLES } from "@/lib/org/roles";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Invite-by-email form.
//
// It is rendered only for someone the server already confirmed holds
// 'manage_members' -- but that is a rendering decision, not the control. The
// action re-checks the permission server-side, and the INSERT is refused by
// organisation_memberships_insert_manage_members regardless. CLAUDE.md:
// "entitlements are enforced server-side -- hiding UI is not enforcement."
export function InviteForm({ orgSlug }: { orgSlug: string }) {
  const [state, formAction, pending] = useActionState(
    inviteMemberAction,
    EMPTY_FORM_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form ONLY on a confirmed success, so the next invite starts
  // empty. Keyed on `state.message` rather than on "no error", because a
  // validation failure must keep what was typed -- making someone retype an
  // email address because the role select was wrong is how you stop them
  // inviting the rest of their team.
  useEffect(() => {
    if (state.message) formRef.current?.reset();
  }, [state.message]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-5"
      noValidate
    >
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />

      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="off"
        inputMode="email"
        hint="They'll get an email inviting them to this workspace. If they already have a GetSetPaid account, it links to the one they have."
        required
        error={state.fieldErrors?.email}
      />

      <RoleSelect error={state.fieldErrors?.role} />

      <Button type="submit" pending={pending} pendingLabel="Sending…">
        Send invitation
      </Button>
    </form>
  );
}

// A native <select>. No custom listbox: the native control is keyboard
// accessible, screen-reader correct and touch-friendly on every platform for
// free, and DESIGN.md's shape rules apply to it as easily as to an input. A
// hand-rolled replacement here would be work spent recreating what the browser
// already does properly.
//
// 'owner' is absent by design -- transferring ownership is a separate, higher
// -stakes action, not a value in the invite dropdown. See INVITABLE_ROLES.
function RoleSelect({ error }: { error?: string }) {
  const id = "invite-role";
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        Role
        <span className="ml-2 font-normal text-ink-muted">Required</span>
      </label>
      <select
        id={id}
        name="role"
        defaultValue="standard_user"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={
          "h-11 w-full border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] " +
          (error ? "border-danger" : "border-rule hover:border-ink focus:border-accent")
        }
      >
        {INVITABLE_ROLES.map((role) => (
          <option key={role.key} value={role.key}>
            {role.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
