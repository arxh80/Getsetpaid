import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ===========================================================================
// THE AUTH SETTINGS IN supabase/config.toml THAT A SECURITY CONTROL RESTS ON
// ===========================================================================
// config.toml is the local stack's auth configuration and the checklist the
// hosted project is provisioned from (SECURITY.md § 15). A value here that a
// control depends on is therefore asserted, not merely commented: a one-word
// edit to this file can reopen a hole that no other gate measures, because
// every e2e fixture mints its users through the Admin API with
// `email_confirm: true` and never meets the setting at all.
//
// Read with a small SECTION-AWARE line scanner rather than a TOML library (no
// new dependency for one file). Section-awareness is the whole point:
// `enable_confirmations` appears under BOTH [auth.email] and [auth.sms], so a
// plain grep for the key would happily read the wrong one.
//
// Phase 10 Task 8 added max_frequency (G3) and the per-IP limits (G10).
// ===========================================================================

const CONFIG_PATH = fileURLToPath(new URL("../../../supabase/config.toml", import.meta.url));

/** Strips a trailing `# comment` that is not inside a double-quoted string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

/**
 * Every assignment of `key` directly inside `[section]` (not a subsection),
 * as raw value text. Returns all of them so a duplicate -- where the LAST one
 * silently wins in a real TOML parser -- is visible to the caller.
 */
function valuesOf(toml: string, section: string, key: string): string[] {
  const found: string[] = [];
  let current: string | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line === "") continue;
    const header = /^\[([^\][]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (assignment && assignment[1] === key) found.push(assignment[2].trim());
  }
  return found;
}

const toml = readFileSync(CONFIG_PATH, "utf8");

describe("supabase/config.toml auth settings", () => {
  it("the scanner reads sections, not bare keys (non-vacuity)", () => {
    // [auth.email] and [auth.sms] each carry an enable_confirmations line, and
    // [auth] carries none of its own. If the scanner ignored sections, [auth]
    // would see both.
    expect(valuesOf(toml, "auth.email", "enable_confirmations")).toHaveLength(1);
    expect(valuesOf(toml, "auth.sms", "enable_confirmations")).toHaveLength(1);
    expect(valuesOf(toml, "auth", "enable_confirmations")).toEqual([]);
  });

  // G11 (docs/launch-gates.md), the account pre-hijack. With confirmations
  // OFF, anyone can sign up as an address they do not own and get a confirmed,
  // usable account at once; a workspace that later invites that address binds
  // the invite to the squatter's account. Turning this on is what makes an
  // account's email address mean "the holder of this inbox", which both
  // accept_invite() (20261102010000) and the invite step's refusal to bind an
  // unconfirmed sign-up (lib/org/actions.ts) rely on.
  it("[auth.email] enable_confirmations is true (G11)", () => {
    expect(valuesOf(toml, "auth.email", "enable_confirmations")).toEqual(["true"]);
  });

  // Phase 10 Task 20 (Q245). lib/auth/first-proof.ts's isNewSignUp() tells a
  // NEW account from a re-sign-up by the gap between created_at and
  // confirmation_sent_at, and that gap is at least max_frequency for a
  // re-sign-up only because GoTrue refuses to re-send inside it. Below one
  // second the discriminator would bind a re-sign-up to its browser and keep
  // the FIRST registrant's password. The hosted value must hold too
  // (SECURITY.md § 15).
  it("[auth.email] max_frequency is at least one second (Q245's discriminator)", () => {
    const values = valuesOf(toml, "auth.email", "max_frequency");
    expect(values).toHaveLength(1);
    const match = /^"(\d+)(ms|s|m|h)"$/.exec(values[0]);
    expect(match, `unparsed max_frequency ${values[0]}`).not.toBeNull();
    const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match![2] as "ms" | "s" | "m" | "h"];
    expect(Number(match![1]) * unitMs).toBeGreaterThanOrEqual(1_000);
  });

  // G3 (Phase 10 Task 8). SECURITY.md § 5's "password recovery 3 / hour per
  // account" has no hook to enforce it; GoTrue's own per-user mail timer is
  // the enforcement point, and 20 minutes is at most three an hour. A longer
  // value is not a looser control, but it is not what § 5 promises, and it
  // also throttles the emailed sign-in link (the lockout's escape hatch), so
  // the value is pinned exactly.
  it('[auth.email] max_frequency is "20m": at most 3 recovery emails per account per hour (G3)', () => {
    expect(valuesOf(toml, "auth.email", "max_frequency")).toEqual(['"20m"']);
  });

  // G10 (Phase 10 Task 8). GoTrue's per-IP limits. Without the per-account
  // hook on the hosted plan (G4, F8) sign_in_sign_ups is production's only
  // GoTrue-side brute-force bound, so raising it would go unnoticed without
  // this. A live 31st-request check belongs on the hosted project from an
  // isolated source (SECURITY.md § 15), never on the shared local stack.
  it.each([
    ["sign_in_sign_ups", "30"],
    ["token_verifications", "30"],
    ["email_sent", "30"],
  ])("[auth.rate_limit] %s = %s (G10)", (key, value) => {
    expect(valuesOf(toml, "auth.rate_limit", key)).toEqual([value]);
  });

  // The two templates that send every sign-up confirmation and recovery link
  // through /auth/callback with a token hash (Q245): with GoTrue's defaults
  // the proof happened at /auth/v1/verify, where the app never saw it.
  it.each(["confirmation", "recovery", "invite", "magic_link"])(
    "[auth.email.template.%s] is a template of ours that links to /auth/callback with a token hash",
    (name) => {
      const [path] = valuesOf(toml, `auth.email.template.${name}`, "content_path");
      expect(path, `no content_path for ${name}`).toBeDefined();
      const html = readFileSync(
        fileURLToPath(new URL(`../../../${path.replace(/^"\.\/|"$/g, "")}`, import.meta.url)),
        "utf8",
      );
      expect(html).toMatch(/href="\{\{ \.SiteURL \}\}\/auth\/callback\?token_hash=\{\{ \.TokenHash \}\}&type=/);
      expect(html).not.toContain("{{ .ConfirmationURL }}\"");
    },
  );

  // Phase 10 Task 2 F3. A password change or MFA factor change made straight
  // to GoTrue with a stolen token skips the app's step-up and no GoTrue
  // setting in the pinned toolchain gates it; these notices make it visible.
  // Delivery is proved by tests/integration/session/security-notifications.
  it.each(["password_changed", "mfa_factor_enrolled", "mfa_factor_unenrolled"])(
    "[auth.email.notification.%s] is enabled with a template of ours (F3)",
    (name) => {
      const section = `auth.email.notification.${name}`;
      expect(valuesOf(toml, section, "enabled")).toEqual(["true"]);
      const [path] = valuesOf(toml, section, "content_path");
      expect(path, `no content_path for ${name}`).toBeDefined();
      // Notification paths resolve relative to supabase/ (see config.toml).
      const html = readFileSync(
        fileURLToPath(new URL(`../../../supabase/${path.replace(/^"\.\/|"$/g, "")}`, import.meta.url)),
        "utf8",
      );
      expect(html).toContain("{{ .Email }}");
    },
  );
});
