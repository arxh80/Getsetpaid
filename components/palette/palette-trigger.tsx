"use client";

import { useSyncExternalStore } from "react";
import { PALETTE_OPEN_EVENT } from "@/lib/palette/results";

// The command palette's header trigger — a dumb dispatcher, on purpose.
//
// This renders in the app shell's header (app/(app)/layout.tsx), and the
// shell's module graph must reach no CRM query: tests/unit/list/
// app-shell-has-no-crm-query.test.ts guards the MFA-enrolment lockout a CRM
// read in the shell would cause. So this component knows nothing about the
// palette but one event name from lib/palette/results.ts (which imports
// nothing) — the palette itself, whose search action DOES reach the CRM list
// specs, mounts below the MFA gate in app/(app)/[orgSlug]/layout.tsx and
// listens for the event. When the palette is not mounted (it and this
// trigger share the same render condition in the shell), the event simply
// has no listener.
//
// Also the pointer/touch and discoverability affordance a bare hotkey lacks:
// every palette destination exists elsewhere (the rail, the list pages), so
// the palette is an accelerator, but an invisible accelerator helps only
// those who already know it exists.

function subscribeNever(): () => void {
  return () => {};
}
function readIsApplePlatform(): boolean {
  return /Mac|iPhone|iPad/.test(window.navigator.platform);
}
function serverIsApplePlatform(): boolean {
  return false;
}

export function PaletteTrigger() {
  // Same SSR-safe capability read the sidebar's hover gate uses: the server
  // cannot know the platform, so it consistently renders "Ctrl K" and the
  // client corrects to "⌘K" in its first paint on Apple hardware.
  const isApple = useSyncExternalStore(
    subscribeNever,
    readIsApplePlatform,
    serverIsApplePlatform,
  );

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={() => window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT))}
      className={
        "hidden h-11 items-center gap-2 border border-rule bg-surface px-3 " +
        "text-sm text-ink-muted transition-colors " +
        "duration-[var(--dur-fast)] ease-brand hover:border-ink hover:text-ink sm:flex"
      }
    >
      <span>Search</span>
      <kbd className="border border-rule px-1.5 py-0.5 font-mono text-xs text-ink-muted">
        {isApple ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}
