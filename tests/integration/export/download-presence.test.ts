// Phase 10 Task 14 (G20), the live half of
// tests/unit/export/download-storage-errors.test.ts. objectPresence() decides
// "missing" from what the REAL storage API says, so the classification is
// proved here against the local stack, not only a mock: a present archive is
// present, and a genuinely missing one is still "missing" (the not-found
// answer), not "error" (the 503). FOLLOW-UPS M2 is why: the local API answers
// a HEAD on a missing object with 400, which exists() (storage-js < 2.119)
// could not tell apart.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { objectPresence } from "@/lib/supabase/storage";

const { apiUrl, serviceRoleKey } = getLocalSupabaseStatus();
const storage = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false } }).storage;
const KEY = `g20-presence/${Date.now()}/archive.zip`;

beforeAll(async () => {
  const { error } = await storage.from("exports").upload(KEY, new Uint8Array([0x50, 0x4b, 3, 4]), {
    contentType: "application/zip",
  });
  if (error) throw new Error(`seed upload failed: ${error.message}`);
});

afterAll(async () => {
  await storage.from("exports").remove([KEY]);
});

describe("objectPresence against the local storage API (G20)", () => {
  it("a present archive is present (positive control)", async () => {
    expect(await objectPresence(storage.from("exports"), KEY)).toBe("present");
  });

  it("a genuinely missing archive is missing, so the download stays a 404", async () => {
    expect(await objectPresence(storage.from("exports"), `${KEY}.gone`)).toBe("missing");
  });

  // Before storage-js 2.119, exists() sent a HEAD and the local API answered
  // 400 for a missing object, so "missing" could not be told from a bad
  // request. Since 2.119 exists() calls info() itself, the same call
  // objectPresence() makes, and a missing object is a 404. If a release goes
  // back to the HEAD, this goes red, which is the cue to re-check objectPresence.
  it("exists() now goes through info(): a missing object is false with a 404", async () => {
    const { data, error } = await storage.from("exports").exists(`${KEY}.gone`);
    expect(data).toBe(false);
    expect((error as { statusCode?: string } | null)?.statusCode).toBe("404");
  });
});
