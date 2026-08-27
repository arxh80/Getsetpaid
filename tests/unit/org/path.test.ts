// Unit tests for lib/org/path.ts's firstPathSegment() -- the pure helper
// app/(app)/layout.tsx uses to find a candidate org slug from the raw request
// path, since a parent layout receives no dynamic params for a child route's
// [orgSlug] segment. Deliberately dumb: it does not know or care which
// segments are real org slugs versus reserved routes like /invites -- that
// distinction is left entirely to getCurrentOrg()'s own RLS-gated lookup, so
// there is nothing about "reserved words" for this function to get right or
// wrong.
import { describe, expect, it } from "vitest";
import { firstPathSegment } from "@/lib/org/path";

describe("firstPathSegment", () => {
  it("returns the first segment of an org-scoped path", () => {
    expect(firstPathSegment("/acme-events")).toBe("acme-events");
  });

  it("returns the first segment even when the path continues further", () => {
    expect(firstPathSegment("/acme-events/members")).toBe("acme-events");
  });

  it("strips a query string before splitting", () => {
    expect(firstPathSegment("/acme-events/members?welcome=1")).toBe("acme-events");
  });

  it("strips a fragment before splitting", () => {
    expect(firstPathSegment("/acme-events#section")).toBe("acme-events");
  });

  it("returns null for the root path", () => {
    expect(firstPathSegment("/")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(firstPathSegment("")).toBeNull();
  });

  it("returns the segment for a reserved non-org route -- distinguishing them is NOT this function's job", () => {
    expect(firstPathSegment("/invites")).toBe("invites");
    expect(firstPathSegment("/onboarding")).toBe("onboarding");
  });
});
