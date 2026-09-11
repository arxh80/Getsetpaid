import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// lib/supabase/service.ts is the service-role TABLE client, bounded by the
// two column-narrow grants Task 5 and Task 6 gave service_role. Its header
// promises ONE importer: lib/email/*. This is the source census that keeps a
// second importer from turning it into a general RLS bypass by drift.

const ROOT = resolve(__dirname, "../../..");
const SCAN = ["app", "components", "lib", "proxy.ts"];
const ALLOWED = new Set(["lib/email/feedback-notification.ts", "lib/email/incident-alerts.ts"]);

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

  it("the census sees the two known importers (non-vacuity)", () => {
    for (const allowed of ALLOWED) expect(importers).toContain(allowed);
  });

  it("and nothing else", () => {
    const extra = importers.filter((f) => !ALLOWED.has(f));
    expect(
      extra,
      `${extra.join(", ")} import the service-role table client -- only the two senders may; a new privileged table need is a SECURITY DEFINER function in a migration (lib/supabase/admin.ts's rule)`,
    ).toEqual([]);
  });
});
