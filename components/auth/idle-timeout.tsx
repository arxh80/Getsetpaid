"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ACTIVITY_WRITE_THROTTLE_MS,
  idlePhase,
  secondsRemaining,
  type IdlePhase,
} from "@/lib/auth/idle-timeout";
import { Button } from "@/components/ui/button";

/**
 * localStorage, not sessionStorage or component state: activity in one tab
 * must count for every tab of this origin, and the browser's own `storage`
 * event tells the OTHER tabs when it changes (see the listener below). A
 * `sessionStorage`-based timer would sign a user out of a background tab
 * while they were actively typing in another.
 */
const STORAGE_KEY = "gsp:last-activity-at";

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
] as const;

function readLastActivity(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
  } catch {
    // Private-browsing / storage-blocked: fall back to "just active", which
    // degrades to no client-side enforcement rather than an immediate,
    // confusing sign-out on every page load.
    return Date.now();
  }
}

function writeLastActivity(at: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(at));
  } catch {
    // See readLastActivity -- storage being unavailable is not fatal here.
  }
}

/**
 * Signs the user out after IDLE_TIMEOUT_MS of no mouse/keyboard/touch/scroll
 * activity ANYWHERE in this browser (see the localStorage note above),
 * warning WARNING_LEAD_MS before it happens. Renders nothing until the
 * warning phase. See lib/auth/idle-timeout.ts for why this is real
 * enforcement rather than a cosmetic timer.
 *
 * Mounted once, in app/(app)/layout.tsx, so it runs on every signed-in page.
 */
export function IdleTimeout() {
  const router = useRouter();
  const [phase, setPhase] = useState<IdlePhase>("active");
  const [remaining, setRemaining] = useState(0);
  const lastWriteRef = useRef(0);
  const signingOutRef = useRef(false);
  const phaseRef = useRef<IdlePhase>("active");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    const supabase = createClient();
    // 'local' clears this browser's session, same scope signOutAction uses
    // for a manual sign-out -- revokes the refresh token server-side, which
    // is what makes this ENFORCEMENT rather than a redirect over a session
    // that is still technically alive.
    await supabase.auth.signOut({ scope: "local" });
    router.push("/login?error=idle_timeout");
  }, [router]);

  const recordActivity = useCallback((now: number) => {
    writeLastActivity(now);
    lastWriteRef.current = now;
  }, []);

  useEffect(() => {
    // Catches "was away, tab reopened/refocused" immediately on mount and on
    // every visibility/focus change, rather than waiting for the next poll
    // tick -- a backgrounded tab's timers are throttled by the browser, so
    // without this a returning user could see a stale "active" state for a
    // few seconds after a genuinely expired session.
    function checkNow() {
      const elapsed = Date.now() - readLastActivity();
      const next = idlePhase(elapsed);
      setPhase(next);
      setRemaining(secondsRemaining(elapsed));
      if (next === "expired") void signOut();
    }

    function onActivity() {
      const now = Date.now();
      // Throttled: an unthrottled mousemove listener would write to
      // localStorage (and fire a `storage` event in every other tab) dozens
      // of times a second.
      if (now - lastWriteRef.current >= ACTIVITY_WRITE_THROTTLE_MS) {
        recordActivity(now);
      }
      // The phase can always advance back to "active" immediately, even
      // inside the throttle window -- what's throttled is the WRITE, not the
      // UI dismissing its own warning the instant the user moves the mouse.
      if (phaseRef.current !== "active") {
        setPhase("active");
        setRemaining(0);
      }
    }

    // Another tab's activity updates OUR idea of "last activity" too, so an
    // idle tab that is not itself receiving events does not sign out from
    // under a user who is actively working in a different tab.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) checkNow();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") checkNow();
    }

    checkNow();
    recordActivity(readLastActivity());

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true });
    }
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", checkNow);

    const interval = window.setInterval(checkNow, 5_000);

    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity);
      }
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", checkNow);
      window.clearInterval(interval);
    };
    // recordActivity and signOut are stable (useCallback with stable deps);
    // running this only once keeps a single set of listeners for the whole
    // mounted lifetime instead of tearing them down on every phase change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const staySignedIn = useCallback(() => {
    const now = Date.now();
    recordActivity(now);
    setPhase("active");
    setRemaining(0);
  }, [recordActivity]);

  if (phase !== "warning") return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session about to expire"
      className="border-b border-danger bg-surface px-4 py-3"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink">
          <span className="font-semibold text-danger">
            You&apos;ve been inactive.
          </span>{" "}
          You&apos;ll be signed out in{" "}
          <span className="tabular-nums font-semibold">{remaining}s</span>{" "}
          unless you do something.
        </p>
        <Button type="button" variant="secondary" onClick={staySignedIn}>
          Stay signed in
        </Button>
      </div>
    </div>
  );
}
