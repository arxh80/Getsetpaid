import { describe, expect, it } from "vitest";
import { SCAN_STATUSES, SCAN_STATUS_LABELS } from "@/lib/crm/task-status";
import {
  DOCUMENT_DELETED_LIST,
  DOCUMENT_DELETED_SELECT,
  DOCUMENT_LIST,
  DOCUMENT_SELECT,
  mapDocumentRow,
} from "@/lib/crm/documents-list";

// THE DOCUMENTS LIST SPEC, ASSERTED WHERE THE COMPILER CANNOT SEE IT.
//
// lib/list/spec.ts already makes most of the shape a type error (`notNull` is
// the literal `true`, `backedBy` is a required string, a column's `sortKey` is
// constrained to the spec's own keys). What is left to assert at runtime is
// what a type cannot: that the ONE sort names a real index, that the scan-status
// filter still tracks the CHECK constraint, that the select never carries
// `storage_key`, and that no loop here runs zero times.

describe("DOCUMENT_SELECT", () => {
  it("never selects storage_key — it is opaque and no cell renders it", () => {
    // The one column a leak would matter for. The download path uses it
    // server-side (issueDownloadUrl), never the list.
    expect(DOCUMENT_SELECT).not.toContain("storage_key");
    expect(DOCUMENT_DELETED_SELECT).not.toContain("storage_key");
  });

  it("carries owner_user_id, for the 'Uploaded by' column and the 'Mine' filter", () => {
    expect(DOCUMENT_SELECT).toContain("owner_user_id");
  });

  it("mapDocumentRow is a faithful projection", () => {
    const row = mapDocumentRow({
      id: "d1",
      filename: "rider.pdf",
      mime_type: "application/pdf",
      size_bytes: "2048",
      scan_status: "clean",
      owner_user_id: "u1",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(row).toEqual({
      id: "d1",
      filename: "rider.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      scanStatus: "clean",
      ownerUserId: "u1",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("maps a null owner_user_id to null (the DB nulls it on user delete)", () => {
    const row = mapDocumentRow({
      id: "d1",
      filename: "x.pdf",
      mime_type: "application/pdf",
      size_bytes: 1,
      scan_status: "pending",
      owner_user_id: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(row.ownerUserId).toBeNull();
  });
});

describe("DOCUMENT_LIST sorts", () => {
  const keys = Object.keys(DOCUMENT_LIST.sort);

  it("has exactly one sort — created_at — because only that index exists", () => {
    // ONE IS THE DENOMINATOR. filename and updated_at have no
    // (organisation_id, <col>, id) live index, and rule 9 forbids a sort
    // naming an index nobody created — so the org-wide documents list offers
    // only the created_at sort it can back.
    expect(keys).toEqual(["created"]);
  });

  it("the sort is NOT NULL, defaults newest-first, and names the live index", () => {
    const sort = DOCUMENT_LIST.sort.created;
    expect(sort.notNull).toBe(true);
    expect(sort.column).toBe("created_at");
    expect(sort.defaultDirection).toBe("desc");
    expect(sort.backedBy).toBe("documents_org_created_at_id_live_idx");
  });

  it("the default sort is that one", () => {
    expect(DOCUMENT_LIST.defaultSort).toBe("created");
  });
});

describe("DOCUMENT_LIST filters", () => {
  it("the scan choices are SCAN_STATUSES exactly, in order, behind one 'any'", () => {
    // THE MUTATION THIS CATCHES: a fifth scan_status added to the CHECK and to
    // SCAN_STATUSES with the filter left alone — a status no one can filter for.
    const choices = DOCUMENT_LIST.filters.scan.choices;
    expect(choices).toHaveLength(SCAN_STATUSES.length + 1);
    expect(choices[0]).toEqual({ value: "any", label: "Any scan status" });
    expect(choices.slice(1).map((c) => c.value)).toEqual([...SCAN_STATUSES]);
    expect(choices.slice(1).map((c) => c.label)).toEqual(
      SCAN_STATUSES.map((s) => SCAN_STATUS_LABELS[s]),
    );
  });

  it("the owner filter's first choice hides nothing", () => {
    // lib/list/spec.ts's rule: the first choice is the default and MUST filter
    // nothing, or a cold-opened list shows its narrowed empty state over a full
    // workspace.
    expect(DOCUMENT_LIST.filters.owner.choices[0]).toEqual({
      value: "anyone",
      label: "Anyone",
    });
  });
});

describe("DOCUMENT_DELETED_LIST", () => {
  it("has exactly one sort — deleted_at — behind the deleted-scope index", () => {
    const keys = Object.keys(DOCUMENT_DELETED_LIST.sort);
    expect(keys).toEqual(["deleted"]);
    const sort = DOCUMENT_DELETED_LIST.sort.deleted;
    expect(sort.notNull).toBe(true);
    expect(sort.column).toBe("deleted_at");
    // The index added by 20260902032000; partial on deleted_at is not null, so
    // notNull:true is true of the rows this list reads.
    expect(sort.backedBy).toBe("documents_org_deleted_at_id_idx");
  });

  it("has no filters, so its default state hides nothing", () => {
    expect(Object.keys(DOCUMENT_DELETED_LIST.filters)).toEqual([]);
  });
});
