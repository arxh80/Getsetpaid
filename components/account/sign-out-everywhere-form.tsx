"use client";

import { useActionState } from "react";
import { signOutEverywhereAction } from "@/lib/auth/actions";
import { activityStorageKey } from "@/lib/auth/idle-timeout";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// Success redirects to /login, so only a failure is ever rendered here. The
// onClick clears this browser's idle-activity key, as SignOutButton does.
export function SignOutEverywhereForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(signOutEverywhereAction, EMPTY_FORM_STATE);

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite">
        {state.error ? <Alert tone="error" live={false}>{state.error}</Alert> : null}
      </div>
      <form action={formAction}>
        <Button
          type="submit"
          variant="secondary"
          pending={pending}
          pendingLabel="Signing out…"
          onClick={() => {
            try {
              window.localStorage.removeItem(activityStorageKey(userId));
            } catch {
              // Best-effort hygiene, as in components/auth/sign-out-button.tsx.
            }
          }}
        >
          Sign out everywhere
        </Button>
      </form>
    </div>
  );
}
