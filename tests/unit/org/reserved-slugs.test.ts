import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESERVED_WORKSPACE_SLUGS, isReservedWorkspaceSlug } from "@/lib/org/reserved-slugs";
import { isMetadataRouteFile, isStaticMetadataFile } from "next/dist/lib/metadata/is-metadata-route";
import { latestFunctionDefinition } from "../support/sql-definitions";

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

// Next's own classifier for metadata route files (icon, apple-icon,
// opengraph-image, twitter-image, sitemap, robots, manifest, favicon, with the
// numbered variants) is imported above, so the list of names is Next's rather
// than a copy.
const PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

const isGroup = (entry: string) => /^\(.+\)$/.test(entry);
const isSlot = (entry: string) => entry.startsWith("@");
/** `(.)x` / `(..)x` / `(..)(..)x` / `(...)x`: the levels it climbs (Infinity = root), and the segment. */
function intercept(entry: string): { up: number; name: string } | null {
  const m = /^((?:\(\.\.\))+|\(\.\)|\(\.\.\.\))(.+)$/.exec(entry);
  if (!m) return null;
  const marker = m[1];
  const up = marker === "(.)" ? 0 : marker === "(...)" ? Infinity : marker.length / 4;
  return { up, name: m[2] };
}

/**
 * The URL a top-level metadata route FILE serves (review N4), as Next 16
 * serves it (next/dist/lib/metadata/get-metadata-route.js): a static file at
 * its own name (`icon.svg` -> /icon.svg); a dynamic one at its base name
 * (`icon.tsx` -> /icon, `opengraph-image.tsx` -> /opengraph-image), except
 * robots -> /robots.txt, manifest -> /manifest.webmanifest and sitemap ->
 * /sitemap.xml. null for anything that is not a metadata route.
 */
function metadataRouteSegment(file: string): string | null {
  if (!isMetadataRouteFile(`/${file}`, PAGE_EXTENSIONS, true)) return null;
  if (isStaticMetadataFile(`/${file}`)) return file;
  const base = file.replace(/\.[^.]+$/, "");
  if (base === "robots") return "robots.txt";
  if (base === "manifest") return "manifest.webmanifest";
  if (base === "sitemap") return "sitemap.xml";
  return base;
}

/**
 * The URL segments that sit at the top level of the app.
 *
 * FOLDERS directly under app/, looking THROUGH route groups `(name)` and
 * parallel-route slots `@name` (neither adds a URL segment), and skipping
 * private folders `_name` (never routed) and dynamic segments `[name]` (the
 * workspace itself).
 *
 * FILES directly under app/ (through groups and slots) that Next serves as
 * metadata routes (review N4): `app/icon.tsx` serves /icon, which would shadow
 * a workspace called `icon`.
 *
 * INTERCEPTING folders anywhere in the tree (review N4) whose target is the
 * top level: `(.)x` at the top level, `(..)x` one real segment down, and
 * `(...)x` at any depth all intercept /x. Dynamic folders are walked for these
 * (a `(...)x` under [orgSlug] still intercepts /x); private folders are not.
 */
function topLevelSegments(appDir: string): string[] {
  const out = new Set<string>();
  const visit = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) {
        if (depth === 0) {
          const served = metadataRouteSegment(entry);
          if (served !== null) out.add(served);
        }
        continue;
      }
      if (entry.startsWith("_")) continue;
      if (isGroup(entry) || isSlot(entry)) {
        visit(path, depth);
        continue;
      }
      const intercepted = intercept(entry);
      if (intercepted) {
        const level = intercepted.up === Infinity ? 0 : depth - intercepted.up;
        if (level === 0) out.add(intercepted.name);
        visit(path, (level < 0 ? 0 : level) + 1);
        continue;
      }
      if (depth === 0 && !entry.startsWith("[")) out.add(entry);
      visit(path, depth + 1);
    }
  };
  visit(appDir, 0);
  return [...out].sort();
}

function latestReservedList(): { file: string; slugs: string[] } {
  // The LATEST definition, by an ordered, parsed walk of the migrations (N8).
  const { file, body } = latestFunctionDefinition("private.reserved_workspace_slugs");
  const slugs = [...body.matchAll(/\('([^']+)'::text\)/g)].map((x) => x[1]);
  expect(slugs.length, `${file}: every VALUES row was parsed`).toBe((body.match(/\(/g) ?? []).length);
  return { file, slugs };
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
    // The database's key is NFKC + trim + lower (20260923006000); these are
    // the look-alikes the scoped re-review had an Owner PATCH accepted.
    expect(isReservedWorkspaceSlug("\uFF4C\uFF45\uFF47\uFF41\uFF4C")).toBe(true); // fullwidth
    expect(isReservedWorkspaceSlug("legal\u00A0")).toBe(true);
    expect(isReservedWorkspaceSlug("legal\t")).toBe(true);
    expect(isReservedWorkspaceSlug("\u3000\uFF33\uFF29\uFF27\uFF2E\uFF35\uFF30")).toBe(true);
    expect(isReservedWorkspaceSlug("l\u0435gal")).toBe(false); // Cyrillic: not folded, grammar refuses it
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

  it("FIXTURE (N4): top-level metadata route FILES are segments, under the URL Next serves them at", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsp-routes-"));
    try {
      mkdirSync(join(dir, "(g)"), { recursive: true });
      mkdirSync(join(dir, "_private"), { recursive: true });
      mkdirSync(join(dir, "plain"), { recursive: true });
      for (const f of [
        "icon.tsx",
        "icon1.tsx",
        "apple-icon.ts",
        "opengraph-image.tsx",
        "sitemap.ts",
        "robots.ts",
        "manifest.ts",
        "icon.svg",
        "favicon.ico",
        "page.tsx",
        "layout.tsx",
        "not-found.tsx",
        "globals.css",
        "iconic.tsx",
        "(g)/twitter-image.jsx",
        "_private/apple-icon.tsx",
        "plain/opengraph-image.tsx",
      ]) {
        writeFileSync(join(dir, f), "");
      }
      const segments = topLevelSegments(dir);
      expect(segments).toEqual([
        "apple-icon",
        "favicon.ico",
        "icon",
        "icon.svg",
        "icon1",
        "manifest.webmanifest",
        "opengraph-image",
        "plain",
        "robots.txt",
        "sitemap.xml",
        "twitter-image",
      ]);
      // The slug-shaped ones are the ones a workspace could collide with.
      expect(segments.filter((s) => SLUG_SHAPE.test(s))).toEqual([
        "apple-icon",
        "icon",
        "icon1",
        "opengraph-image",
        "plain",
        "twitter-image",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FIXTURE (N4): intercepting folders that target the top level are segments", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsp-routes-"));
    try {
      for (const d of [
        "(.)photo",
        "feed/(..)modal",
        "feed/(.)inner-only",
        "a/b/(..)(..)climbed",
        "a/b/(..)not-root",
        "[id]/deep/(...)anywhere",
        "(g)/(.)grouped",
        "_private/(...)hidden",
      ]) {
        mkdirSync(join(dir, d), { recursive: true });
      }
      expect(topLevelSegments(dir)).toEqual(["a", "anywhere", "climbed", "feed", "grouped", "modal", "photo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DENOMINATOR (N4): the real app/ has a top-level metadata file, and it is not slug-shaped", () => {
    expect(segments).toContain("icon.svg");
    expect(segments.filter((s) => !SLUG_SHAPE.test(s))).toEqual(["icon.svg"]);
  });
});
