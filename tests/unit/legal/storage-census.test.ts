import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { BROWSER_STORAGE } from "@/lib/legal/storage-inventory";
import { CURRENT_ORG_COOKIE } from "@/lib/org/current-org";
import { activityStorageKey } from "@/lib/auth/idle-timeout";
import { contentSecurityPolicy } from "@/lib/security/headers";
import {
  NON_SHIPPED_ROOT_DIRS,
  REPO_ROOT as ROOT,
  appSourceFiles,
  existingEntryPoints,
  importsServerOnly,
  isClientModule,
  isServerActionModule,
  moduleReferences,
  namesModule,
  parse,
  parseProblems,
  relPath,
  resolveSpecifier,
} from "../support/app-source";
import { collectCookieReExports, scanSource, type Site, type SiteKind } from "./storage-scanner";

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
// WHAT IT SCANS: every app-shipped script file in the repository, derived
// rather than listed (tests/unit/support/app-source.ts: everything outside
// node_modules, .next, the root dot-directories, tests/, supabase/, scripts/
// and test output), parsed with the TypeScript compiler -- so a comment is not
// a site, a `//` inside a string does not hide the rest of the line, and an
// aliased import, a destructured method, `?.` or a bracketed global is still
// followed. tests/unit/legal/storage-scanner.ts lists exactly which shapes it
// recognises and which it cannot see. Before fix round 1 it scanned five
// named folders with regexes and missed `(await cookies()).set(...)` -- the
// shape Next 15/16 actually writes -- and everything in a root
// `instrumentation-client.ts`; each evasion the review measured is now a
// fixture in "the census detector" below, run on every CI build.
// Plus: every RUNTIME DEPENDENCY in package.json must be declared with what it
// stores (a library can set storage without any line above), no `public/`
// HTML or script may exist, and the Content-Security-Policy may name no
// script, frame or image host (see that test for what it does NOT prove).
//
// WHAT IT CANNOT SEE: what a dependency does at runtime (the declared list is
// a claim, not a measurement), a key built at runtime from data, a store
// reached through a value the file did not create, and anything injected
// outside this repository (a host's analytics toggle, a browser extension).
// The first three are what tests/e2e/storage-census.spec.ts exists for -- it
// reads the storage a real browser holds after a signed-in walk -- and that
// spec runs only on a developer machine: e2e is not in CI. The last is a
// deployment setting (SECURITY.md § 15).
// ===========================================================================

/** Every scanned file, read once: the scan, the parse check and the graph all use it. */
function readTree(): { file: string; text: string }[] {
  return appSourceFiles().map((f) => ({ file: relPath(f), text: readFileSync(f, "utf8") }));
}

function scanTree(): Site[] {
  const tree = readTree();
  // The whole set, so a `cookies` re-exported by one module and called in
  // another is followed across the two (re-review N1).
  const cookieExports = collectCookieReExports(tree);
  return tree.flatMap(({ file, text }) => scanSource(file, text, { cookieExports }));
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
  /**
   * The BROWSER_STORAGE name this site produces, or null for a site that runs
   * only on the server and so sets nothing in a browser -- allowed only in a
   * module that imports "server-only" (asserted below).
   */
  covers: string | null;
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
    count: 5,
    covers: SUPABASE_ITEM,
    keys: ["name", "name", "key", "cookie"],
    why:
      "the session refresh: setAll() onto the request and the response, the loop that copies the " +
      "cache headers Supabase hands us alongside them (a header name from a variable -- it is this " +
      "loop's own `key`, and the census flags any non-constant header name because one could be " +
      "Set-Cookie, re-review N1), and copyCookies() moving those same cookies onto a redirect",
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
  // ---- server-only sites: they set nothing in a browser ----------------------
  {
    file: "lib/supabase/admin.ts",
    kind: "supabase-client",
    count: 1,
    covers: null,
    why: "the service-role Admin API client (no persisted session); server-only",
  },
  {
    file: "lib/supabase/service.ts",
    kind: "supabase-client",
    count: 1,
    covers: null,
    why: "the service-role table client for the two email senders; server-only",
  },
  {
    file: "lib/supabase/storage.ts",
    kind: "supabase-client",
    count: 1,
    covers: null,
    why: "the service-role Storage client for the private buckets; server-only",
  },
  {
    file: "lib/email/send.ts",
    kind: "third-party",
    count: 1,
    covers: null,
    keys: ["BREVO_ENDPOINT"],
    why: "the one Brevo HTTP call, made from the server (docs/sub-processors.md lists Brevo)",
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

describe("the scanned file set is derived, so a new root file or folder cannot be missed", () => {
  it("includes every entry point Next loads by convention that exists here, and a real volume of files", () => {
    const files = appSourceFiles().map((f) => relPath(f));
    expect(files.length).toBeGreaterThan(400);
    const entries = existingEntryPoints();
    // proxy.ts, next.config.ts and app/layout.tsx exist today; the others
    // (instrumentation-client.ts, instrumentation.ts, middleware.ts) are in the
    // set the day they are created -- the fixture below proves that.
    for (const must of ["proxy.ts", "next.config.ts", "app/layout.tsx"]) expect(entries).toContain(must);
    for (const entry of entries) expect(files).toContain(entry);
    // Every script file at the repository root is scanned.
    const rootScripts = readdirSync(ROOT).filter(
      (f) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(f) && !f.endsWith(".d.ts"),
    );
    expect(rootScripts.length).toBeGreaterThan(2);
    for (const f of rootScripts) expect(files).toContain(f);
    // ...and nothing from the excluded places leaks in.
    expect(files.filter((f) => /^(tests|supabase|scripts|node_modules|\.next|\.claude|\.superpowers)\//.test(f))).toEqual(
      [],
    );
  });

  it("FIXTURE: a root instrumentation-client.ts and a new hooks/ folder are scanned; tests/ and node_modules are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsp-census-"));
    try {
      const write = (rel: string, text: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      };
      write("instrumentation-client.ts", `localStorage.setItem("_ga", "1");`);
      write("hooks/use-thing.ts", `export const x = 1;`);
      write("app/.well-known/route.ts", `export const y = 1;`);
      write("tests/a.test.ts", `localStorage.setItem("t", "1");`);
      write("node_modules/pkg/index.js", `localStorage.setItem("n", "1");`);
      write("app/node_modules/pkg/index.js", `x`);
      write(".claude/x.ts", `x`);
      write("scripts/x.mjs", `x`);
      write("supabase/functions/f.ts", `x`);
      write("types.d.ts", `declare const z: 1;`);
      const found = appSourceFiles(dir).map((f) => relPath(f, dir));
      expect(found).toEqual(["app/.well-known/route.ts", "hooks/use-thing.ts", "instrumentation-client.ts"]);
      expect(existingEntryPoints(dir)).toEqual(["instrumentation-client.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // re-review N5: ts.createSourceFile NEVER THROWS. A file with a syntax
  // error is parsed with recovery, and the scan of it can quietly miss the
  // broken statement. Nothing asserted the parse was clean, so a scan of
  // rubble read as a scan of nothing.
  it("every scanned file parses with no syntax errors, so no scan is a scan of rubble", () => {
    const broken: string[] = [];
    for (const { file, text } of readTree()) {
      const problems = parseProblems(parse(file, text));
      if (problems.length > 0) broken.push(`${file}: ${problems.slice(0, 3).join("; ")}`);
    }
    expect(broken, "a scanned file does not parse; the storage census cannot see what is in it").toEqual([]);
  });

  it("FIXTURE (N5): a file with a syntax error IS reported, and the scanner would have missed the write in it", () => {
    const source = `function a( { localStorage.setItem("gsp:hidden", "1"); }`;
    const sf = parse("broken.ts", source);
    expect(parseProblems(sf).length).toBeGreaterThan(0);
    expect(parseProblems(parse("fine.ts", `localStorage.setItem("k", "1");`))).toEqual([]);
  });

  it("no scanned file imports code from a place the scan skips", () => {
    const leaks: string[] = [];
    let references = 0;
    for (const file of appSourceFiles()) {
      const rel = relPath(file);
      const sf = parse(rel, readFileSync(file, "utf8"));
      for (const ref of moduleReferences(sf)) {
        references++;
        const target = ref.specifier === null ? null : resolveSpecifier(rel, ref.specifier);
        const top = target?.split("/")[0];
        if (top && (NON_SHIPPED_ROOT_DIRS.has(top) || top.startsWith(".") || top === "node_modules")) {
          leaks.push(`${rel} -> ${ref.specifier}`);
        }
      }
    }
    expect(references, "DENOMINATOR: the import walk read imports").toBeGreaterThan(1000);
    expect(leaks, "an app module imports from a folder the storage census does not scan").toEqual([]);
  });
});

describe("the storage census (Phase 8 Task 2, Q129)", () => {
  const sites = scanTree();

  it("NON-VACUITY: the scan finds every declared site, so a pass below is not a scan of nothing", () => {
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
      const found = sites.filter((s) => key(s) === key(d) && s.key !== null).map((s) => s.key);
      expect(found, key(d)).toEqual([...d.keys!]);
    }
  });

  it("a literal key anywhere must match an inventory item of its own kind", () => {
    const literals = sites
      .filter((s) => s.kind === "cookie-write" || s.kind === "web-storage-write")
      .map((s) => ({ s, lit: /^["'`]([^"'`$]*)["'`]$/.exec(s.key ?? "")?.[1] }))
      .filter((x): x is { s: Site; lit: string } => x.lit !== undefined);
    const unmatched = literals
      .filter(
        ({ s, lit }) =>
          !BROWSER_STORAGE.some(
            (item) =>
              item.kind === (s.kind === "cookie-write" ? "cookie" : "local-storage") && item.matches.test(lit),
          ),
      )
      .map(({ s, lit }) => `${s.file}:${s.line} "${lit}"`);
    expect(unmatched, "a literal cookie/storage key that no inventory item of its kind covers").toEqual([]);
  });

  // WHERE THE ENFORCEMENT ACTUALLY IS (re-review N6). The `server-only`
  // package throws when a Client Component graph imports it, and that happens
  // when NEXT COMPILES the module -- `next dev` or `next build`, neither of
  // which CI runs. So these two tests are what stands in for it here: the
  // import is real (read from the parsed file, so the same line inside a
  // block comment is not it), and no client component reaches one of those
  // modules through any chain of repo imports. A client component that got
  // one of these into a browser bundle would fail the build; this fails the
  // unit suite first, and names the chain.
  it("a server-only declaration is in a module that really imports \"server-only\" (parsed, not matched)", () => {
    const serverOnly = DECLARED.filter((x) => x.covers === null);
    expect(serverOnly.length).toBeGreaterThan(0);
    for (const d of serverOnly) {
      const sf = parse(d.file, readFileSync(join(ROOT, d.file), "utf8"));
      expect(
        importsServerOnly(sf),
        `${d.file} declares a server-only site but has no top-level \`import "server-only";\``,
      ).toBe(true);
    }
  });

  it("no client component, and nothing a client component imports, reaches a server-only module", () => {
    const tree = readTree();
    const byModule = new Map(tree.map((f) => [f.file, f] as const));
    const parsed = new Map(tree.map((f) => [f.file, parse(f.file, f.text)] as const));
    const resolveToFile = (from: string, specifier: string): string | null => {
      const target = resolveSpecifier(from, specifier);
      if (target === null) return null;
      for (const file of byModule.keys()) if (namesModule(target, file)) return file;
      return null;
    };
    const serverOnlyModules = DECLARED.filter((d) => d.covers === null).map((d) => d.file);
    expect(serverOnlyModules.length).toBe(4);

    const clients = tree.filter((f) => isClientModule(parsed.get(f.file)!)).map((f) => f.file);
    expect(clients.length, "DENOMINATOR: there are client components to walk").toBeGreaterThan(10);

    const chains: string[] = [];
    const boundaries: string[] = [];
    for (const start of clients) {
      const seen = new Set<string>([start]);
      const queue: { file: string; path: string[] }[] = [{ file: start, path: [start] }];
      while (queue.length > 0) {
        const { file, path } = queue.shift()!;
        if (serverOnlyModules.includes(file)) {
          chains.push(path.join(" -> "));
          continue;
        }
        // A "use server" module is an RPC boundary: the client gets a stub,
        // and what the action imports never enters a browser bundle.
        if (file !== start && isServerActionModule(parsed.get(file)!)) {
          boundaries.push(path.join(" -> "));
          continue;
        }
        for (const ref of moduleReferences(parsed.get(file)!)) {
          if (ref.specifier === null) continue;
          // `import type` is erased before bundling.
          if (ts.isImportDeclaration(ref.node) && ref.node.importClause?.isTypeOnly) continue;
          const next = resolveToFile(file, ref.specifier);
          if (next === null || seen.has(next)) continue;
          seen.add(next);
          queue.push({ file: next, path: [...path, next] });
        }
      }
    }
    expect(
      chains,
      'a "use client" module reaches a module that imports "server-only" -- the service-role key or ' +
        "the provider credential it holds would be compiled into a browser bundle (the build refuses " +
        "this too, but nothing in CI runs a build)",
    ).toEqual([]);
    // DENOMINATOR: the walk really did reach the action modules that import
    // them, and stopped at the RPC boundary rather than at nothing.
    expect(boundaries.length, "the walk reached a `use server` module").toBeGreaterThan(3);
    expect(boundaries.some((b) => b.includes("lib/org/actions.ts"))).toBe(true);
  });

  it("FIXTURE (N6): the server-only import is read from the parse, so a commented-out one does not count", () => {
    expect(importsServerOnly(parse("a.ts", `import "server-only";\nexport const x = 1;`))).toBe(true);
    expect(importsServerOnly(parse("b.ts", `/* import "server-only"; */\nexport const x = 1;`))).toBe(false);
    expect(importsServerOnly(parse("c.ts", `// import "server-only";\nexport const x = 1;`))).toBe(false);
    expect(importsServerOnly(parse("d.ts", `const s = 'import "server-only";';`))).toBe(false);
    // A named import of the package is not the guard either.
    expect(importsServerOnly(parse("e.ts", `import x from "server-only";`))).toBe(false);
  });

  it("every declared site covers a real inventory item, and each key resolves to it", () => {
    const names = BROWSER_STORAGE.map((i) => i.name);
    for (const d of DECLARED.filter((x) => x.covers !== null)) expect(names, key(d)).toContain(d.covers);
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
    const served = existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => /\.(html?|[cm]?js|jsx|tsx?)$/i.test(f))
      : [];
    expect(served).toEqual([]);
  });

  // WHAT THIS DOES AND DOES NOT PROVE (review finding M6). script-src carries
  // 'strict-dynamic', so it names no host -- but under 'strict-dynamic' a
  // script the page already trusts (every app chunk, and anything in
  // instrumentation-client.ts) may insert a script from ANY host, and a
  // first-party cookie such a script writes (`_ga`) is governed by no CSP
  // directive at all. So this is NOT "scripts load only from this origin": it
  // is "the policy names no third-party script, frame or image host", and the
  // source scan above is what stops trusted code from inserting one. Whether
  // 'strict-dynamic' should stay is DECISIONS-QUEUE Q155.
  it("the Content-Security-Policy names no third-party script, frame or image host (not: blocks one)", () => {
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
// THE DETECTOR HAS TEETH -- the two mutations the brief names, and every
// evasion the Task 2 review measured green against the first (regex)
// scanner, run against the scanner itself on every CI build.
// ===========================================================================
describe("the census detector", () => {
  const kinds = (source: string, file = "x.tsx") => scanSource(file, source).map((s) => s.kind);

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
    expect(found.map((s) => s.text)).toEqual([
      'import Script from "next/script";',
      "Script",
      'src="https://analytics.example/a.js"',
    ]);
    expect(new Set(found.map((s) => s.kind))).toEqual(new Set(["third-party"]));
  });

  // Each of the first group was GREEN under the regex scanner
  // (task-2-review.md, I1); the rest are neighbours of the same shapes.
  const EVASIONS: [string, string, SiteKind][] = [
    [
      "the Next 15/16 shape of cookies().set",
      `import { cookies } from "next/headers";\nexport async function a() { (await cookies()).set("ab", "1"); }`,
      "cookie-write",
    ],
    [
      "an aliased cookies import",
      `import { cookies as jar } from "next/headers";\nexport async function a() { const c = await jar(); c.set("x", "1"); }`,
      "cookie-write",
    ],
    [
      "a destructured set",
      `import { cookies } from "next/headers";\nexport async function a() { const { set } = await cookies(); set("x", "1"); }`,
      "cookie-write",
    ],
    ["a concatenated Set-Cookie header", `headers.push(["Set-" + "Cookie", v]);`, "cookie-write"],
    ["optional-chained localStorage", `window.localStorage?.setItem("k", "1");`, "web-storage-write"],
    ["an aliased localStorage", `const ls = window.localStorage; ls.setItem("k", "1");`, "web-storage-write"],
    ["a bracketed localStorage", `window["localStorage"].setItem("k", "1");`, "web-storage-write"],
    ["the Cookie Store API", `cookieStore.set("x", "1");`, "cookie-write"],
    ["a dynamic import from a CDN", `await import("https://cdn.example/a.js");`, "third-party"],
    ["a beacon by fetch", `fetch("https://beacon.example/p", { method: "POST" });`, "third-party"],
    ["a preconnect link", `export const L = () => <link rel="preconnect" href="https://fonts.example" />;`, "third-party"],
    ["window.open to a third party", `window.open("https://t.example/");`, "third-party"],
    ["a write after a string containing //", `const u = "a //"; localStorage.setItem("k", "1");`, "web-storage-write"],
    // -- neighbours --
    [
      "a namespace import of next/headers",
      `import * as h from "next/headers";\nexport async function a() { (await h.cookies()).set("x", "1"); }`,
      "cookie-write",
    ],
    [
      "a cookie store's set taken and called later",
      `import { cookies } from "next/headers";\nexport async function a() { const s = await cookies(); const f = s.set; f("x", "1"); }`,
      "cookie-write",
    ],
    [
      "the cookies function passed away",
      `import { cookies as c } from "next/headers";\nexport const run = () => helper(c);`,
      "cookie-write",
    ],
    [
      "optional chaining on cookies()",
      `import { cookies } from "next/headers";\nexport async function a() { (await cookies())?.set("x", "1"); }`,
      "cookie-write",
    ],
    ["the Cookie Store API on window", `window.cookieStore?.set({ name: "x", value: "1" });`, "cookie-write"],
    ["a templated set-cookie header", "const h = `set-${'cookie'}`;", "cookie-write"],
    ["a meta set-cookie", `export const M = () => <meta httpEquiv="set-cookie" content="a=b" />;`, "cookie-write"],
    ["an aliased document", `const d = document; d.cookie = "_ga=1";`, "cookie-write"],
    ["a bracketed document.cookie", `document["cookie"] = "_ga=1";`, "cookie-write"],
    ["compound assignment to document.cookie", `document.cookie += "; _ga=1";`, "cookie-write"],
    ["an alias of an alias", `const a = window.sessionStorage; const b = a; b.setItem("k", "1");`, "web-storage-write"],
    ["a destructured localStorage", `const { localStorage: ls } = window; ls.setItem("k", "1");`, "web-storage-write"],
    ["a concatenated global name", `window["local" + "Storage"].setItem("k", "1");`, "web-storage-write"],
    ["a constant global name", `const N = "sessionStorage"; globalThis[N].setItem("k", "1");`, "web-storage-write"],
    ["storage passed to a function", `persist(window.localStorage);`, "web-storage-write"],
    ["storage returned", `export const store = () => window.sessionStorage;`, "web-storage-write"],
    ["storage put in an object", `export const deps = { s: localStorage };`, "web-storage-write"],
    [
      "a cookie store returned",
      `import { cookies } from "next/headers";\nexport async function jar() { return await cookies(); }`,
      "cookie-write",
    ],
    ["setItem via call()", `localStorage.setItem.call(localStorage, "k", "1");`, "web-storage-write"],
    ["a conditional store", `(ok ? localStorage : sessionStorage).setItem("k", "1");`, "web-storage-write"],
    ["a computed write", `localStorage[key] = "1";`, "web-storage-write"],
    [
      "a write after a template containing //",
      "const u = `http://x/${y}`; localStorage.setItem(\"k\", \"1\");",
      "web-storage-write",
    ],
    ["a dynamic import of a computed specifier", `await import(url);`, "third-party"],
    ["a require of next/script", `const S = require("next/script");`, "third-party"],
    ["a beacon by fetch through a constant", `const U = "//beacon.example/p"; fetch(U);`, "third-party"],
    ["an XHR to a third party", `x.open("GET", "https://t.example/p");`, "third-party"],
    ["a WebSocket to a third party", `new WebSocket("wss://t.example/s");`, "third-party"],
    ["a link with a computed href", `export const L = () => <link rel="stylesheet" href={u} />;`, "third-party"],
    ["a script src assignment", `const s = document.createElement(tag); s.src = "https://t.example/a.js";`, "third-party"],
    ["an innerHTML injection", `el.innerHTML = "<script src=//t.example></script>";`, "third-party"],
    ["insertAdjacentHTML", `el.insertAdjacentHTML("beforeend", html);`, "third-party"],
    ["document.write", `document.write("<script></script>");`, "third-party"],
    ["eval", `eval(code);`, "third-party"],
    ["new Function", `new Function(code)();`, "third-party"],
    ["an object element", `export const O = () => <object data="https://t.example/x.swf" />;`, "third-party"],
    ["an absolute poster", `export const V = () => <video poster="https://t.example/p.png" />;`, "third-party"],
    ["the GA loader as a string", `const s = "https://www.googletagmanager.com/gtag/js?id=G-1";`, "tracker"],
    ["gtag on window", `window.gtag("config", "G-1");`, "tracker"],
    ["dataLayer", `window.dataLayer = window.dataLayer || [];`, "tracker"],
    ["an analytics package", `import { track } from "@vercel/analytics";`, "tracker"],
    ["IndexedDB via window", `window["indexedDB"].open("db");`, "indexeddb"],
    ["navigator.storage", `navigator.storage.persist();`, "cache-storage"],
  ];

  for (const [name, source, kind] of EVASIONS) {
    it(`sees ${name}`, () => {
      expect(kinds(source), source).toContain(kind);
    });
  }

  // ---- re-review N1: shapes nobody had listed --------------------------------
  it("N1: follows a `cookies` re-exported by another module, under an alias and through `export *`", () => {
    const barrelShapes: [string, string][] = [
      ["a named re-export", `export { cookies as jar } from "next/headers";`],
      ["a star re-export", `export * from "next/headers";`],
      ["a local re-export", `import { cookies as c } from "next/headers";\nexport { c as jar };`],
      ["a const alias", `import { cookies } from "next/headers";\nexport const jar = cookies;`],
    ];
    for (const [name, barrel] of barrelShapes) {
      const local = name === "a star re-export" ? "cookies" : "jar";
      const tree = [
        { file: "lib/next-headers.ts", text: barrel },
        {
          file: "lib/ab-test.ts",
          text: `import { ${local} } from "./next-headers";\nexport async function ab() { (await ${local}()).set("ab_variant", "b"); }`,
        },
      ];
      const cookieExports = collectCookieReExports(tree);
      const kinds = scanSource(tree[1].file, tree[1].text, { cookieExports }).map((s) => s.kind);
      expect(kinds, name).toContain("cookie-write");
      // ...and without the cross-module pass it was invisible, which is the finding.
      if (local !== "cookies") {
        expect(scanSource(tree[1].file, tree[1].text).map((s) => s.kind), `${name} (alone)`).not.toContain(
          "cookie-write",
        );
      }
    }
  });

  it("N1: follows a re-export through a barrel of a barrel, and through a namespace import", () => {
    const tree = [
      { file: "lib/one.ts", text: `export { cookies as jar } from "next/headers";` },
      { file: "lib/two.ts", text: `export * from "./one";` },
      {
        file: "lib/use.ts",
        text: `import * as barrel from "./two";\nexport async function w() { (await barrel.jar()).set("x", "1"); }`,
      },
    ];
    const cookieExports = collectCookieReExports(tree);
    expect(cookieExports.get("lib/two")!.fns.has("jar")).toBe(true);
    expect(scanSource(tree[2].file, tree[2].text, { cookieExports }).map((s) => s.kind)).toContain("cookie-write");
  });

  it("N1: sees Object.assign / Reflect writes onto document, and a `cookie` property named through them", () => {
    const shapes = [
      `Object.assign(document, { cookie: "_ga=1" });`,
      `const d = document; Object.assign(d, { cookie: "_ga=1" });`,
      `Object.assign(window.document, patch);`,
      `Object.defineProperty(document, "cookie", { set(v) { real = v; } });`,
      `Reflect.set(document, "cookie", "_ga=1");`,
      `Reflect.set(target, "cookie", "_ga=1");`,
      `Object.defineProperties(document, { cookie: descriptor });`,
    ];
    for (const source of shapes) expect(kinds(source, "x.ts"), source).toContain("cookie-write");
    // An ordinary Object.assign is not a cookie write.
    expect(kinds(`Object.assign(state, { open: true });`, "x.ts")).toEqual([]);
  });

  it("N1: sees a destructuring or for-of assignment that writes a cookie or a storage key", () => {
    const shapes: [string, SiteKind][] = [
      [`[document.cookie] = ["_ga=1"];`, "cookie-write"],
      [`({ a: document.cookie } = payload);`, "cookie-write"],
      [`for (document.cookie of values) { }`, "cookie-write"],
      [`for (document["cookie"] in map) { }`, "cookie-write"],
      [`[localStorage.k] = ["1"];`, "web-storage-write"],
      [`({ v: sessionStorage.k } = payload);`, "web-storage-write"],
      [`for (localStorage.k of values) { }`, "web-storage-write"],
    ];
    for (const [source, kind] of shapes) expect(kinds(source, "x.ts"), source).toContain(kind);
    // Reading into a destructuring is not writing storage.
    expect(kinds(`const [a] = [document.title];`, "x.ts")).toEqual([]);
  });

  it("N1: sees Function without `new`, and Function or eval taken as a value", () => {
    for (const source of [
      `Function("return 1")();`,
      `globalThis.Function(code)();`,
      `window.Function(code);`,
      `const F = Function; F(code);`,
      `const e = eval; e(code);`,
      `run(Function);`,
    ]) {
      expect(kinds(source, "x.ts"), source).toContain("third-party");
    }
  });

  it("N1: sees a timer whose first argument is not a function written here", () => {
    for (const source of [
      `setTimeout("doEvil()", 0);`,
      "setTimeout(`${code}`, 0);",
      `setTimeout("do" + "Evil()", 0);`,
      `window.setInterval(codeFromServer, 1000);`,
      `setTimeout(imported, 0);`,
    ]) {
      expect(kinds(source, "x.ts"), source).toContain("third-party");
    }
    // A function written here is not a finding -- the real tree's three timers.
    for (const source of [
      `window.setTimeout(() => close(), 100);`,
      `function checkNow() {} window.setInterval(checkNow, 5000);`,
      `const tick = () => {}; setTimeout(tick, 5);`,
      `const cb = useCallback(() => {}, []); setTimeout(cb, 5);`,
      `setTimeout(function () {}, 5);`,
    ]) {
      expect(kinds(source, "x.ts"), source).toEqual([]);
    }
  });

  it("N1: sees a header written under a name that is not a constant", () => {
    for (const source of [
      `res.headers.set(["set", "cookie"].join("-"), v);`,
      `response.headers.append(String.fromCharCode(83) + "et-Cookie", v);`,
      `requestHeaders.set(nameFromData, v);`,
      `new Headers([[name, v]]);`,
      `new Headers({ [name]: v });`,
      `return new Response(body, { headers: { [name]: v } });`,
      `return new Response(body, { headers: [[name, v]] });`,
    ]) {
      expect(kinds(source, "x.ts"), source).toContain("cookie-write");
    }
    // A constant name is read by the string rule instead, and an ordinary
    // constant header is not a cookie at all.
    expect(kinds(`res.headers.set("Cache-Control", "no-store");`, "x.ts")).toEqual([]);
    expect(kinds(`const H = "Cache-Control"; res.headers.set(H, "no-store");`, "x.ts")).toEqual([]);
    expect(kinds(`map.set(key, value);`, "x.ts")).toEqual([]);
  });

  it("sees a GA loader in a root instrumentation-client.ts, and that file is in the scanned set", () => {
    const source = [
      `const s = document.createElement("script");`,
      `s.src = "https://www.googletagmanager.com/gtag/js?id=G-1";`,
      `document.head.appendChild(s);`,
      `localStorage.setItem("_ga_seen", "1");`,
    ].join("\n");
    expect(kinds(source, "instrumentation-client.ts")).toEqual(
      expect.arrayContaining(["third-party", "tracker", "web-storage-write"]),
    );
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
      [`import { createClient } from "@supabase/supabase-js"; createClient(u, k);`, "supabase-client"],
      [`import { createBrowserClient as mk } from "@supabase/ssr"; mk(u, k);`, "supabase-client"],
    ];
    for (const [source, kind] of shapes) {
      expect(kinds(source), source).toContain(kind);
    }
  });

  it("keys a write by its first argument, however the store was reached", () => {
    const keyOf = (source: string) => scanSource("x.ts", source).map((s) => s.key);
    expect(keyOf(`import { cookies } from "next/headers";\n(await cookies()).set(NAME, v);`)).toEqual(["NAME"]);
    expect(keyOf(`const ls = localStorage; ls.setItem("_ga", "1");`)).toEqual(['"_ga"']);
    expect(keyOf(`localStorage.k = "v";`)).toEqual(['"k"']);
  });

  it("ignores what is only said in a comment or a string, and reads (not writes) storage", () => {
    const quiet = [
      `// document.cookie = "x"`,
      `/* localStorage.setItem("k", "v") <script> */`,
      `const doc = "localStorage.setItem('k', 'v') and document.cookie = 1";`,
      `const v = window.localStorage.getItem(KEY); window.localStorage.removeItem(KEY);`,
      `const url = "https://example.com"; // a URL is not a comment`,
      `const c = store.get("x");`,
      `import { cookies } from "next/headers";\nconst s = await cookies(); const v = s.get("x"); const all = s.getAll();`,
      `import { cookies } from "next/headers";\nconst { get, getAll } = await cookies();`,
      `if (typeof window !== "undefined" && window.localStorage) { read(); }`,
      `export const A = () => <a href="https://example.com">x</a>;`,
      `import Link from "next/link";\nexport const B = () => <Link href={dynamicHref}>x</Link>;`,
      `window.location.href = "/login";`,
      `const response = await fetch(url);`,
      `const t: typeof localStorage = x;`,
    ];
    for (const source of quiet) expect(scanSource("x.tsx", source), source).toEqual([]);
  });
});
