import { expect, test, type Page } from "@playwright/test";
import { BROWSER_STORAGE, type StorageKind } from "../../lib/legal/storage-inventory";
import { localStack, setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 2: WHAT A REAL BROWSER ACTUALLY HOLDS IS WHAT THE COOKIE
// POLICY SAYS (Q129 -- no banner, so this is part of what keeps that true).
//
// tests/unit/legal/storage-census.test.ts reads the SOURCE. It cannot see what
// a library sets at runtime, or a key built from data. This walks the signed-in
// product the way a person does, then reads every cookie the browser context
// holds (for EVERY domain, not only the app and the API -- a third-party
// cookie would be on neither), every localStorage and sessionStorage key,
// every IndexedDB database, every Cache Storage entry and every service
// worker, and requires each to match an item of lib/legal/storage-inventory.ts
// OF THE SAME KIND -- the list the public Cookie Policy is generated from. It
// also records every request the whole browser CONTEXT made (so a service
// worker's or a popup's requests count, not only the page's) and every
// Content-Security-Policy violation, and requires each to stay on this app or
// the Supabase API: a pixel, a font CDN or an analytics beacon would be a
// third party the policy does not name.
//
// THE DENOMINATOR IS PROVED FIRST. "Nothing undeclared is present" passes
// trivially in a browser that holds nothing, so the four declared items are
// each asserted PRESENT before the subset check -- the walk is built to
// produce all four (sign in; open a workspace; pin the rail; be active) --
// and the CSP-violation listener is proved to hear a load the CSP blocks.
//
// WHAT THIS CANNOT SEE (review finding M5, stated rather than implied):
//   * code paths the walk does not reach;
//   * violations a worker reports to itself (the listener is on documents);
//     note, MEASURED in fix round 1: Chromium DOES emit a Playwright request
//     event for a CSP-blocked image (the probe below appears in `hosts`), so
//     the host check already sees blocked loads of that kind -- the listener
//     is a second layer for loads that never reach the network stack;
//   * storage only a PRODUCTION build or the hosting provider sets: this suite
//     always runs `next dev` (`pnpm build` is forbidden here), Q153;
//   * and it does not run in CI (e2e needs a running stack).

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

interface BrowserStorage {
  local: string[];
  session: string[];
  indexedDb: string[];
  /** Whether `indexedDB.databases()` EXISTS here. A capability miss used to
   *  collapse to [] with nothing recording that the probe was blind. */
  indexedDbApi: boolean;
  caches: string[];
  /** Whether Cache Storage exists here -- the same asymmetry. */
  cachesApi: boolean;
  serviceWorkerApi: boolean;
  serviceWorkers: string[];
}

async function readStorage(page: Page): Promise<BrowserStorage> {
  return page.evaluate(async () => {
    const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i) ?? "");
    // CENSUS AUDIT, FINDING 14. These two used to collapse to [] on a
    // capability miss, with nothing recording that the probe was blind, while
    // the service-worker line one row below returned its capability as a
    // boolean and pinned it. `indexedDB.databases()` is not implemented in
    // Firefox, and `caches` is absent outside a secure context -- so the day
    // this runs on a second Playwright project, or the base URL stops being
    // localhost, "the product declares no IndexedDB database" and "no Cache
    // Storage" would pass green over an UNREAD subject. The fix was already
    // demonstrated one line below the bug.
    const indexedDbApi = typeof indexedDB !== "undefined" && "databases" in indexedDB;
    const idb = indexedDbApi ? (await indexedDB.databases()).map((d) => d.name ?? "") : [];
    const cachesApi = typeof caches !== "undefined";
    const cacheNames = cachesApi ? await caches.keys() : [];
    const serviceWorkerApi = "serviceWorker" in navigator;
    const registrations = serviceWorkerApi ? await navigator.serviceWorker.getRegistrations() : [];
    return {
      local: keys(window.localStorage),
      session: keys(window.sessionStorage),
      indexedDb: idb,
      indexedDbApi,
      caches: cacheNames,
      cachesApi,
      serviceWorkerApi,
      serviceWorkers: registrations.map((r) => r.scope),
    };
  });
}

const declared = (name: string, kind: StorageKind) =>
  BROWSER_STORAGE.some((item) => item.kind === kind && item.matches.test(name));
const itemFor = (label: string) => {
  const item = BROWSER_STORAGE.find((i) => i.name.startsWith(label));
  if (!item) throw new Error(`no inventory item starting ${label}`);
  return item;
};

interface CspViolation {
  blockedURI: string;
  directive: string;
}

test("after a signed-in walk, every cookie and storage key the browser holds is on the Cookie Policy, and no third party was contacted", async ({
  page,
  context,
}) => {
  const app = new URL(test.info().project.use.baseURL ?? "http://localhost:3000");
  const api = new URL(localStack().apiUrl);
  const hosts = new Set<string>();
  // The CONTEXT's requests: the page's, any popup's and any worker's.
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
      hosts.add(url.host);
    }
  });
  // A second layer: what the CSP blocked, as the page reports it.
  const violations: CspViolation[] = [];
  await context.exposeBinding("__gspCspViolation", (_source, v: CspViolation) => {
    violations.push(v);
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __gspCspViolation: (v: CspViolation) => void }).__gspCspViolation({
        blockedURI: e.blockedURI,
        directive: e.effectiveDirective,
      });
    });
  });

  // ---- THE WALK ------------------------------------------------------------
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  const pin = page.getByRole("button", { name: "Pin navigation open" });
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await page.goto(`/${world.orgSlug}/contacts`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.mouse.move(200, 200);
  await page.keyboard.press("Shift");
  await page.goto("/account/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy and communications" })).toBeVisible();
  await page.goto("/legal/cookies");
  await expect(page.getByRole("heading", { level: 1, name: "Cookie Policy" })).toBeVisible();
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("button", { name: "Pin navigation open" })).toHaveAttribute("aria-pressed", "true");

  // ---- READ WHAT THE BROWSER HOLDS -----------------------------------------
  const cookies = await context.cookies(); // every domain, not a chosen list
  const cookieNames = [...new Set(cookies.map((c) => c.name))].sort();
  const storage = await readStorage(page);

  // ---- DENOMINATOR: each declared item is actually present -----------------
  const auth = itemFor("sb-");
  expect(
    cookieNames.filter((n) => auth.matches.test(n)),
    `the Supabase session cookie is missing; the browser holds: ${cookieNames.join(", ")}`,
  ).not.toEqual([]);
  expect(cookieNames, "the workspace cookie was not set by opening a workspace").toContain("gsp_current_org");
  expect(storage.local, "the idle-timeout key is missing").toContain(`gsp:last-activity-at:${world.users.manager.id}`);
  expect(storage.local, "the pinned-rail key is missing").toContain("gsp:sidebar-pinned");
  expect(storage.serviceWorkerApi, "DENOMINATOR: the service worker API exists here, so 'none registered' means something").toBe(true);
  expect(
    storage.indexedDbApi,
    "DENOMINATOR: indexedDB.databases() exists here, so 'no IndexedDB database' means something. " +
      "It does NOT exist in Firefox -- the day this suite runs on a second project, this line is " +
      "what says so instead of the census quietly passing over an unread subject.",
  ).toBe(true);
  expect(
    storage.cachesApi,
    "DENOMINATOR: Cache Storage exists here, so 'no Cache Storage' means something. It is absent " +
      "outside a secure context, which a changed base URL is enough to cause.",
  ).toBe(true);
  // ...and the workspace cookie really is unreadable by page scripts, as the
  // policy says.
  expect(cookies.find((c) => c.name === "gsp_current_org")?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("gsp_current_org");

  // ---- THE CENSUS ----------------------------------------------------------
  const localDomains = new Set([app.hostname, api.hostname]);
  expect(
    cookies.filter((c) => !localDomains.has(c.domain.replace(/^\./, ""))).map((c) => `${c.domain} ${c.name}`),
    "the browser holds a cookie for a domain that is neither this app nor its Supabase API -- a third-party cookie",
  ).toEqual([]);
  expect(
    cookieNames.filter((n) => !declared(n, "cookie")),
    "the browser holds a cookie the Cookie Policy does not declare (lib/legal/storage-inventory.ts). " +
      "Strictly necessary: declare it. Anything else: consent before it is set (SECURITY.md § 8).",
  ).toEqual([]);
  expect(
    storage.local.filter((k) => !declared(k, "local-storage")),
    "the browser holds a localStorage key the Cookie Policy does not declare as local storage",
  ).toEqual([]);
  expect(storage.session, "the product declares no sessionStorage, and something set some").toEqual([]);
  // Next.js 15/16.0 dev clients opened an IndexedDB database `__next_debug_channel`,
  // excused here while provably dev tooling. Next 16.4 opens none (no client file
  // mentions IndexedDB, checked 2026-10-26), so there is no excuse left to make.
  expect(storage.indexedDb, "the product declares no IndexedDB database, and one exists").toEqual([]);
  expect(storage.caches, "the product declares no Cache Storage, and an entry exists").toEqual([]);
  expect(storage.serviceWorkers, "the product registers no service worker, and one is registered").toEqual([]);
  expect(context.serviceWorkers().map((w) => w.url()), "a service worker is running in this context").toEqual([]);

  // ---- NO THIRD PARTY ------------------------------------------------------
  expect(hosts, "DENOMINATOR: the walk made requests to the app").toContain(app.host);
  expect(
    [...hosts].filter((h) => h !== app.host && h !== api.host).sort(),
    "the browser contacted a host that is neither this app nor its Supabase API -- a third party " +
      "the Cookie Policy and the sub-processor list do not name",
  ).toEqual([]);

  // ---- NOTHING A THIRD PARTY TRIED WAS MERELY BLOCKED ----------------------
  // POSITIVE CONTROL FIRST: a load the CSP blocks is heard by the listener.
  const probe = "https://csp-probe.invalid/pixel.gif";
  const probeHost = "csp-probe.invalid";
  const hostOf = (uri: string) => (/^(https?|wss?):/.test(uri) ? new URL(uri).host : null);
  await page.evaluate((src) => {
    const img = new Image();
    img.src = src;
    document.body.appendChild(img);
  }, probe);
  await expect
    .poll(() => violations.some((v) => hostOf(v.blockedURI) === probeHost), {
      message: "the CSP-violation listener did not hear a blocked load -- the check below would prove nothing",
    })
    .toBe(true);
  const thirdPartyViolations = violations
    .filter((v) => {
      const host = hostOf(v.blockedURI);
      return host !== null && host !== probeHost && host !== app.host && host !== api.host;
    })
    .map((v) => `${v.directive} ${v.blockedURI}`);
  expect(
    thirdPartyViolations,
    "something on the walk tried to load a third-party resource and the CSP blocked it -- the code that " +
      "tried is the finding, even though the load failed",
  ).toEqual([]);
});
