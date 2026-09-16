import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESERVED_WORKSPACE_SLUGS, isReservedWorkspaceSlug } from "@/lib/org/reserved-slugs";

// A WORKSPACE MAY NOT TAKE THE ADDRESS OF ONE OF THE APP'S PAGES
// (Phase 8 Task 2 review, M7; DECISIONS-QUEUE Q151).
//
// A workspace lives at /<slug>. Next.js resolves a static segment before the
// dynamic [orgSlug] one, so a workspace whose slug equals a static top-level
// segment is shadowed -- `legal` could be created and never opened. The
// database refuses such a slug (20260923005000). This test derives the
// top-level segments from app/ itself, so a NEW top-level route that is not
// reserved is a red test naming it, and binds the database's list and the
// form's list to that set.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The static URL segments that sit at the top level of the app: every folder
 * directly under app/, looking THROUGH route groups `(name)` and parallel-route
 * slots `@name` (neither adds a URL segment), and skipping private folders
 * `_name` (never routed) and dynamic segments `[name]` (the workspace itself).
 */
function topLevelSegments(appDir: string): string[] {
  const out = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
      if (/^\(.+\)$/.test(entry) || entry.startsWith("@")) {
        visit(join(dir, entry));
      } else if (entry.startsWith("_") || entry.startsWith("[")) {
        continue;
      } else {
        out.add(entry);
      }
    }
  };
  visit(appDir);
  return [...out].sort();
}

function latestReservedList(): { file: string; slugs: string[] } {
  const dir = join(ROOT, "supabase", "migrations");
  let found: { file: string; slugs: string[] } | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(dir, file), "utf8").split(String.fromCharCode(13)).join("");
    const m = /create or replace function private\.reserved_workspace_slugs\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(text);
    if (m) {
      const slugs = [...m[1].matchAll(/\('([^']+)'::text\)/g)].map((x) => x[1]);
      expect(slugs.length, `${file}: every VALUES row was parsed`).toBe((m[1].match(/\(/g) ?? []).length);
      found = { file, slugs };
    }
  }
  if (!found) throw new Error("private.reserved_workspace_slugs() is defined in no migration");
  return found;
}

describe("reserved workspace slugs", () => {
  const segments = topLevelSegments(join(ROOT, "app"));
  const database = latestReservedList();

  it("DENOMINATOR: the walk finds the routes we know exist, through the route groups", () => {
    for (const known of ["legal", "account", "super", "login", "api", "auth"]) expect(segments).toContain(known);
    expect(segments).not.toContain("[orgSlug]");
    expect(segments.some((s) => s.startsWith("("))).toBe(false);
  });

  it("every static top-level route is a reserved workspace slug", () => {
    const unreserved = segments.filter((s) => SLUG_SHAPE.test(s) && !isReservedWorkspaceSlug(s));
    expect(
      unreserved,
      "a top-level route exists that a workspace could also claim as its address, and would then be " +
        "shadowed by. Add it to private.reserved_workspace_slugs() (a new migration) and to " +
        "lib/org/reserved-slugs.ts, and check no live workspace already holds it (Q154).",
    ).toEqual([]);
  });

  it("the reserved list is exactly the top-level routes -- nothing stale, nothing extra", () => {
    expect([...RESERVED_WORKSPACE_SLUGS].sort()).toEqual(segments.filter((s) => SLUG_SHAPE.test(s)));
  });

  it("the database's list is the form's list", () => {
    expect(database.file >= "20260923005000").toBe(true);
    expect([...database.slugs].sort()).toEqual([...RESERVED_WORKSPACE_SLUGS].sort());
  });

  it("the check ignores case and surrounding space, as the database does", () => {
    expect(isReservedWorkspaceSlug("legal")).toBe(true);
    expect(isReservedWorkspaceSlug(" Legal ")).toBe(true);
    expect(isReservedWorkspaceSlug("legal-team")).toBe(false);
    expect(isReservedWorkspaceSlug("org-alpha")).toBe(false);
  });

  it("FIXTURE: the walk sees through (groups) and @slots, and skips _private and [dynamic]", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsp-routes-"));
    try {
      for (const d of ["(g)/inner", "@slot/parallel", "_private", "[id]", "plain", "(g)/(nested)/deep"]) {
        mkdirSync(join(dir, d), { recursive: true });
      }
      writeFileSync(join(dir, "page.tsx"), "");
      expect(topLevelSegments(dir)).toEqual(["deep", "inner", "parallel", "plain"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
