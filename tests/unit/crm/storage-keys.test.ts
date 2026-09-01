import { describe, expect, it } from "vitest";
import { buildStorageKey } from "@/lib/crm/storage-keys";

// buildStorageKey is the OPAQUE, tenant-scoped storage key. Its whole job is
// that no user input reaches it -- CLAUDE.md § Non-negotiable rules: "sanitised
// filenames (never user-supplied paths as storage keys)". These assertions are
// the first layer; documents_storage_key_shape (a DB CHECK) is the second.

const ORG = "11111111-1111-4111-8111-111111111111";
const DOC_A = "22222222-2222-4222-8222-222222222222";
const DOC_B = "33333333-3333-4333-8333-333333333333";

describe("buildStorageKey", () => {
  it("is exactly {orgId}/{documentId}", () => {
    expect(buildStorageKey(ORG, DOC_A)).toBe(`${ORG}/${DOC_A}`);
  });

  it("begins with the org id and a slash -- the DB CHECK's shape", () => {
    expect(buildStorageKey(ORG, DOC_A).startsWith(`${ORG}/`)).toBe(true);
  });

  it("embeds NO filename and no client string", () => {
    // MUTATION GUARD: appending the filename to the key (`${org}/${doc}-${name}`)
    // turns this assertion red -- and any traversal in the filename would then
    // reach the key, which the DB CHECK still blocks. Both layers named.
    const key = buildStorageKey(ORG, DOC_A);
    for (const hostile of ["invoice.pdf", "../../etc/passwd", "report", ".."]) {
      expect(key).not.toContain(hostile);
    }
    // The key is nothing but the two ids and one slash.
    expect(key).toBe(`${ORG}/${DOC_A}`);
  });

  it("two documents in one org never collide", () => {
    expect(buildStorageKey(ORG, DOC_A)).not.toBe(buildStorageKey(ORG, DOC_B));
  });

  it("refuses a non-uuid id, so no client string can be routed through it", () => {
    expect(() => buildStorageKey("not-a-uuid", DOC_A)).toThrow();
    expect(() => buildStorageKey(ORG, "../../etc/passwd")).toThrow();
  });
});
