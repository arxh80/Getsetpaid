import { afterEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, payPageHeaders, staticSecurityHeaders } from "@/lib/security/headers";

// Phase 10 Task 7 (G17): pin the CSP directives and the static headers, so a
// production `script-src` that gains 'unsafe-inline' or 'unsafe-eval', or a
// dropped frame-ancestors/object-src/base-uri/nosniff/HSTS, goes red.
//
// MUTANT (2026-10-24): 'unsafe-inline' added to script-src -> the production
// script-src case red. Recorded in the Task 7 ledger.

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name, values]),
  );
}

function headerMap(): Map<string, string> {
  return new Map(staticSecurityHeaders().map((h) => [h.key.toLowerCase(), h.value]));
}

function deploy(siteUrl: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
}

afterEach(() => vi.unstubAllEnvs());

describe("security headers in a production https deployment (G17)", () => {
  it("script-src carries the nonce and neither 'unsafe-inline' nor 'unsafe-eval'", () => {
    deploy("https://app.getsetpaid.example");
    const script = directives(contentSecurityPolicy("n0nce")).get("script-src");
    expect(script).toBeDefined();
    expect(script).toContain("'nonce-n0nce'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("refuses framing, plugins and <base> re-pointing, and upgrades insecure requests", () => {
    deploy("https://app.getsetpaid.example");
    const csp = directives(contentSecurityPolicy("n0nce"));
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("sends X-Frame-Options DENY, nosniff and a two-year HSTS", () => {
    deploy("https://app.getsetpaid.example");
    const h = headerMap();
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("strict-transport-security")).toMatch(/^max-age=63072000; includeSubDomains/);
  });
});

describe("over plain http", () => {
  it("omits HSTS and upgrade-insecure-requests, keeps the rest", () => {
    deploy("http://localhost:3000");
    const csp = directives(contentSecurityPolicy("n0nce"));
    const h = headerMap();
    expect(h.has("strict-transport-security")).toBe(false);
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
    // Positive control: the same builder still emits the refusals.
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(h.get("x-content-type-options")).toBe("nosniff");
  });

  it("'unsafe-eval' appears in development only", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    expect(directives(contentSecurityPolicy("n")).get("script-src")).toContain("'unsafe-eval'");
  });
});

// Invoices part 2 Task 5. Chrome enforces form-action against the whole
// redirect chain, so the pay page's POST -> 303 -> Stripe Checkout and the
// no-JS "Connect Stripe" Server Action -> Stripe OAuth are blocked unless both
// Stripe origins are named. Two origins, no wildcard, and never the fake's.
describe("form-action and the Stripe redirects", () => {
  it("names exactly the two Stripe origins beside 'self', Supabase and Google", () => {
    deploy("https://app.getsetpaid.example");
    expect(directives(contentSecurityPolicy("n")).get("form-action")).toEqual([
      "'self'",
      "https://abc.supabase.co",
      "https://accounts.google.com",
      "https://checkout.stripe.com",
      "https://connect.stripe.com",
    ]);
  });

  it("never allows the fake gateway's host or a wildcard", () => {
    deploy("https://app.getsetpaid.example");
    const form = directives(contentSecurityPolicy("n")).get("form-action")!.join(" ");
    expect(form).not.toMatch(/stripe\.test|\*/);
  });
});

describe("the /pay response headers", () => {
  it("never sends the token onward in a Referer, and is never cached", () => {
    expect(payPageHeaders()).toEqual([
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
    ]);
  });
});
