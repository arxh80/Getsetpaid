import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { staticSecurityHeaders } from "@/lib/security/headers";

// Phase 10 Task 7 (G12): Next refuses a Server Action whose Origin does not
// match the Host, unless the origin is in serverActions.allowedOrigins. That
// list is the one config line that would switch the CSRF check off for a
// host, so it must stay absent or empty. tests/e2e/csrf.spec.ts proves the
// refusal itself in a browser.
//
// MUTANT (2026-10-24): allowedOrigins: ["evil.example"] -> red.

describe("next.config.ts (G12)", () => {
  it("declares no serverActions.allowedOrigins", () => {
    const origins = nextConfig.experimental?.serverActions?.allowedOrigins;
    expect(origins ?? []).toEqual([]);
  });

  it("sends the static security headers on every path (G17: X-Frame-Options, nosniff, HSTS)", async () => {
    expect(await nextConfig.headers!()).toEqual([
      { source: "/:path*", headers: staticSecurityHeaders() },
    ]);
  });

  it("still configures serverActions (the read above is looking at the real block)", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBeDefined();
  });
});
