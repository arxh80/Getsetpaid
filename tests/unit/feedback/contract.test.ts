import { describe, expect, it } from "vitest";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  SCREENSHOT_WARNING,
  feedbackScreenshotKey,
  isFeedbackCategory,
  isFeedbackScreenshotMime,
  isFeedbackStatus,
  parseIsoDate,
} from "@/lib/feedback/contract";

// The closed vocabularies behind /super/feedback's filters and the submit
// form. Every parser here is an ALLOWLIST a query string or a form post passes
// through, so each one is probed with the Object.prototype names that a
// prototype-walking `in` check admits (the incident-alert filter's own found
// bug, lib/admin/health.ts).

describe("feedback allowlists", () => {
  it("accept exactly the database's CHECK vocabularies", () => {
    expect(FEEDBACK_CATEGORIES).toEqual(["bug", "idea", "other"]);
    expect(FEEDBACK_STATUSES).toEqual(["new", "read", "actioned", "archived"]);
    for (const c of FEEDBACK_CATEGORIES) expect(isFeedbackCategory(c)).toBe(true);
    for (const s of FEEDBACK_STATUSES) expect(isFeedbackStatus(s)).toBe(true);
  });

  it.each(["toString", "constructor", "hasOwnProperty", "__proto__", "", "BUG", "praise"])(
    "refuse %j -- own keys only, never the prototype chain",
    (value) => {
      expect(isFeedbackCategory(value)).toBe(false);
      expect(isFeedbackStatus(value)).toBe(false);
    },
  );

  it("screenshot mimes are the four image types and nothing the documents allowlist adds", () => {
    expect(isFeedbackScreenshotMime("image/png")).toBe(true);
    expect(isFeedbackScreenshotMime("image/gif")).toBe(true);
    expect(isFeedbackScreenshotMime("application/pdf")).toBe(false);
    expect(isFeedbackScreenshotMime("text/plain")).toBe(false);
  });
});

describe("parseIsoDate", () => {
  it("accepts a real calendar day and returns it unchanged", () => {
    expect(parseIsoDate("2026-09-11")).toBe("2026-09-11");
    expect(parseIsoDate("2024-02-29")).toBe("2024-02-29");
  });
  it.each([null, "", "2026-9-1", "2026-02-31", "2023-02-29", "11/09/2026", "2026-09-11T00:00:00Z", "toString"])(
    "degrades %j to no filter rather than throwing",
    (value) => {
      expect(parseIsoDate(value)).toBeNull();
    },
  );
});

describe("feedbackScreenshotKey", () => {
  it("is feedback/{id} and carries no user input", () => {
    expect(feedbackScreenshotKey("11111111-2222-4333-8444-555555555555")).toBe(
      "feedback/11111111-2222-4333-8444-555555555555",
    );
  });
  it("throws on anything that is not a uuid, so a client string can never become a key", () => {
    expect(() => feedbackScreenshotKey("../etc/passwd")).toThrow();
    expect(() => feedbackScreenshotKey("")).toThrow();
  });
});

describe("the pre-upload warning", () => {
  it("says the two things CLAUDE.md requires: on-screen data may be captured, and the operator sees it", () => {
    expect(SCREENSHOT_WARNING).toMatch(/on your screen/i);
    expect(SCREENSHOT_WARNING).toMatch(/operator/i);
    expect(SCREENSHOT_WARNING).toMatch(/recorded/i);
  });
});
