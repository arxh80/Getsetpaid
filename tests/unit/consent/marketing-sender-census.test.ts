import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PHASE 8 TASK 2 -- NO MARKETING EMAIL WITHOUT THE CONSENT CHECK.
//
// GetSetPaid sends no marketing email, and lib/email/send.ts says it is for
// transactional mail only. A comment is not a control. This census makes the
// rule mechanical: every module that imports the one email sender is either
// one of the three TRANSACTIONAL senders below (each justified), or it calls
// `assertMarketingConsent` / `hasMarketingConsent` from lib/consent/marketing.ts
// -- the check PECR requires before marketing email reaches an individual.
// A fourth importer that does neither is a red test naming itself.

const ROOT = resolve(__dirname, "../../..");
const SCAN = ["app", "components", "lib", "proxy.ts"];

const TRANSACTIONAL: Record<string, string> = {
  "lib/email/feedback-notification.ts":
    "the in-app feedback receipt to the founder's own support inbox -- an operational message, not marketing",
  "lib/email/incident-alerts.ts":
    "the incident-alert digest to the operator -- an operational message, not marketing",
  "lib/email/lockout-notification.ts":
    "the account-lockout security notice to the affected account holder (Q114) -- a service message",
};

const IMPORT = /(?:from\s+|import\s*\(\s*)["'](?:@\/lib\/email\/send|\.\.?\/(?:[^"']*\/)?email\/send|\.\/send)["']/;
const CHECK = /\b(?:assertMarketingConsent|hasMarketingConsent)\s*\(/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe("every importer of the email sender is transactional or checks marketing consent", () => {
  const files: string[] = [];
  for (const target of SCAN) {
    const full = join(ROOT, target);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  const importers = files
    .map((f) => ({ file: f.slice(ROOT.length + 1).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }))
    .filter(({ file, text }) => file !== "lib/email/send.ts" && IMPORT.test(text));

  it("NON-VACUITY: the census sees the three transactional senders", () => {
    for (const file of Object.keys(TRANSACTIONAL)) {
      expect(importers.map((i) => i.file)).toContain(file);
    }
  });

  it("each transactional sender is justified, and none of them sends marketing", () => {
    for (const [file, why] of Object.entries(TRANSACTIONAL)) {
      expect(why.length, file).toBeGreaterThan(40);
    }
  });

  it("any other importer calls the consent check", () => {
    const unchecked = importers
      .filter(({ file }) => !(file in TRANSACTIONAL))
      .filter(({ text }) => !CHECK.test(text))
      .map(({ file }) => file);
    expect(
      unchecked,
      "these modules can send email and are neither a declared transactional sender nor a caller of " +
        "assertMarketingConsent(). Marketing email to an individual needs their prior consent (PECR); " +
        "call assertMarketingConsent(client, userId) per recipient immediately before each send, or, if " +
        "the message is genuinely a service message, declare it in TRANSACTIONAL with the reason.",
    ).toEqual([]);
  });

  it("the detector: an importer with no check is caught, one with a check is not", () => {
    const bare = `import { sendEmail } from "@/lib/email/send";\nawait sendEmail(x);`;
    const checked = `import { sendEmail } from "@/lib/email/send";\nawait assertMarketingConsent(c, id);\nawait sendEmail(x);`;
    expect(IMPORT.test(bare) && !CHECK.test(bare)).toBe(true);
    expect(IMPORT.test(checked) && CHECK.test(checked)).toBe(true);
  });
});
