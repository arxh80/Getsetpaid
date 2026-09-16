import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_STORAGE } from "@/lib/legal/storage-inventory";
import { CURRENT_ORG_COOKIE } from "@/lib/org/current-org";
import { activityStorageKey } from "@/lib/auth/idle-timeout";
import { contentSecurityPolicy } from "@/lib/security/headers";

// ===========================================================================
// PHASE 8 TASK 2 -- THE STORAGE CENSUS. NO COOKIE BANNER (Q129), SO THIS IS
// WHAT FORCES THE DECISION THE DAY ONE IS NEEDED.
// ===========================================================================
// Every piece of browser storage GetSetPaid sets today is strictly necessary,
// which PECR exempts from consent. That stays true only while nobody adds a
// cookie, a storage key, a pixel or an analytics loader. This file scans the
// application source for every way code can do any of those, and requires
// every site it finds to be DECLARED below against an item of
// lib/legal/storage-inventory.ts -- the list the public Cookie Policy is
// generated from. So adding analytics is a red test that names the file, and
// the fix is not "add it to an allowlist" but the four things SECURITY.md § 8
// ("Browser storage and consent") says must ship together: consent before
// load, a banner, the inventory entry, and the sub-processor register entry.
//
// WHAT IT SCANS: app/, components/, lib/, proxy.ts and next.config.ts
// (.ts/.tsx/.js/.jsx/.mjs), with comments removed first so a sentence ABOUT
// `document.cookie` is not a write. It looks for:
//   cookie writes     `<x>.cookies.set(`, `<store>.set(` on a store obtained
//                     from `await cookies()`, `document.cookie =`, a
//                     `set-cookie` header, and the Supabase adapter's
//                     `setAll(` (which writes whatever names the library
//                     chooses)
//   Supabase clients  `createBrowserClient(` / `createServerClient(` -- the
//                     library manages the sb-* cookies behind them
//   Web Storage       `localStorage` / `sessionStorage` `.setItem(`, index
//                     assignment and property assignment
//   IndexedDB         `indexedDB`, `IDBFactory`, `IDBDatabase`
//   Cache / SW        `caches.`, `serviceWorker`, `navigator.storage`
//   third parties     `next/script`, a `<script>` or `<iframe>` element,
//                     `createElement('script'|'iframe'|'img')`,
//                     `navigator.sendBeacon`, `new Image(`, a `src` pointing
//                     at an absolute URL
//   trackers          the usual globals and packages (gtag, fbq, dataLayer,
//                     posthog, mixpanel, @vercel/analytics, ...)
// plus: every RUNTIME DEPENDENCY in package.json must be declared with what it
// stores (a library can set storage without any line above), no `public/`
// HTML or script may exist, and the Content-Security-Policy may load scripts
// only from this origin.
//
// WHAT IT CANNOT SEE: what a dependency does at runtime (the declared list is
// a claim, not a measurement), a key built at runtime from data, and anything
// injected outside this repository (a host's analytics toggle, a browser
// extension). The first two are what tests/e2e/storage-census.spec.ts exists
// for -- it reads the storage a real browser holds after a signed-in walk.
// The third is a deployment setting (SECURITY.md § 15).
// ===========================================================================

const ROOT = resolve(__dirname, "../../..");
const SCAN = ["app", "components", "lib", "proxy.ts", "next.config.ts"];
const EXT = /\.(ts|tsx|js|jsx|mjs)$/;

type SiteKind =
  | "cookie-write"
  | "supabase-client"
  | "web-storage-write"
  | "indexeddb"
  | "cache-storage"
  | "third-party"
  | "tracker";

const DETECTORS: readonly { kind: SiteKind; pattern: RegExp }[] = [
  { kind: "cookie-write", pattern: /\.cookies\s*\.\s*set\s*\(/g },
  { kind: "cookie-write", pattern: /\bdocument\s*\.\s*cookie\s*=(?!=)/g },
  { kind: "cookie-write", pattern: /["'`]set-cookie["'`]/gi },
  { kind: "cookie-write", pattern: /\bsetAll\s*\(/g },
  { kind: "supabase-client", pattern: /\bcreate(?:Browser|Server)Client\s*\(/g },
  { kind: "web-storage-write", pattern: /\b(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(/g },
  { kind: "web-storage-write", pattern: /\b(?:localStorage|sessionStorage)\s*\[/g },
  {
    kind: "web-storage-write",
    pattern: /\b(?:localStorage|sessionStorage)\s*\.\s*(?!setItem\b|getItem\b|removeItem\b|clear\b|key\b|length\b)[A-Za-z_$][\w$]*\s*=(?!=)/g,
  },
  { kind: "indexeddb", pattern: /\b(?:indexedDB|IDBFactory|IDBDatabase)\b/g },
  { kind: "cache-storage", pattern: /\bcaches\s*\.|\bserviceWorker\b|\bnavigator\s*\.\s*storage\b/g },
  { kind: "third-party", pattern: /["']next\/script["']/g },
  { kind: "third-party", pattern: /<\s*(?:script|iframe)\b/gi },
  { kind: "third-party", pattern: /\bcreateElement\s*\(\s*["'`](?:script|iframe|img)["'`]/gi },
  { kind: "third-party", pattern: /\bnavigator\s*\.\s*sendBeacon\b/g },
  { kind: "third-party", pattern: /\bnew\s+Image\s*\(/g },
  { kind: "third-party", pattern: /\bsrc\s*=\s*\{?\s*["'`](?:https?:)?\/\//gi },
  {
    kind: "tracker",
    pattern:
      /\b(?:gtag|fbq|_paq|dataLayer|posthog|mixpanel|amplitude|hotjar|plausible|umami)\b|@vercel\/analytics|@vercel\/speed-insights|@next\/third-parties|@segment\/|googletagmanager|google-analytics|clarity\.ms|connect\.facebook\.net/gi,
  },
];

interface Site {
  file: string;
  line: number;
  kind: SiteKind;
  /** First argument of a write, when it has one (the key or cookie name). */
  key: string | null;
  text: string;
}

/**
 * Removes block and line comments, keeping every newline so line numbers stay
 * true. Deliberately simple: a `//` preceded by `:` (a URL) or inside a quote
 * run is left alone. The non-vacuity test below proves it did not eat the
 * real sites.
 */
function stripComments(source: string): string {
  const blocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blocks.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function firstArgument(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(open + 1, i).trim() || null;
      depth--;
    } else if (c === "," && depth === 0) {
      return text.slice(open + 1, i).trim();
    }
  }
  return null;
}

function scanSource(file: string, raw: string): Site[] {
  const text = stripComments(raw);
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const sites: Site[] = [];
  const push = (kind: SiteKind, index: number, match: string, withKey: boolean) => {
    sites.push({
      file,
      line: lineOf(index),
      kind,
      key: withKey ? firstArgument(text, index + match.length - 1) : null,
      text: match.trim(),
    });
  };
  for (const { kind, pattern } of DETECTORS) {
    for (const m of text.matchAll(pattern)) {
      const withKey =
        (kind === "cookie-write" && /set\s*\($/.test(m[0]) && !/setAll/.test(m[0])) ||
        (kind === "web-storage-write" && /setItem\s*\($/.test(m[0]));
      push(kind, m.index!, m[0], withKey);
    }
  }
  // `<store>.set(` where `<store>` came from `await cookies()`.
  // A name declared twice (two functions, one `store` each) is one store.
  const stores = new Set(
    [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cookies\s*\(\s*\)/g)].map(
      (decl) => decl[1],
    ),
  );
  for (const store of stores) {
    for (const m of text.matchAll(new RegExp(`\\b${store.replace(/\$/g, "\\$")}\\s*\\.\\s*set\\s*\\(`, "g"))) {
      push("cookie-write", m.index!, m[0], true);
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (EXT.test(entry)) {
      out.push(full);
    }
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const target of SCAN) {
    const full = join(ROOT, target);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, "/");
}

function scanTree(): Site[] {
  return sourceFiles().flatMap((f) => scanSource(rel(f), readFileSync(f, "utf8")));
}

// ===========================================================================
// THE DECLARATION. Every site the scan finds must be here, with its count,
// the inventory item it produces, and (for a write that names its key) the
// exact key expression. Adding a line here is the reviewable act; the
// inventory item it names is what the Cookie Policy shows the public.
// ===========================================================================

const SUPABASE_ITEM = BROWSER_STORAGE[0].name;

interface DeclaredSite {
  file: string;
  kind: SiteKind;
  count: number;
  /** The BROWSER_STORAGE name this site produces. */
  covers: string;
  /** The first-argument expressions, in source order, for keyed writes. */
  keys?: readonly string[];
  why: string;
}

const DECLARED: readonly DeclaredSite[] = [
  {
    file: "lib/org/current-org.ts",
    kind: "cookie-write",
    count: 1,
    covers: CURRENT_ORG_COOKIE,
    keys: ["CURRENT_ORG_COOKIE"],
    why: "writeCurrentOrgIdCookie() -- the remembered workspace",
  },
  {
    file: "lib/supabase/server.ts",
    kind: "cookie-write",
    count: 2,
    covers: SUPABASE_ITEM,
    keys: ["name"],
    why: "the @supabase/ssr adapter: setAll() writes the names the library chooses (sb-*)",
  },
  {
    file: "lib/supabase/server.ts",
    kind: "supabase-client",
    count: 1,
    covers: SUPABASE_ITEM,
    why: "the server client; its session lives in the sb-* cookies",
  },
  {
    file: "lib/supabase/middleware.ts",
    kind: "cookie-write",
    count: 4,
    covers: SUPABASE_ITEM,
    keys: ["name", "name", "cookie"],
    why:
      "the session refresh: setAll() onto the request and the response, and copyCookies() moving " +
      "those same cookies onto a redirect",
  },
  {
    file: "lib/supabase/middleware.ts",
    kind: "supabase-client",
    count: 1,
    covers: SUPABASE_ITEM,
    why: "the proxy's client, which refreshes the sb-* session cookies",
  },
  {
    file: "lib/supabase/client.ts",
    kind: "supabase-client",
    count: 1,
    covers: SUPABASE_ITEM,
    why: "the browser client; @supabase/ssr stores its session in the same sb-* cookies (document.cookie inside the library)",
  },
  {
    file: "components/nav/sidebar.tsx",
    kind: "web-storage-write",
    count: 1,
    covers: "gsp:sidebar-pinned",
    keys: ["PIN_STORAGE_KEY"],
    why: "the pin control",
  },
  {
    file: "components/auth/idle-timeout.tsx",
    kind: "web-storage-write",
    count: 1,
    covers: activityStorageKey("<your account id>"),
    keys: ["storageKey"],
    why: "the cross-tab idle timer (storageKey = activityStorageKey(userId))",
  },
];

/**
 * Every runtime dependency, with what it stores in a browser. A library can
 * set storage without a single line the scan above would see, so a new one is
 * a declaration somebody has to make -- and the browser census is what
 * checks the declaration.
 */
const RUNTIME_DEPENDENCIES: Record<string, string> = {
  "@supabase/ssr": "the sb-* auth cookies (declared) -- nothing else",
  "@supabase/supabase-js": "nothing of its own: the browser client is created through @supabase/ssr, whose cookie storage replaces the localStorage default",
  "framer-motion": "nothing",
  "lucide-react": "nothing (inline SVG icons)",
  next: "nothing the app enables (no draft mode, no i18n locale cookie)",
  react: "nothing",
  "react-dom": "nothing",
  "server-only": "nothing (a build-time guard)",
};

function key(site: { file: string; kind: SiteKind }): string {
  return `${site.file} :: ${site.kind}`;
}

describe("the storage census (Phase 8 Task 2, Q129)", () => {
  const sites = scanTree();

  it("NON-VACUITY: the scan finds every declared site, so a pass below is not a scan of nothing", () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
    for (const declared of DECLARED) {
      const found = sites.filter((s) => key(s) === key(declared));
      expect(found.length, `${key(declared)} -- the scan no longer sees it`).toBeGreaterThan(0);
    }
    // And the four inventory items are all produced by some declared site.
    const covered = new Set(DECLARED.map((d) => d.covers));
    for (const item of BROWSER_STORAGE) expect(covered, item.name).toContain(item.name);
  });

  it("every cookie, storage, script and tracker site in the source is declared, with its count", () => {
    const counts = new Map<string, Site[]>();
    for (const s of sites) counts.set(key(s), [...(counts.get(key(s)) ?? []), s]);
    const undeclared = [...counts.entries()]
      .filter(([k, found]) => {
        const d = DECLARED.find((x) => key(x) === k);
        return !d || d.count !== found.length;
      })
      .map(([k, found]) => `${k} x${found.length}: ${found.map((f) => `line ${f.line} \`${f.text}\``).join(", ")}`);
    expect(
      undeclared,
      "A cookie, browser-storage key, IndexedDB/Cache use, third-party script or tracker appeared " +
        "that storage-census.test.ts does not declare. If it is strictly necessary, declare it here " +
        "AND add it to lib/legal/storage-inventory.ts (the Cookie Policy). If it is not -- analytics, " +
        "a pixel, an embed -- it needs consent BEFORE it loads, a banner, the inventory entry and a " +
        "sub-processor entry, together (SECURITY.md § 8, 'Browser storage and consent'; Q129).",
    ).toEqual([]);
    // The other direction: a declaration whose site is gone is stale.
    for (const d of DECLARED) {
      expect(counts.get(key(d))?.length ?? 0, `${key(d)} is declared x${d.count}`).toBe(d.count);
    }
  });

  it("keyed writes use exactly the declared key expressions", () => {
    for (const d of DECLARED.filter((x) => x.keys)) {
      const found = sites
        .filter((s) => key(s) === key(d) && s.key !== null)
        .map((s) => s.key);
      expect(found, key(d)).toEqual([...d.keys!]);
    }
  });

  it("a literal key anywhere must match an inventory item", () => {
    const literals = sites
      .map((s) => ({ s, lit: /^["'`]([^"'`$]*)["'`]$/.exec(s.key ?? "")?.[1] }))
      .filter((x): x is { s: Site; lit: string } => x.lit !== undefined);
    const unmatched = literals
      .filter(({ lit }) => !BROWSER_STORAGE.some((item) => item.matches.test(lit)))
      .map(({ s, lit }) => `${s.file}:${s.line} "${lit}"`);
    expect(unmatched, "a literal cookie/storage key that no inventory item covers").toEqual([]);
  });

  it("every declared site covers a real inventory item, and each key resolves to it", () => {
    const names = BROWSER_STORAGE.map((i) => i.name);
    for (const d of DECLARED) expect(names, key(d)).toContain(d.covers);
    const covers = (name: string, value: string) =>
      BROWSER_STORAGE.find((i) => i.name === name)!.matches.test(value);

    // The key constants, resolved from source rather than restated here.
    expect(covers(CURRENT_ORG_COOKIE, CURRENT_ORG_COOKIE)).toBe(true);
    const sidebar = readFileSync(join(ROOT, "components/nav/sidebar.tsx"), "utf8");
    const pin = /const PIN_STORAGE_KEY = "([^"]+)";/.exec(sidebar)?.[1];
    expect(pin).toBeTruthy();
    expect(covers("gsp:sidebar-pinned", pin!)).toBe(true);
    const idle = readFileSync(join(ROOT, "components/auth/idle-timeout.tsx"), "utf8");
    expect(idle).toMatch(/const storageKey = activityStorageKey\(userId\);/);
    const someUser = "0b7e6f4e-6a55-4d7e-9d2a-1f3c2b1a0e9d";
    expect(covers(activityStorageKey("<your account id>"), activityStorageKey(someUser))).toBe(true);
    // A Supabase session cookie as the library names it on this stack, and a chunk.
    expect(covers(SUPABASE_ITEM, "sb-127-auth-token")).toBe(true);
    expect(covers(SUPABASE_ITEM, "sb-abcdefghijklmnopqrst-auth-token.1")).toBe(true);
    expect(covers(SUPABASE_ITEM, "sb-127-auth-token-code-verifier")).toBe(true);
    // ...and the patterns are not so loose that they cover anything.
    for (const stranger of ["_ga", "gsp:new-key", "sb-127-analytics", "gsp_current_org2", "ajs_anonymous_id"]) {
      expect(BROWSER_STORAGE.some((i) => i.matches.test(stranger)), stranger).toBe(false);
    }
  });

  it("every runtime dependency is declared with what it stores", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(
      Object.keys(pkg.dependencies ?? {}).sort(),
      "a runtime dependency was added or removed. Declare what it stores in a browser in " +
        "RUNTIME_DEPENDENCIES (and prove it in tests/e2e/storage-census.spec.ts); an analytics or " +
        "tracking package needs the consent work in SECURITY.md § 8 first.",
    ).toEqual(Object.keys(RUNTIME_DEPENDENCIES).sort());
  });

  it("no static HTML or script is served from public/", () => {
    const dir = join(ROOT, "public");
    const files: string[] = [];
    if (existsSync(dir)) walk(dir, files);
    const html = existsSync(dir)
      ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(html?|js|mjs)$/i.test(f))
      : [];
    expect([...files.map(rel), ...html]).toEqual([]);
  });

  it("the Content-Security-Policy loads scripts, frames and beacons from nowhere but this origin", () => {
    const csp = contentSecurityPolicy("census-nonce");
    const directive = (name: string) =>
      csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toBeTruthy();
    expect(directive("script-src")).not.toMatch(/https?:|\*/);
    expect(directive("frame-src")).toBe("frame-src 'none'");
    expect(directive("img-src")).not.toMatch(/https?:|\*/);
    // connect-src may name the Supabase API and nothing else.
    for (const source of directive("connect-src").split(/\s+/).slice(1)) {
      expect(source, "connect-src names a host other than this origin and Supabase").toMatch(
        /^'self'$|^(https?|wss?):\/\/(127\.0\.0\.1|localhost|[a-z0-9-]+\.supabase\.co)(:\d+)?$/,
      );
    }
  });
});

// ===========================================================================
// THE DETECTOR HAS TEETH -- the mutations the brief names, run against the
// scanner itself on every run, so the proof does not live only in a report.
// (The same two were also applied to the real tree once and reverted; see
// task-2-report.md.)
// ===========================================================================
describe("the census detector", () => {
  it("sees a new localStorage key, and the key is not an inventory item", () => {
    const found = scanSource(
      "components/fake.tsx",
      `export function F() { window.localStorage.setItem("gsp:new-key", "1"); return null; }`,
    );
    expect(found.map((s) => [s.kind, s.key])).toEqual([["web-storage-write", '"gsp:new-key"']]);
    expect(BROWSER_STORAGE.some((i) => i.matches.test("gsp:new-key"))).toBe(false);
  });

  it("sees a next/script analytics loader three ways: the import, the element, the absolute src", () => {
    const found = scanSource(
      "app/fake.tsx",
      `import Script from "next/script";\nexport default function L() { return <Script src="https://analytics.example/a.js" />; }`,
    );
    expect(found.map((s) => s.text)).toEqual(['"next/script"', "<Script", 'src="https://']);
    expect(new Set(found.map((s) => s.kind))).toEqual(new Set(["third-party"]));
  });

  it("sees the other shapes", () => {
    const shapes: [string, SiteKind][] = [
      [`document.cookie = "x=1"`, "cookie-write"],
      [`res.cookies.set("x", "1")`, "cookie-write"],
      [`const jar = await cookies(); jar.set("x", "1");`, "cookie-write"],
      [`headers.append("Set-Cookie", v)`, "cookie-write"],
      [`sessionStorage["k"] = "v"`, "web-storage-write"],
      [`localStorage.k = "v"`, "web-storage-write"],
      [`indexedDB.open("db")`, "indexeddb"],
      [`caches.open("c")`, "cache-storage"],
      [`navigator.serviceWorker.register("/sw.js")`, "cache-storage"],
      [`const s = document.createElement("script")`, "third-party"],
      [`<iframe src="/x" />`, "third-party"],
      [`navigator.sendBeacon("/b")`, "third-party"],
      [`new Image(1, 1)`, "third-party"],
      [`<img src="https://pixel.example/p.gif" />`, "third-party"],
      [`window.gtag("event")`, "tracker"],
      [`import posthog from "posthog-js"`, "tracker"],
      [`import { Analytics } from "@vercel/analytics/react"`, "tracker"],
    ];
    for (const [source, kind] of shapes) {
      expect(scanSource("x.tsx", source).map((s) => s.kind), source).toContain(kind);
    }
  });

  it("ignores what is only said in a comment, and reads (not writes) storage", () => {
    const quiet = [
      `// document.cookie = "x"`,
      `/* localStorage.setItem("k", "v") <script> */`,
      `const v = window.localStorage.getItem(KEY); window.localStorage.removeItem(KEY);`,
      `const url = "https://example.com"; // a URL is not a comment`,
      `const c = store.get("x");`,
    ];
    for (const source of quiet) expect(scanSource("x.tsx", source), source).toEqual([]);
  });
});
