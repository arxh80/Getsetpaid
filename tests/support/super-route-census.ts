// =============================================================================
// PHASE 8 TASK 8 -- THE /super PAGE CENSUS, AS A FUNCTION OF A DIRECTORY
// =============================================================================
// tests/e2e/super-permissions.spec.ts probes every /super page as every wrong
// principal, and its value rests entirely on this census: a page the census
// cannot see is a page no principal is ever walked onto.
//
// THE CENSUS IT REPLACES WALKED `app/(app)/super` FOR FILES NAMED EXACTLY
// `page.tsx`. Next.js does not agree with either half of that:
//
//   - a page may be `page.ts`, `page.jsx`, `page.js` or (with MDX configured)
//     `page.mdx` -- the old walk saw none of them;
//   - ROUTE GROUPS are not part of the URL, so `app/(ops)/super/x/page.tsx`
//     serves `/super/x` exactly as `app/(app)/super/x/page.tsx` does -- and it
//     sits outside the old walk's root entirely;
//   - a route group or parallel-route slot INSIDE /super (`super/(tools)/x`,
//     `super/@modal/x`) put a literal `(tools)` or `@modal` into the URL the
//     old walk reported, which then matched nothing on the list and was red
//     for the wrong reason (or, with the URL copied into the list as-is,
//     green while probing a URL that does not exist).
//
// So this walks the WHOLE app tree, maps each page file to the URL Next would
// serve it at, and keeps the ones under /super. `legacySuperPageUrls()` keeps
// the old derivation, verbatim, so the unit test can measure what it missed.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx|md)$/;

/** A URL path segment is dropped when it is a route group, a parallel-route
 *  slot, or an interception marker's group. */
function urlSegment(dir: string): string | null {
  if (/^\(.*\)$/.test(dir)) return null; // (group) -- and (.)/(..) markers
  if (dir.startsWith("@")) return null; // @slot
  return dir;
}

/** Every page under `appRoot`, as the URL Next serves it at. */
export function pageUrls(appRoot: string): { url: string; file: string }[] {
  const found: { url: string; file: string }[] = [];
  const walk = (dir: string, segments: string[], rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        const seg = urlSegment(entry.name);
        walk(join(dir, entry.name), seg === null ? segments : [...segments, seg], nextRel);
      } else if (PAGE_FILE.test(entry.name)) {
        found.push({ url: `/${segments.join("/")}`.replace(/\/$/, "") || "/", file: `app/${nextRel}` });
      }
    }
  };
  walk(appRoot, [], "");
  return found.sort((a, b) => a.url.localeCompare(b.url) || a.file.localeCompare(b.file));
}

/** Every page Next serves under /super, as URLs, sorted. */
export function superPageUrls(appRoot: string): string[] {
  return [
    ...new Set(
      pageUrls(appRoot)
        .map((p) => p.url)
        .filter((u) => u === "/super" || u.startsWith("/super/")),
    ),
  ].sort();
}

/** THE OLD DERIVATION, verbatim from super-permissions.spec.ts at 781fce4 --
 *  kept only so the unit test can measure what it could not see. */
export function legacySuperPageUrls(appRoot: string): string[] {
  const root = join(appRoot, "(app)", "super");
  const found: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${url}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        found.push(url);
      }
    }
  };
  walk(root, "/super");
  return found.sort();
}

/** The /super URLs the e2e spec probes -- the declared half of the census. */
export const SUPER_PAGE_URLS = [
  "/super",
  "/super/audit-log",
  "/super/billing",
  "/super/data-requests",
  "/super/feedback",
  "/super/health",
  "/super/impersonation",
  "/super/legal",
  "/super/organisations",
] as const;

/**
 * /super page FILES that are not surfaces: nothing renders on them for anybody.
 * The catch-all exists only so a /super URL that matches no page is refused by
 * the same streamed document a refused real page is (Phase 8 Task 8 -- see its
 * own header). Declared here so the census still accounts for every page file.
 */
export const SUPER_NON_SURFACE_URLS = ["/super/[...unknown]"] as const;

