import { describe, expect, it } from "vitest";
import { isUnder, PUBLIC_PATHS } from "@/lib/supabase/middleware";

// ADDING /legal TO PUBLIC_PATHS MUST NOT MAKE A NEIGHBOUR PUBLIC.
//
// PUBLIC_PATHS decides which screens a signed-out request may reach without a
// bounce to /login. A prefix match written as `startsWith(root)` would make
// `/legalese`, `/legal-hold` and `/legal.json` public along with `/legal`;
// isUnder() requires the root itself or `root/`. The real-HTTP half of this is
// tests/e2e/legal.spec.ts, which requests those neighbours signed out and
// asserts the bounce.

describe("PUBLIC_PATHS and isUnder()", () => {
  it("lists /legal, and the list is otherwise what it was", () => {
    expect([...PUBLIC_PATHS]).toEqual([
      "/login",
      "/signup",
      "/magic-link",
      "/auth",
      "/api/incident-alerts",
      "/api/exports",
      "/api/erasure",
      "/api/retention",
      "/legal",
    ]);
  });

  it.each([
    "/legal",
    "/legal/",
    "/legal/privacy",
    "/legal/cookies",
    "/legal/not-a-page",
    "/api/erasure",
    "/api/erasure/run",
    "/api/retention",
    "/api/retention/run",
  ])(
    "%s is public",
    (path) => {
      expect(isUnder(path, PUBLIC_PATHS)).toBe(true);
    },
  );

  it.each([
    "/legalese",
    "/legal-hold",
    "/legal.json",
    "/legalx/privacy",
    "/super/legal",
    "/org-a/legal",
    "/",
    "/super",
    "/onboarding",
    // Phase 8 Task 5. The erasure runner's retry endpoint is public in the
    // bounce's sense; its NEIGHBOURS are not, and `/api/erasures` is one
    // character from the real thing.
    "/api/erasures",
    "/api/erasure-run",
    // Phase 8 Task 6, the same pair for the retention runner.
    "/api/retentions",
    "/api/retention-run",
  ])("%s is NOT public", (path) => {
    expect(isUnder(path, PUBLIC_PATHS)).toBe(false);
  });
});
