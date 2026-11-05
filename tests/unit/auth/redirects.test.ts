import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/redirects";

// safeNextPath() is the only thing between a `?next=` value and redirect().
// Phase 10 Task 2 F5: "/.//evil.test" passed the leading-"//" check (it starts
// "/."), and the URL parser's dot-segment removal then produced "//evil.test",
// a protocol-relative Location that leaves the site. The callback route
// sanitises once and redirects, so this was reachable from a real-domain link.
describe("safeNextPath", () => {
  it.each([
    ["/.//evil.test", "dot segment collapses to protocol-relative (F5)"],
    ["/./\\evil.test", "dot segment then backslash"],
    ["/x/..//evil.test", "parent segment collapses to protocol-relative"],
    ["/%2e//evil.test", "encoded dot segment"],
    ["//evil.test/x", "protocol-relative"],
    ["/\\evil.test/x", "backslash"],
    ["https://evil.test/x", "absolute"],
    ["javascript:alert(1)", "scheme"],
  ])("refuses %s (%s)", (candidate) => {
    expect(safeNextPath(candidate)).toBe("/");
  });

  it.each([
    ["/acme/contacts?q=a#top", "/acme/contacts?q=a#top"],
    ["/acme/./contacts", "/acme/contacts"],
  ])("keeps the same-origin path %s", (candidate, expected) => {
    expect(safeNextPath(candidate)).toBe(expected);
  });

  it("returns the caller's fallback for a refused value", () => {
    expect(safeNextPath("/.//evil.test", "/home")).toBe("/home");
  });
});
