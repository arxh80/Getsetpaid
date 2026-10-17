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
// Phase 10 Task 8 extends this file with further keys.
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
});
