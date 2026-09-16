import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BROWSER_STORAGE } from "../../lib/legal/storage-inventory";
import { localStack, setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 2: WHAT A REAL BROWSER ACTUALLY HOLDS IS WHAT THE COOKIE
// POLICY SAYS (Q129 -- no banner, so this is part of what keeps that true).
//
// tests/unit/legal/storage-census.test.ts reads the SOURCE. It cannot see what
// a library sets at runtime, or a key built from data. This walks the signed-in
// product the way a person does, then reads every cookie the browser holds for
// the app and for the Supabase API, every localStorage and sessionStorage key,
// every IndexedDB database and every Cache Storage entry, and requires each to
// match an item of lib/legal/storage-inventory.ts -- the list the public Cookie
// Policy is generated from. It also records every request the page made and
// requires each to go to this app or the Supabase API: a pixel, a font CDN or
// an analytics beacon would be a third party the policy does not name.
//
// THE DENOMINATOR IS PROVED FIRST. "Nothing undeclared is present" passes
// trivially in a browser that holds nothing, so the four declared items are
// each asserted PRESENT before the subset check -- the walk is built to
// produce all four (sign in; open a workspace; pin the rail; be active).

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
  caches: string[];
}

async function readStorage(page: Page): Promise<BrowserStorage> {
  return page.evaluate(async () => {
    const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i) ?? "");
    const idb =
      typeof indexedDB !== "undefined" && "databases" in indexedDB
        ? (await indexedDB.databases()).map((d) => d.name ?? "")
        : [];
    const cacheNames = typeof caches !== "undefined" ? await caches.keys() : [];
    return {
      local: keys(window.localStorage),
      session: keys(window.sessionStorage),
      indexedDb: idb,
      caches: cacheNames,
    };
  });
}

/**
 * FOUND BY THIS SPEC ON ITS FIRST RUN, and not visible to the source census:
 * Next.js's DEVELOPMENT client opens an IndexedDB database named
 * `__next_debug_channel` (node_modules/next/dist/client/dev/debug-channel.js).
 * This suite always runs against `next dev`, so it is excused HERE ONLY, and
 * only while it is provably development tooling: the test below asserts the
 * name appears in no production server runtime Next ships. The day it does,
 * the excuse is void and it is a real, undeclared storage item.
 */
const DEV_ONLY_INDEXED_DB = "__next_debug_channel";

function productionRuntimesMention(name: string): string[] {
  const require = createRequire(__filename);
  const nextDir = dirname(require.resolve("next/package.json"));
  const runtimes = join(nextDir, "dist", "compiled", "next-server");
  const files = readdirSync(runtimes);
  const prod = files.filter((f) => f.endsWith(".prod.js"));
  const dev = files.filter((f) => f.endsWith(".dev.js"));
  if (prod.length === 0) throw new Error("no production runtimes found -- the check below would prove nothing");
  // POSITIVE CONTROL: the search finds the name where it does live.
  if (!dev.some((f) => readFileSync(join(runtimes, f), "utf8").includes(name))) {
    throw new Error(`${name} is in no DEVELOPMENT runtime either -- the search is not finding what it looks for`);
  }
  return prod.filter((f) => readFileSync(join(runtimes, f), "utf8").includes(name));
}

const declared = (name: string) => BROWSER_STORAGE.some((item) => item.matches.test(name));
const itemFor = (label: string) => {
  const item = BROWSER_STORAGE.find((i) => i.name.startsWith(label));
  if (!item) throw new Error(`no inventory item starting ${label}`);
  return item;
};

test("after a signed-in walk, every cookie and storage key the browser holds is on the Cookie Policy, and no third party was contacted", async ({
  page,
  context,
}) => {
  const app = new URL(test.info().project.use.baseURL ?? "http://localhost:3000");
  const api = new URL(localStack().apiUrl);
  const hosts = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
      hosts.add(url.host);
    }
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
  const cookies = await context.cookies([app.origin, api.origin]);
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
  // ...and the workspace cookie really is unreadable by page scripts, as the
  // policy says.
  expect(cookies.find((c) => c.name === "gsp_current_org")?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("gsp_current_org");

  // ---- THE CENSUS ----------------------------------------------------------
  expect(
    cookieNames.filter((n) => !declared(n)),
    "the browser holds a cookie the Cookie Policy does not declare (lib/legal/storage-inventory.ts). " +
      "Strictly necessary: declare it. Anything else: consent before it is set (SECURITY.md § 8).",
  ).toEqual([]);
  expect(
    storage.local.filter((k) => !declared(k)),
    "the browser holds a localStorage key the Cookie Policy does not declare",
  ).toEqual([]);
  expect(storage.session, "the product declares no sessionStorage, and something set some").toEqual([]);
  expect(productionRuntimesMention(DEV_ONLY_INDEXED_DB), "the dev-only IndexedDB name is in a PRODUCTION runtime").toEqual([]);
  expect(
    storage.indexedDb.filter((n) => n !== DEV_ONLY_INDEXED_DB),
    "the product declares no IndexedDB database, and one exists",
  ).toEqual([]);
  expect(storage.caches, "the product declares no Cache Storage, and an entry exists").toEqual([]);

  // ---- NO THIRD PARTY ------------------------------------------------------
  expect(hosts, "DENOMINATOR: the walk made requests to the app").toContain(app.host);
  expect(
    [...hosts].filter((h) => h !== app.host && h !== api.host).sort(),
    "the page contacted a host that is neither this app nor its Supabase API -- a third party " +
      "the Cookie Policy and the sub-processor list do not name",
  ).toEqual([]);
});
