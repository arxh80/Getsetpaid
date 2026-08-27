// Unit tests for the idle-timeout decision logic (components/auth/
// idle-timeout.tsx delegates to these, wired to real DOM events/localStorage/
// Supabase -- see lib/auth/idle-timeout.ts for why the split exists and why
// this needs GoTrue's own inactivity_timeout as a backstop rather than a
// substitute).
import { describe, expect, it } from "vitest";
import {
  IDLE_TIMEOUT_MS,
  WARNING_LEAD_MS,
  idlePhase,
  secondsRemaining,
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
