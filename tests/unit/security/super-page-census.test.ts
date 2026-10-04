// Phase 8 Task 8. The /super page census that tests/e2e/super-permissions.spec.ts
// relies on, proved against its own denominator: every shape Next.js serves a
// /super page from is planted in a scratch tree, and each must be named by URL.
// Runs in CI (tests/unit), which the e2e census it guards does not.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacySuperPageUrls,
  SUPER_NON_SURFACE_URLS,
  SUPER_PAGE_URLS,
  superPageUrls,
} from "../../support/super-route-census";

let root = "";
function tree(files: string[]): string {
  root = mkdtempSync(join(tmpdir(), "super-census-"));
  for (const f of files) {
    const path = join(root, ...f.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export default function P() { return null; }\n");
  }
  return root;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const BASE = ["(app)/super/page.tsx", "(app)/super/health/page.tsx", "(app)/contacts/page.tsx"];

describe("the /super page census", () => {
  it("the real tree's /super pages are exactly the ones the e2e spec probes", () => {
    expect(superPageUrls(join(process.cwd(), "app"))).toEqual(
      [...SUPER_PAGE_URLS, ...SUPER_NON_SURFACE_URLS].sort(),
    );
  });

  it("DENOMINATOR: the new derivation agrees with the old one on the real tree", () => {
    // Today's tree has none of the shapes the old one missed, so the two must
    // agree -- which is what makes the plants below the whole difference.
    expect(superPageUrls(join(process.cwd(), "app"))).toEqual(legacySuperPageUrls(join(process.cwd(), "app")));
  });

  it("PLANT: a plain page.tsx under /super is named by both", () => {
    const r = tree([...BASE, "(app)/super/zzz/page.tsx"]);
    expect(superPageUrls(r)).toContain("/super/zzz");
    expect(legacySuperPageUrls(r)).toContain("/super/zzz");
  });

  it("PLANT: page.ts / page.jsx / page.mdx -- missed by the old census, named by the new", () => {
    const r = tree([
      ...BASE,
      "(app)/super/zzz-ts/page.ts",
      "(app)/super/zzz-jsx/page.jsx",
      "(app)/super/zzz-mdx/page.mdx",
    ]);
    const now = superPageUrls(r);
    const old = legacySuperPageUrls(r);
    for (const u of ["/super/zzz-ts", "/super/zzz-jsx", "/super/zzz-mdx"]) {
      expect(now, u).toContain(u);
      expect(old, `${u}: the old census was supposed to miss this -- that IS the hole`).not.toContain(u);
    }
  });

  it("PLANT: a /super page in ANOTHER route group -- outside the old walk's root entirely", () => {
    const r = tree([...BASE, "(ops)/super/zzz-group/page.tsx"]);
    expect(superPageUrls(r)).toContain("/super/zzz-group");
    expect(legacySuperPageUrls(r)).not.toContain("/super/zzz-group");
  });

  it("PLANT: a route group and a parallel slot INSIDE /super map to the URL Next serves", () => {
    const r = tree([...BASE, "(app)/super/(tools)/zzz-inner/page.tsx", "(app)/super/@modal/zzz-slot/page.tsx"]);
    const now = superPageUrls(r);
    expect(now).toContain("/super/zzz-inner");
    expect(now).toContain("/super/zzz-slot");
    // The old walk reported URLs that do not exist.
    expect(legacySuperPageUrls(r)).toContain("/super/(tools)/zzz-inner");
    expect(legacySuperPageUrls(r)).toContain("/super/@modal/zzz-slot");
  });

  it("does not report a non-/super page, nor a URL that merely starts with the letters", () => {
    const r = tree([...BASE, "(app)/superb/page.tsx"]);
    expect(superPageUrls(r)).toEqual(["/super", "/super/health"]);
  });
});

// Fix round 1 (review I2). The proxy rewrites every /super request from a
// caller who is not on the allowlist onto the catch-all PAGE, so a /super
// ROUTE HANDLER it does not exempt would lose its literal 404 and answer a
// streamed 200 instead. Every route handler under /super must be exempt.
describe("the /super refusal rewrite exempts every /super route handler", () => {
  it("each route.* under app/(app)/super is matched by SUPER_ROUTE_HANDLER_PATHS, and no page is", async () => {
    const { readdirSync } = await import("node:fs");
    const { isSuperRouteHandler } = await import("@/lib/supabase/middleware");
    const handlers: string[] = [];
    const pages: string[] = [];
    const walk = (dir: string, url: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const seg = /^\[.*\]$/.test(e.name) ? "00000000-0000-4000-8000-000000000001" : e.name;
          walk(join(dir, e.name), `${url}/${seg}`);
        } else if (/^route\.(ts|js|tsx|jsx)$/.test(e.name)) handlers.push(url);
        else if (/^page\.(tsx|ts|jsx|js|mdx|md)$/.test(e.name)) pages.push(url);
      }
    };
    walk(join(process.cwd(), "app", "(app)", "super"), "/super");
    // DENOMINATOR: the walk sees the one handler that exists today.
    expect(handlers).toContain("/super/feedback/00000000-0000-4000-8000-000000000001/screenshot");
    for (const h of handlers) expect(isSuperRouteHandler(h), h).toBe(true);
    for (const p of pages) expect(isSuperRouteHandler(p), p).toBe(false);
  });
});

// Fix round 2 (re-review N1). Since the proxy rewrite, NO e2e test reaches a
// /super page's own guard as a refused principal: every non-allowlisted
// request is routed to the catch-all before the page runs, so deleting a
// page's isSuperuser() check -- or its generateMetadata() title gate -- would
// leave every refusal test green. The pages' guards are the control and the
// rewrite is parity, so the guards are held here, by source, in CI.
describe("every /super page still carries its own superuser guard", () => {
  const SUPER_DIR = join(process.cwd(), "app", "(app)", "super");
  const CATCH_ALL = join(SUPER_DIR, "[...unknown]", "page.tsx");
  const REFUSED_TITLE = /return\s*\{\s*title:\s*"([^"]+)"\s*\}/;

  /** The text of one top-level function: from its signature to the first
   *  line that is a bare `}` at column 0. */
  function body(source: string, signature: RegExp): string | null {
    const m = signature.exec(source);
    if (!m) return null;
    const rest = source.slice(m.index);
    const end = rest.search(/\n\}\s*(\n|$)/);
    return end === -1 ? rest : rest.slice(0, end);
  }

  async function guardedPages(): Promise<{ file: string; source: string }[]> {
    const { readdirSync, readFileSync } = await import("node:fs");
    const out: { file: string; source: string }[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^page\.(tsx|ts|jsx|js)$/.test(e.name) && p !== CATCH_ALL)
          out.push({ file: p.slice(process.cwd().length + 1), source: readFileSync(p, "utf8") });
      }
    };
    walk(SUPER_DIR);
    return out;
  }

  it("DENOMINATOR: the walk finds every /super page the route census names, less the catch-all", async () => {
    const pages = await guardedPages();
    // SUPER_PAGE_URLS is the nine pages; the catch-all is a non-surface.
    expect(pages.length).toBe(SUPER_PAGE_URLS.length);
  });

  it("each page's default export opens with `if (!(await isSuperuser())) notFound();`", async () => {
    for (const { file, source } of await guardedPages()) {
      const main = body(source, /export default async function \w+\s*\(/);
      expect(main, `${file}: no async default export`).not.toBeNull();
      expect(source, `${file}: isSuperuser is not imported from lib/admin/superuser`).toMatch(
        /import \{[^}]*\bisSuperuser\b[^}]*\} from "@\/lib\/admin\/superuser"/,
      );
      // The FIRST await in the page is the guard: nothing is read before it.
      const firstAwait = /await\s+[\w.]+\(/.exec(main!)?.[0];
      expect(firstAwait, `${file}: the first await in the page is not isSuperuser()`).toMatch(/await\s+isSuperuser\(/);
      expect(main, `${file}: the guard does not notFound()`).toMatch(
        /if \(!\(await isSuperuser\(\)\)\) notFound\(\);/,
      );
    }
  });

  it("each page gates generateMetadata() on isSuperuser() with the catch-all's refused title, and has no static metadata", async () => {
    const { readFileSync } = await import("node:fs");
    const ghostTitle = REFUSED_TITLE.exec(readFileSync(CATCH_ALL, "utf8"))?.[1];
    expect(ghostTitle, "the catch-all's own title").toBe("Not found · GetSetPaid");
    for (const { file, source } of await guardedPages()) {
      expect(source, `${file}: a static metadata export leaks its title into the refusal`).not.toMatch(
        /^export const metadata\b/m,
      );
      const meta = body(source, /export async function generateMetadata\s*\(/);
      expect(meta, `${file}: no generateMetadata()`).not.toBeNull();
      const gate = /if \(!\(await isSuperuser\(\)\)\) return \{ title: "([^"]+)" \};/.exec(meta!);
      expect(gate, `${file}: generateMetadata() is not gated on isSuperuser()`).not.toBeNull();
      expect(gate![1], `${file}: the refused title differs from the catch-all's`).toBe(ghostTitle);
    }
  });
});
