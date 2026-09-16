import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { describe, expect, it } from "vitest";
import { BROWSER_STORAGE } from "@/lib/legal/storage-inventory";
import { CURRENT_ORG_COOKIE } from "@/lib/org/current-org";
import { activityStorageKey } from "@/lib/auth/idle-timeout";

// THE COOKIE POLICY NAMES WHAT THE CODE SETS -- each declared item is pinned
// to the source constant it describes, so renaming a key without updating the
// policy is red. (Q129. The reverse direction -- a NEW key the policy does not
// declare -- is tests/unit/legal/storage-census.test.ts and, in a real
// browser, tests/e2e/storage-census.spec.ts; this file does not claim it.)

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const names = BROWSER_STORAGE.map((item) => item.name);

describe("the Cookie Policy's storage list matches the code", () => {
  it("declares exactly four items, all strictly necessary and all first-party (Q129)", () => {
    expect(BROWSER_STORAGE).toHaveLength(4);
    for (const item of BROWSER_STORAGE) {
      expect(item.setBy).toMatch(/^GetSetPaid/);
      expect(item.necessity.length).toBeGreaterThan(10);
      expect(item.duration.length).toBeGreaterThan(5);
    }
  });

  it("names the workspace cookie by its real name", () => {
    expect(names).toContain(CURRENT_ORG_COOKIE);
    const kind = BROWSER_STORAGE.find((i) => i.name === CURRENT_ORG_COOKIE)?.kind;
    expect(kind).toBe("cookie");
  });

  it("states the workspace cookie's real lifetime", () => {
    const src = readFileSync(`${ROOT}lib/org/current-org.ts`, "utf8");
    expect(src).toMatch(/MAX_AGE_SECONDS = 60 \* 60 \* 24 \* 180;/);
    expect(BROWSER_STORAGE.find((i) => i.name === CURRENT_ORG_COOKIE)?.duration).toMatch(/^180 days/);
  });

  it("names the idle-timeout key by the scheme activityStorageKey() uses", () => {
    const placeholder = "<your account id>";
    expect(names).toContain(activityStorageKey(placeholder));
  });

  it("names the sidebar key by its real name", () => {
    const src = readFileSync(`${ROOT}components/nav/sidebar.tsx`, "utf8");
    const key = /const PIN_STORAGE_KEY = "([^"]+)";/.exec(src)?.[1];
    expect(key, "components/nav/sidebar.tsx no longer declares PIN_STORAGE_KEY as a literal").toBeTruthy();
    expect(names).toContain(key);
  });

  // FIX ROUND 1, M8: this used to compare the inventory with a literal written
  // in this file, so it could not notice the library naming the cookie
  // differently. It now asks the library the app actually uses.
  it("names the Supabase auth cookie exactly as @supabase/ssr names it", () => {
    // The project ref varies per deployment; the policy writes it as "…".
    const ref = "abcdefghijklmnopqrst";
    const client = createServerClient(`https://${ref}.supabase.co`, "public-key", {
      cookies: { getAll: () => [], setAll: () => {} },
    });
    const storageKey = (client.auth as unknown as { storageKey: string }).storageKey;
    expect(storageKey, "the library's own key").toMatch(new RegExp(`^sb-${ref}-`));

    const declared = BROWSER_STORAGE.filter((item) => item.kind === "cookie" && item.name.startsWith("sb-"));
    expect(declared, "exactly one declared Supabase cookie entry").toHaveLength(1);
    const name = declared[0].name;
    expect(name.replace(/…/, ref).startsWith(`${storageKey} `), name).toBe(true);

    // "numbered parts": @supabase/ssr splits a large session into key.0, key.1...
    const require = createRequire(import.meta.url);
    const ssrDir = dirname(require.resolve("@supabase/ssr"));
    expect(readFileSync(join(ssrDir, "utils", "chunker.js"), "utf8")).toContain("name: `${key}.${i}`");
    expect(name).toMatch(/numbered parts/);

    // "…-code-verifier": the PKCE verifier auth-js stores during a redirect
    // sign-in, under a key ending in -code-verifier.
    const supabaseJs = require.resolve("@supabase/supabase-js");
    const authDir = dirname(require.resolve("@supabase/auth-js", { paths: [supabaseJs] }));
    const auth = readFileSync(join(authDir, "GoTrueClient.js"), "utf8") + readFileSync(join(authDir, "lib", "helpers.js"), "utf8");
    expect(auth).toMatch(/\$\{(this\.)?storageKey\}[^`]*-code-verifier`/);
    expect(name).toMatch(/…-code-verifier/);
  });
});
