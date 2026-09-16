import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_STORAGE } from "@/lib/legal/storage-inventory";
import { CURRENT_ORG_COOKIE } from "@/lib/org/current-org";
import { activityStorageKey } from "@/lib/auth/idle-timeout";

// THE COOKIE POLICY NAMES WHAT THE CODE SETS -- each declared item is pinned
// to the source constant it describes, so renaming a key without updating the
// policy is red. (Q129. The reverse direction -- a NEW key the policy does not
// declare -- is Phase 8 Task 2's census; this file does not claim it.)

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

  it("names the Supabase auth cookie by the prefix @supabase/ssr uses", () => {
    // The project ref varies per deployment, so the policy names the pattern.
    expect(names.some((n) => n.startsWith("sb-…-auth-token"))).toBe(true);
  });
});
