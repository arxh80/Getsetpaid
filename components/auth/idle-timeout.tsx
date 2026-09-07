"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ACTIVITY_WRITE_THROTTLE_MS,
  WARNING_LEAD_MS,
  activityStorageKey,
  idlePhase,
  onMountActivity,
  secondsRemaining,
  type ActivityStore,
  type IdlePhase,
} from "@/lib/auth/idle-timeout";
import { Button } from "@/components/ui/button";

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
] as const;

/**
 * Signs the user out after IDLE_TIMEOUT_MS of no mouse/keyboard/touch/scroll
 * activity ANYWHERE in this browser (localStorage is origin-scoped, not
 * per-tab -- see the storage-event listener below for why that's the point),
 * warning WARNING_LEAD_MS before it happens. Renders nothing until the
 * warning phase. See lib/auth/idle-timeout.ts for why this is real
 * enforcement rather than a cosmetic timer.
 *
 * `userId` KEYS THE STORAGE (fix round 1, Critical 1): without it, a second
 * person signing in on a shared browser inherited whatever timestamp the
 * FIRST person's session left behind. Passed down from
 * app/(app)/layout.tsx's already-resolved getCurrentUser().
 *
 * Mounted once, in app/(app)/layout.tsx, so it runs on every signed-in page.
 */
export function IdleTimeout({ userId }: { userId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<IdlePhase>("active");
  const [remaining, setRemaining] = useState(0);
  const lastWriteRef = useRef(0);
  const signingOutRef = useRef(false);
  const phaseRef = useRef<IdlePhase>("active");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const storageKey = activityStorageKey(userId);

  // Memoised (not a fresh object literal every render): this is included in
  // dependency arrays below, and an object recreated every render would
  // otherwise force those callbacks/effects to be recreated every render
  // too, for no behavioural difference -- storageKey is the only thing that
  // can actually change its behaviour.
  const store: ActivityStore = useMemo(
    () => ({
      read() {
        try {
          const raw = window.localStorage.getItem(storageKey);
          const parsed = raw ? Number(raw) : NaN;
          return Number.isFinite(parsed) ? parsed : null;
        } catch {
          // Private-browsing / storage-blocked. null -> callers treat this
          // as "no record", never as "definitely stale" or "definitely
          // fresh".
          return null;
        }
      },
      write(at) {
        try {
          window.localStorage.setItem(storageKey, String(at));
        } catch {
          // See read() -- storage being unavailable is not fatal here.
        }
      },
    }),
    [storageKey],
  );

  const clearStoredActivity = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Best-effort hygiene only -- see store.read()/write() above.
    }
  }, [storageKey]);

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    clearStoredActivity();
    const supabase = createClient();
    // 'local' clears this browser's session, same scope signOutAction uses
    // for a manual sign-out -- revokes the refresh token server-side, which
    // is what makes this ENFORCEMENT rather than a redirect over a session
    // that is still technically alive.
    await supabase.auth.signOut({ scope: "local" });
    router.push("/login?error=idle_timeout");
  }, [router, clearStoredActivity]);

  const recordActivity = useCallback(
    (now: number) => {
      store.write(now);
      lastWriteRef.current = now;
    },
    [store],
  );

  useEffect(() => {
    // Catches "was away, tab reopened/refocused" immediately on visibility/
    // focus change, rather than waiting for the next poll tick -- a
    // backgrounded tab's timers are throttled by the browser, so without
    // this a returning user could see a stale "active" state for a few
    // seconds after a genuinely expired session.
    function checkNow() {
      const last = store.read();
      // No record at all (private browsing / first-ever read raced with
      // something clearing storage) reads as "just active" rather than
      // "definitely expired" -- the mount effect below is what establishes
      // the record in the first place, so this should be rare in practice.
      const elapsed = last === null ? 0 : Date.now() - last;
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
      if (e.key === storageKey) checkNow();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") checkNow();
    }

    // FIX ROUND 1, CRITICAL 1: mounting IS activity. See
    // lib/auth/idle-timeout.ts's onMountActivity() doc comment for the exact
    // bug this replaces (the old sequence read-then-wrote-back a possibly
    // many-hours-stale value before ever checking it). This ALWAYS reports
    // "active, full window remaining" -- exactly the `useState` initial
    // values above, so there is nothing to setState here -- and writes `now`
    // to storage, never the stale value, regardless of what was on record a
    // moment ago. onMountActivity()'s return is intentionally unused: it
    // exists to make the write-not-read-back behaviour a single, unit-tested
    // function (tests/unit/auth/idle-timeout.test.ts) rather than for this
    // call site to react to.
    const mountNow = Date.now();
    onMountActivity(store, mountNow);
    lastWriteRef.current = mountNow;

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
    // store/recordActivity/signOut are all memoised and stable for a given
    // storageKey; storageKey itself only changes if the signed-in user
    // changes, which remounts this component's parent anyway -- so this
    // effect still only actually re-runs on a real user change, not on
    // every phase tick.
  }, [storageKey, store, recordActivity, signOut]);

  const staySignedIn = useCallback(() => {
    const now = Date.now();
    recordActivity(now);
    setPhase("active");
    setRemaining(0);
    // KEYBOARD FOCUS MUST GO SOMEWHERE (keyboard-a11y pass). This click
    // unmounts the whole banner, "Stay signed in" included, and a focused
    // element that unmounts drops focus to <body> — a keyboard user who
    // tabbed up here would restart the page from the top with no signal.
    // There is no "previous" position to restore (the banner appeared
    // unbidden; the user travelled to it themselves), so the least-wrong
    // target is the main landmark: reading continues from the content, the
    // same place the skip link lands. #main carries tabIndex={-1} in both
    // layouts for exactly this kind of programmatic move.
    document.getElementById("main")?.focus();
  }, [recordActivity]);

  if (phase !== "warning") return null;

  return (
    <div className="border-b border-danger bg-surface px-4 py-3">
      {/*
        THE ANNOUNCEMENT AND THE COUNTDOWN ARE DELIBERATELY TWO DIFFERENT
        NODES (Task 10 design/a11y gate).

        This previously put role="alert" on the wrapper, which made the whole
        banner -- INCLUDING the `{remaining}s` countdown -- one assertive
        live region. role="alert" implies aria-live="assertive" and
        aria-atomic="true", so every tick of the 5-second poll re-announced
        the entire sentence and INTERRUPTED whatever the screen-reader user
        was doing, roughly twelve times across the one-minute warning window.
        A user cannot read the page to resolve the warning while the warning
        talks over them; the assistive-technology experience of a 60-second
        countdown was 12 forced interruptions.

        It also carried aria-label="Session about to expire" on that same
        element. Per the accessible-name computation an aria-label WINS over
        the element's contents, so some AT announced the label in place of the
        actual message -- the user heard "session about to expire" and not the
        one thing that resolves it.

        So: the alert below is sr-only and its text is CONSTANT (it names the
        fixed warning window, not the live remainder), which means it fires
        exactly once, when the warning mounts, and never re-fires as
        `remaining` changes. The visible line keeps the live countdown for
        sighted users and is aria-hidden, because the sr-only alert already
        says the same thing and a screen reader should not meet it twice.
        The button stays outside both and is fully reachable either way.
      */}
      <p className="sr-only" role="alert">
        You have been inactive. You will be signed out in under{" "}
        {WARNING_LEAD_MS / 1000} seconds unless you do something. Use the
        &quot;Stay signed in&quot; button to stay signed in.
      </p>

      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink" aria-hidden="true">
          <span className="font-semibold text-danger">
            You’ve been inactive.
          </span>{" "}
          You’ll be signed out in{" "}
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
