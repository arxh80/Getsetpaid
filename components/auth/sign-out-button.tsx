"use client";

import { activityStorageKey } from "@/lib/auth/idle-timeout";
import { Button } from "@/components/ui/button";

/**
 * Fix round 1, Critical 1: the manual "Sign out" control has to clear the
 * SAME per-user idle-activity key components/auth/idle-timeout.tsx writes --
 * otherwise a stale-but-not-yet-expired timestamp survives a deliberate
 * sign-out and is still sitting in localStorage the next time ANYONE signs
 * in as this user on this browser. lib/auth/actions.ts's signOutAction is a
 * Server Action and cannot touch localStorage at all, so this is a thin
 * Client Component wrapper around the same form: the onClick handler runs
 * (clearing storage) and then the native form submission proceeds to the
 * Server Action exactly as before -- nothing about the sign-out flow itself
 * changes.
 */
export function SignOutButton({
  userId,
  action,
}: {
  userId: string;
  action: () => Promise<void>;
}) {
  return (
    <form action={action}>
      <Button
        type="submit"
        variant="quiet"
        onClick={() => {
          try {
            window.localStorage.removeItem(activityStorageKey(userId));
          } catch {
            // Best-effort hygiene only -- see idle-timeout.tsx's own
            // read()/write() for the same non-fatal-storage-error stance.
          }
        }}
      >
        Sign out
      </Button>
    </form>
  );
}
