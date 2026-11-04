// safeNextPath keeps same-origin paths only. The dot-segment cases were a
// live open redirect: the raw "//" check passed, then URL() collapsed the
// path into a protocol-relative "//evil.test" that the browser sends off-site.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/redirects";

describe("safeNextPath", () => {
  it.each([
    "https://evil.test/x",
    "//evil.test/x",
    "/\\evil.test/x",
    "javascript:alert(1)",
    "/.//evil.test",
    "/a/..//evil.test",
    "/%2e//evil.test",
    "/.\\/evil.test",
  ])("refuses %s", (candidate) => {
    expect(safeNextPath(candidate)).toBe("/");
  });

  it("keeps a same-origin path with its query and fragment", () => {
    expect(safeNextPath("/acme/contacts?page=2#top")).toBe("/acme/contacts?page=2#top");
  });

  it("returns the fallback for an empty candidate", () => {
    expect(safeNextPath(null, "/home")).toBe("/home");
  });
});
