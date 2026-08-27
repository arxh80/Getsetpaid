// Unit tests for the idle-timeout decision logic (components/auth/
// idle-timeout.tsx delegates to these, wired to real DOM events/localStorage/
// Supabase -- see lib/auth/idle-timeout.ts for why the split exists and why
// this needs GoTrue's own inactivity_timeout as a backstop rather than a
// substitute).
import { describe, expect, it } from "vitest";
import {
  IDLE_TIMEOUT_MS,
  WARNING_LEAD_MS,
  activityStorageKey,
  idlePhase,
  onMountActivity,
  secondsRemaining,
  type ActivityStore,
} from "@/lib/auth/idle-timeout";

describe("idlePhase", () => {
  it("is 'active' immediately after activity", () => {
    expect(idlePhase(0)).toBe("active");
  });

  it("is still 'active' right up to the warning boundary", () => {
    expect(idlePhase(IDLE_TIMEOUT_MS - WARNING_LEAD_MS - 1)).toBe("active");
  });

  it("becomes 'warning' exactly at the warning boundary", () => {
    expect(idlePhase(IDLE_TIMEOUT_MS - WARNING_LEAD_MS)).toBe("warning");
  });

  it("stays 'warning' right up to the timeout", () => {
    expect(idlePhase(IDLE_TIMEOUT_MS - 1)).toBe("warning");
  });

  it("becomes 'expired' exactly at the timeout", () => {
    expect(idlePhase(IDLE_TIMEOUT_MS)).toBe("expired");
  });

  it("stays 'expired' well past the timeout", () => {
    expect(idlePhase(IDLE_TIMEOUT_MS * 10)).toBe("expired");
  });
});

describe("secondsRemaining", () => {
  it("counts down to the timeout", () => {
    expect(secondsRemaining(IDLE_TIMEOUT_MS - 60_000)).toBe(60);
    expect(secondsRemaining(IDLE_TIMEOUT_MS - 1_000)).toBe(1);
  });

  it("never goes negative once the timeout has passed", () => {
    expect(secondsRemaining(IDLE_TIMEOUT_MS)).toBe(0);
    expect(secondsRemaining(IDLE_TIMEOUT_MS + 60_000)).toBe(0);
  });

  it("matches the product's stated 30-minute window", () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(secondsRemaining(0)).toBe(30 * 60);
  });
});

/** An ActivityStore whose read() is fixed and whose write() calls are
 * recorded, so a test can assert both WHAT was written and THAT nothing read
 * the store's stale value before writing. */
function fakeStore(staleValue: number | null): {
  store: ActivityStore;
  writes: number[];
} {
  const writes: number[] = [];
  return {
    store: {
      read: () => staleValue,
      write: (at) => writes.push(at),
    },
    writes,
  };
}

describe("onMountActivity — fix round 1, Critical 1 regression coverage", () => {
  it("writes `now`, never the stale stored value, after 14 hours idle (the exact overnight-laptop scenario reported)", () => {
    const fourteenHoursAgo = Date.now() - 14 * 3600 * 1000;
    const { store, writes } = fakeStore(fourteenHoursAgo);
    const now = Date.now();

    const result = onMountActivity(store, now);

    // THE BUG, as a failing assertion had this reverted: the original
    // component's mount effect wrote store.write(store.read()) -- i.e.
    // `writes` would have been [fourteenHoursAgo], not [now].
    expect(writes).toEqual([now]);
    expect(result.phase).toBe("active");
    expect(result.secondsRemaining).toBe(IDLE_TIMEOUT_MS / 1000);
  });

  it("writes `now` even when nothing was stored yet (a genuinely first-ever mount)", () => {
    const { store, writes } = fakeStore(null);
    const now = Date.now();

    const result = onMountActivity(store, now);

    expect(writes).toEqual([now]);
    expect(result.phase).toBe("active");
  });

  it("writes `now` even when the stored value is itself already fresh (no-op in effect, but still writes now rather than the stale read)", () => {
    const justNow = Date.now() - 1_000;
    const { store, writes } = fakeStore(justNow);
    const now = Date.now();

    onMountActivity(store, now);

    expect(writes).toEqual([now]);
  });

  it("never reads the store internally -- the whole point is that a mount's phase does not depend on whatever was there before", () => {
    let readCalls = 0;
    const store: ActivityStore = {
      read: () => {
        readCalls += 1;
        return Date.now() - 14 * 3600 * 1000;
      },
      write: () => {},
    };

    onMountActivity(store, Date.now());

    expect(readCalls).toBe(0);
  });
});

describe("activityStorageKey — fix round 1, Critical 1: storage must be per-user", () => {
  it("differs for different users", () => {
    const a = activityStorageKey("11111111-1111-1111-1111-111111111111");
    const b = activityStorageKey("22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });

  it("is stable for the same user", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    expect(activityStorageKey(userId)).toBe(activityStorageKey(userId));
  });

  it("embeds the user id, so components/auth/sign-out-button.tsx can compute the same key without importing component internals", () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    expect(activityStorageKey(userId)).toContain(userId);
  });
});
