import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  appSourceFiles,
  constDeclarations,
  constantString,
  moduleReferences,
  namesModule,
  parse,
  relPath,
  resolveSpecifier,
  unwrap,
} from "../support/app-source";

// PHASE 8 TASK 2 -- NO MARKETING EMAIL WITHOUT THE CONSENT CHECK.
//
// GetSetPaid sends no marketing email, and lib/email/send.ts says it is for
// transactional mail only. A comment is not a control. This census makes the
// rule mechanical over every app-shipped source file
// (tests/unit/support/app-source.ts):
//   * every module that imports the one email sender -- by `@/lib/email/send`
//     or by ANY relative path that resolves to it (`./send`, `../send`,
//     `../../lib/email/send`), statically, dynamically or as a re-export -- is
//     either one of the three TRANSACTIONAL senders below (each justified), or
//     makes a REAL CALL to `assertMarketingConsent` / `hasMarketingConsent`
//     imported from lib/consent/marketing.ts (a name in a comment or a string
//     does not count; the file is parsed);
//   * no module but lib/email/send.ts talks to the email provider directly
//     (its API host or its API key), because a sender that skips
//     lib/email/send.ts skips this census too.
// Task 2 review M4 measured all three evasions green against the first
// (regex) census; each is now a fixture below.
//
// WHAT THIS CANNOT SEE, and why that is inherent rather than a gap to close:
//   * ORDER AND REACHABILITY. The rule is "a real call to the check exists in
//     the module", not "the check runs before every send, for this recipient":
//     a call placed in dead code (`if (false) await hasMarketingConsent(...)`)
//     or after the send satisfies it (re-review N3). Proving the call
//     dominates every send is data-flow analysis; the check itself fails
//     closed, and a marketing sender is a reviewed change, not a drive-by.
//   * A provider host or key name that is not a constant in the source (read
//     from the environment or a database) is not a provider string here.

const SENDER = "lib/email/send.ts";
const CONSENT_MODULE = "lib/consent/marketing.ts";
const CONSENT_CHECKS = new Set(["assertMarketingConsent", "hasMarketingConsent"]);
/**
 * The provider's API hosts and key names. A new provider is added to each.
 * Hosts are matched CASE-INSENSITIVELY, because DNS is (re-review N3:
 * `https://API.Brevo.com` passed the first pattern). Environment variable
 * names are case-sensitive, so the key name is matched exactly -- and any
 * string literal that STARTS with the provider's variable prefix is flagged
 * too, so a key name assembled at runtime (`"BREVO_" + ...`) is still seen.
 */
const PROVIDER_HOST = /\bapi\.(?:brevo|sendinblue)\.com\b/i;
const PROVIDER_KEY = /\b(?:BREVO|SENDINBLUE)_API_KEY\b/;
const PROVIDER_KEY_PREFIX = /^(?:BREVO|SENDINBLUE)_/;
const isProviderString = (value: string) => PROVIDER_HOST.test(value) || PROVIDER_KEY.test(value);

const TRANSACTIONAL: Record<string, string> = {
  "lib/email/feedback-notification.ts":
    "the in-app feedback receipt to the founder's own support inbox -- an operational message, not marketing",
  "lib/email/incident-alerts.ts":
    "the incident-alert digest to the operator -- an operational message, not marketing",
  "lib/email/lockout-notification.ts":
    "the account-lockout security notice to the affected account holder (Q114) -- a service message",
};

interface Analysis {
  importsSender: boolean;
  callsConsentCheck: boolean;
  providerSites: string[];
}

function analyse(file: string, text: string): Analysis {
  const sf = parse(file, text);
  const consts = constDeclarations(sf);
  const refs = moduleReferences(sf, consts);
  let importsSender = false;
  const checkNames = new Set<string>();
  const checkNamespaces = new Set<string>();
  for (const ref of refs) {
    const resolved = ref.specifier === null ? null : resolveSpecifier(file, ref.specifier);
    if (namesModule(resolved, SENDER)) importsSender = true;
    if (namesModule(resolved, CONSENT_MODULE)) {
      for (const b of ref.bindings) {
        if (CONSENT_CHECKS.has(b.imported)) checkNames.add(b.local);
        if (b.imported === "*" || b.imported === "default") checkNamespaces.add(b.local);
      }
    }
  }
  let callsConsentCheck = false;
  const providerSites: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee) && checkNames.has(callee.text)) callsConsentCheck = true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        CONSENT_CHECKS.has(callee.name.text) &&
        ts.isIdentifier(unwrap(callee.expression)) &&
        checkNamespaces.has((unwrap(callee.expression) as ts.Identifier).text)
      ) {
        callsConsentCheck = true;
      }
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const value = constantString(n as ts.Expression, consts) ?? n.getText(sf);
      if (isProviderString(value)) providerSites.push(n.getText(sf));
      else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && PROVIDER_KEY_PREFIX.test(n.text)) {
        providerSites.push(n.getText(sf));
      }
    }
    if (ts.isIdentifier(n) && PROVIDER_KEY.test(n.text)) providerSites.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { importsSender, callsConsentCheck, providerSites };
}

describe("every importer of the email sender is transactional or checks marketing consent", () => {
  const files = appSourceFiles().map((f) => ({ file: relPath(f), text: readFileSync(f, "utf8") }));
  const analysed = files.map((f) => ({ file: f.file, ...analyse(f.file, f.text) }));
  const importers = analysed.filter((a) => a.file !== SENDER && a.importsSender);

  it("NON-VACUITY: the census sees the three transactional senders, and the sender itself", () => {
    expect(files.map((f) => f.file)).toContain(SENDER);
    for (const file of Object.keys(TRANSACTIONAL)) {
      expect(importers.map((i) => i.file)).toContain(file);
    }
    // ...and it sees the provider where it really is.
    expect(analysed.find((a) => a.file === SENDER)?.providerSites.length).toBeGreaterThan(0);
  });

  it("each transactional sender is justified, and none of them sends marketing", () => {
    for (const [file, why] of Object.entries(TRANSACTIONAL)) {
      expect(why.length, file).toBeGreaterThan(40);
    }
  });

  it("any other importer calls the consent check", () => {
    const unchecked = importers
      .filter(({ file }) => !(file in TRANSACTIONAL))
      .filter(({ callsConsentCheck }) => !callsConsentCheck)
      .map(({ file }) => file);
    expect(
      unchecked,
      "these modules can send email and are neither a declared transactional sender nor a caller of " +
        "assertMarketingConsent(). Marketing email to an individual needs their prior consent (PECR); " +
        "call assertMarketingConsent(client, userId) per recipient immediately before each send, or, if " +
        "the message is genuinely a service message, declare it in TRANSACTIONAL with the reason.",
    ).toEqual([]);
  });

  it("nothing but the sender talks to the email provider directly", () => {
    const direct = analysed
      .filter((a) => a.file !== SENDER && a.providerSites.length > 0)
      .map((a) => `${a.file}: ${a.providerSites.join(", ")}`);
    expect(
      direct,
      "a module reaches the email provider without going through lib/email/send.ts, so it escapes " +
        "this census. Send through lib/email/send.ts.",
    ).toEqual([]);
  });
});

describe("the sender census detector", () => {
  const CHECKED_IMPORT = `import { assertMarketingConsent } from "@/lib/consent/marketing";\n`;

  it("catches an importer with no check, and passes one with a real check", () => {
    const bare = analyse("lib/marketing/a.ts", `import { sendEmail } from "@/lib/email/send";\nawait sendEmail(x);`);
    expect(bare).toMatchObject({ importsSender: true, callsConsentCheck: false });
    const checked = analyse(
      "lib/marketing/a.ts",
      `${CHECKED_IMPORT}import { sendEmail } from "@/lib/email/send";\nawait assertMarketingConsent(c, id);\nawait sendEmail(x);`,
    );
    expect(checked).toMatchObject({ importsSender: true, callsConsentCheck: true });
  });

  // The three review evasions (M4), each GREEN under the regex census.
  it("EVASION 1: a relative import from a subfolder resolves to the sender", () => {
    expect(analyse("lib/email/marketing/newsletter.ts", `import { sendEmail } from "../send";`).importsSender).toBe(true);
    expect(analyse("app/(app)/x/actions.ts", `import { sendEmail } from "../../../lib/email/send";`).importsSender).toBe(true);
    expect(analyse("lib/email/digest.ts", `import { sendEmail } from "./send.ts";`).importsSender).toBe(true);
    expect(analyse("lib/email/digest.ts", `const { sendEmail } = await import("./send");`).importsSender).toBe(true);
    expect(analyse("lib/email/index.ts", `export { sendEmail } from "./send";`).importsSender).toBe(true);
    // ...and a module that merely shares the name elsewhere does not.
    expect(analyse("lib/sms/digest.ts", `import { send } from "./send";`).importsSender).toBe(false);
  });

  it("EVASION 2: a consent check that appears only in a comment or a string is not a check", () => {
    const commented = analyse(
      "lib/marketing/a.ts",
      `import { sendEmail } from "@/lib/email/send";\n// assertMarketingConsent(client, id) -- TODO\nconst s = "hasMarketingConsent(";\nawait sendEmail(x);`,
    );
    expect(commented.callsConsentCheck).toBe(false);
    // Nor is a same-named function that is not the real one.
    const impostor = analyse(
      "lib/marketing/a.ts",
      `import { sendEmail } from "@/lib/email/send";\nconst assertMarketingConsent = async () => {};\nawait assertMarketingConsent();\nawait sendEmail(x);`,
    );
    expect(impostor.callsConsentCheck).toBe(false);
    // A namespace or aliased import of the real one IS a check.
    expect(
      analyse(
        "lib/marketing/a.ts",
        `import * as consent from "../consent/marketing";\nawait consent.hasMarketingConsent(c, id);`,
      ).callsConsentCheck,
    ).toBe(true);
    expect(
      analyse(
        "lib/marketing/a.ts",
        `import { assertMarketingConsent as mustConsent } from "@/lib/consent/marketing";\nawait mustConsent(c, id);`,
      ).callsConsentCheck,
    ).toBe(true);
  });

  it("EVASION 3: a direct call to the provider is flagged, however the URL or key is written", () => {
    const shapes = [
      `await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST" });`,
      "const host = `https://api.${'brevo'}.com`; await fetch(host + '/v3/smtp/email');",
      `const U = "https://api." + "brevo.com/v3/smtp/email"; await fetch(U);`,
      `const key = process.env.BREVO_API_KEY;`,
      `const key = process.env["BREVO_API_KEY"];`,
      `await fetch("https://api.sendinblue.com/v3/smtp/email");`,
      // re-review N3: hosts are case-insensitive, and so is the check now.
      `await fetch("https://API.Brevo.com" + "/v3/smtp/email");`,
      "await fetch(`https://Api.Brevo.Com/v3/smtp/email`);",
      `await fetch("HTTPS://API.SENDINBLUE.COM/v3/smtp/email");`,
      `const key = process.env["BREVO_" + "API_KEY".toString()];`,
      `const key = process.env[["SENDINBLUE_", "API", "_KEY"].join("")];`,
    ];
    for (const source of shapes) {
      expect(analyse("lib/marketing/direct.ts", source).providerSites.length, source).toBeGreaterThan(0);
    }
    expect(analyse("lib/marketing/direct.ts", `// posts to api.brevo.com\nconst x = "Brevo";`).providerSites).toEqual([]);
    // Case-sensitive where the platform is: a lower-case variable is a different variable.
    expect(
      analyse("lib/marketing/direct.ts", `const k = process.env.brevo_api_key; const b = "brevo_";`).providerSites,
    ).toEqual([]);
  });
});
