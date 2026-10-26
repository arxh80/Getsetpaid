import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// G31 (Phase 10 Task 8). SECURITY.md § 15 is the hosted-project checklist:
// config.toml governs the local stack only, so a setting missing from § 15 is
// a control that does not exist in production. This is a text census: each
// load-bearing setting must stay named there, so a deleted line goes red.
//
// SECURITY.md is kept locally and is gitignored ("Kept locally, not
// published"), so CI has no copy. In CI the census is skipped, visibly; on a
// developer machine a missing file is a failure, never a pass.

const PATH = fileURLToPath(new URL("../../../SECURITY.md", import.meta.url));
const present = existsSync(PATH);

/** Each setting § 15 must name, with the gap that made it load-bearing. */
const REQUIRED: [string, string][] = [
  ["enable_confirmations", "G11: Confirm email ON"],
  ["public, graphql_public", "G26: the exposed schemas"],
  ["sign_in_sign_ups", "G10: GoTrue's per-IP sign-in limit"],
  ["token_verifications", "G10: GoTrue's per-IP verification limit"],
  ["email_sent", "G10 / F7: the project-wide email cap"],
  ["max_frequency", "G3: one recovery mail per account per 20 minutes"],
  ["max_rows", "G5 / G6: PostgREST's silent truncation"],
  ["HOOK_PASSWORD_VERIFICATION_ATTEMPT", "G4: the plan that permits the login hook (F8)"],
  ["NEXT_PUBLIC_SITE_URL", "the Site URL"],
  ["additional_redirect_urls", "no localhost redirect"],
  ["TELEGRAM_BOT_TOKEN", "the incident message"],
  ["TELEGRAM_ALERT_CHAT_ID", "the incident message"],
  ["MALWARE_SCANNER=clamav", "G15: the real scanner"],
  ["CLAMAV_HOST", "G15: the real scanner"],
  ["Storage backup", "G30"],
  ["privilege census", "G31: the census against production"],
];

/** § 15's text: from its heading to the next "## " heading. */
function section15(markdown: string): string {
  const text = markdown.replace(/\r\n/g, "\n");
  const start = text.indexOf("\n## 15. ");
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe.skipIf(!present && process.env.CI === "true")("SECURITY.md § 15 names every hosted setting (G31)", () => {
  it("SECURITY.md exists on this machine (it is gitignored; only CI may lack it)", () => {
    expect(present, `${PATH} is missing`).toBe(true);
  });

  const section = present ? section15(readFileSync(PATH, "utf8")) : "";

  it("finds § 15 and only § 15 (non-vacuity)", () => {
    expect(section).toContain("## 15. Pre-launch security checklist");
    expect(section).not.toContain("\n## 14.");
    expect(section15("## 14. x\nmax_rows\n## 15. y\nz\n## 16. w\nmax_rows")).toBe("\n## 15. y\nz");
  });

  it.each(REQUIRED)("names %s (%s)", (key) => {
    expect(section).toContain(key);
  });
});
