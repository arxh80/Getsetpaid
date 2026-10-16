import { describe, expect, it } from "vitest";
import {
  CLOSURE_BACKUP_FAILED_LINE,
  PARTS_TOGETHER_LINE,
  closureBackupHelpHref,
} from "@/lib/org/closure-contract";

// Q228 Task 4: the failed-backup "Contact us" link. NOTHING private goes in
// the subject: the slug and the job id, which the support contact needs to
// find the job and which the Owner already holds.

const ID = "11111111-2222-4333-8444-555555555555";

describe("closureBackupHelpHref", () => {
  it("is a mailto whose subject is exactly the slug and the job id", () => {
    expect(closureBackupHelpHref("help@example.com", "acme", ID)).toBe(
      `mailto:help@example.com?subject=Closure%20backup%20failed%3A%20acme%20(job%20${ID})`,
    );
  });

  it("falls back to the contact page when no address is configured", () => {
    expect(closureBackupHelpHref(null, "acme", ID)).toBe("/legal/contact");
  });

  it("carries only the slug and the id: the decoded subject has nothing else", () => {
    const href = closureBackupHelpHref("help@example.com", "acme-co", ID);
    const subject = decodeURIComponent(href.split("subject=")[1] ?? "");
    expect(subject).toBe(`Closure backup failed: acme-co (job ${ID})`);
  });

  it("encodes a hostile slug rather than letting it add a mailto header", () => {
    const href = closureBackupHelpHref("help@example.com", "a&body=x", ID);
    expect(href.split("?")).toHaveLength(2);
    expect(href).not.toContain("&body=");
  });
});

describe("the closure backup copy", () => {
  it("says what happened and what to do", () => {
    expect(CLOSURE_BACKUP_FAILED_LINE).toBe(
      "Your backup could not be built. Contact us and we will help you get a copy of your data.",
    );
  });

  it("names the part count twice and the index part", () => {
    expect(PARTS_TOGETHER_LINE(3)).toBe(
      "These 3 parts together are the whole backup. Part 3 holds the index (its manifest.json lists every part).",
    );
  });
});
