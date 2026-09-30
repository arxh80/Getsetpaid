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
