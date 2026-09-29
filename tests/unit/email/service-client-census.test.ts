import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// lib/supabase/service.ts is the service-role TABLE client, bounded by the
// column-narrow grants Task 5, Task 6 and Task 6c gave service_role. Its
// header promises ONE importer: lib/email/*. This is the source census that
// keeps a second importer from turning it into a general RLS bypass by drift.
//
// THREE SENDERS since Task 6c. lib/email/lockout-notification.ts (founder
// ruling Q114) reads public.pending_lockout_notifications() -- a SECURITY
// DEFINER function granted to service_role ALONE -- and stamps
// incident_alerts.account_notified_at, a second column-narrow grant. It was
// added here deliberately, after this census failed on it, which is the census
// working: the alternative it rejected was reaching for
// `auth.admin.getUserById()` to resolve the recipient's address, which would
// have widened the client to the whole GoTrue Admin API for one email field.

const ROOT = resolve(__dirname, "../../..");
const SCAN = ["app", "components", "lib", "proxy.ts"];
const ALLOWED = new Set([
  "lib/email/feedback-notification.ts",
  "lib/email/incident-alerts.ts",
  "lib/email/lockout-notification.ts",
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe("lib/supabase/service.ts has exactly the importers its header names", () => {
  const files: string[] = [];
  for (const target of SCAN) {
    const full = join(ROOT, target);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }

  const importers = files
    .filter((f) => /(?:from\s+|import\s*\(\s*)["'](?:@\/lib\/supabase\/service|\.\.?\/(?:[^"']*\/)?supabase\/service|\.\/service)["']/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"))
    .filter((f) => f !== "lib/supabase/service.ts");

  it("the census sees the three known importers (non-vacuity)", () => {
    for (const allowed of ALLOWED) expect(importers).toContain(allowed);
  });

  it("and nothing else", () => {
    const extra = importers.filter((f) => !ALLOWED.has(f));
    expect(
      extra,
      `${extra.join(", ")} import the service-role table client -- only the three senders may; a new privileged table need is a SECURITY DEFINER function in a migration (lib/supabase/admin.ts's rule)`,
    ).toEqual([]);
  });
});
