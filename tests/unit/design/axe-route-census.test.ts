import { existsSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";
import {
  AXE_PAGES,
  EXEMPT,
  SCANNED_ELSEWHERE,
} from "../../e2e/support/axe-routes";

// ===========================================================================
// PHASE 10 TASK 15 (G21) -- EVERY UI ROUTE IS SCANNED BY AXE, OR EXEMPT
// ===========================================================================
// 42 pages had never been through axe, and nothing failed when a new page
// shipped unscanned. tests/e2e/support/axe-routes.ts is now the one declared
// list: AXE_PAGES drives the loop in tests/e2e/accessibility.spec.ts,
// SCANNED_ELSEWHERE names the spec whose dedicated test scans a page in a
// state the loop cannot reach, and EXEMPT carries a reason. This census walks
// app/**/page.tsx from disk and asserts the three lists cover every route
// exactly once and name nothing that does not exist.

/** Every page route under app/, route groups mapped away: `/[orgSlug]/contacts`. */
function pageRoutes(dir = "app", prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root + dir)) {
    const rel = `${dir}/${name}`;
    if (statSync(root + rel).isDirectory()) {
      const segment = /^\(.*\)$/.test(name) ? "" : `/${name}`;
      out.push(...pageRoutes(rel, prefix + segment));
    } else if (name === "page.tsx") {
      out.push(prefix || "/");
    }
  }
  return out;
}

/** Routes nobody declared, and declared routes that are not pages. */
export function censusGaps(routes: string[]) {
  const declared = [
    ...AXE_PAGES.map((p) => p.route),
    ...SCANNED_ELSEWHERE.map((p) => p.route),
    ...EXEMPT.map((p) => p.route),
  ];
  return {
    undeclared: routes.filter((r) => !declared.includes(r)).sort(),
    stale: [...new Set(declared)].filter((r) => !routes.includes(r)).sort(),
    duplicated: declared.filter((r, i) => declared.indexOf(r) !== i).sort(),
  };
}

describe("every UI route is scanned by axe or exempt with a reason (G21)", () => {
  const routes = pageRoutes();

  it("finds the pages at all (non-vacuity)", () => {
    expect(routes.length).toBeGreaterThan(80);
    expect(routes).toContain("/[orgSlug]/contacts");
    expect(routes).toContain("/");
  });

  it("every route is declared once, and every declared route exists", () => {
    expect(censusGaps(routes)).toEqual({ undeclared: [], stale: [], duplicated: [] });
  });

  it("a planted page with no scan goes red", () => {
    expect(censusGaps([...routes, "/[orgSlug]/zz"]).undeclared).toContain("/[orgSlug]/zz");
  });

  it("every exemption carries a reason", () => {
    for (const e of EXEMPT) expect(e.reason.length, e.route).toBeGreaterThan(20);
  });

  // shortcut: this proves the named spec exists and runs axe, not that its
  // axe call is on this route; reading Playwright flows statically is not
  // worth it while the list is short enough to review by eye.
  it("a page scanned elsewhere names a spec that really runs axe", () => {
    for (const { route, spec } of SCANNED_ELSEWHERE) {
      const file = `tests/e2e/${spec}`;
      expect(existsSync(root + file), `${route}: ${file}`).toBe(true);
      expect(read(file), `${route}: ${file} has no axe scan`).toMatch(
        /await scan\(|new AxeBuilder/,
      );
    }
  });
});
