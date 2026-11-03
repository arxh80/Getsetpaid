// Q228: the closure backup's parts -- the key shape, the part parameter, the
// resume cursor, the limits override, and the pin that keeps one uploaded
// file smaller than one part.
//
// The binding of exportStorageKey(jobId, n) to the database's
// export_job_parts_storage_key_shape CHECK needs a real Postgres, so it lives
// in tests/integration/export/closure-parts.test.ts ("THE KEY BINDING"), not
// here: this project touches no socket.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLOSURE_BACKUP_STOPPED,
  CLOSURE_PARTS_MANIFEST_VERSION,
  EXPORT_LIMITS,
  EXPORT_MANIFEST_VERSION,
  exportStorageKey,
  parsePartParam,
  parseResumeCursor,
  type ResumeCursor,
} from "@/lib/export/contract";
import { PART_MANIFEST_BASE_RESERVE, placeIndex } from "@/lib/export/parts";
import { ZipWriter } from "@/lib/export/zip";
import { effectiveLimits } from "@/lib/export/runner";
import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/security/upload-limits";
import { FEEDBACK_SCREENSHOT_MAX_BYTES } from "@/lib/feedback/contract";
import { sanitiseFilename } from "@/lib/security/file-allowlist";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("exportStorageKey(jobId, part)", () => {
  it("part 1, or no part, is the key every archive has always had", () => {
    expect(exportStorageKey(ID)).toBe(`exports/${ID}.zip`);
    expect(exportStorageKey(ID, 1)).toBe(`exports/${ID}.zip`);
  });

  it("part n >= 2 is `-part-` and n padded to at least four digits, never truncated", () => {
    expect(exportStorageKey(ID, 2)).toBe(`exports/${ID}-part-0002.zip`);
    expect(exportStorageKey(ID, 9999)).toBe(`exports/${ID}-part-9999.zip`);
    expect(exportStorageKey(ID, 12345).endsWith("-part-12345.zip")).toBe(true);
  });

  it("refuses a part that is not a positive safe integer, and a non-uuid id", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => exportStorageKey(ID, bad), String(bad)).toThrow();
    }
    expect(() => exportStorageKey("../etc/passwd", 2)).toThrow(/uuid/);
  });
});

describe("parsePartParam", () => {
  it("no parameter is part 1; a plain positive number is that part", () => {
    expect(parsePartParam(null)).toBe(1);
    expect(parsePartParam("1")).toBe(1);
    expect(parsePartParam("12")).toBe(12);
    expect(parsePartParam("123456789")).toBe(123456789);
  });

  it("anything else is null -- the caller answers the indistinguishable 404", () => {
    for (const raw of ["", "0", "-1", "01", "1.0", "1e3", " 2", "2 ", "abc", "0x2", "1234567890"]) {
      expect(parsePartParam(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("parseResumeCursor", () => {
  const valid: ResumeCursor = {
    v: 1,
    phase: "tables",
    planIndex: 3,
    after: "6d3c1f0e-0000-4000-8000-000000000001",
    tableRowsSoFar: 3,
    rowCounts: { contacts: 3, companies: 4 },
    documents: [{ id: "6d3c1f0e-0000-4000-8000-0000000000aa", bytes: 10 }],
    withheldDocuments: [{ id: "6d3c1f0e-0000-4000-8000-0000000000bb", why: "not_clean" }],
    parts: [
      {
        part: 1,
        key: exportStorageKey(ID),
        bytes: 1234,
        rows: 7,
        slices: [{ table: "contacts", file: "tables/contacts.json", firstKey: "a", lastKey: "c", rows: 3 }],
        files: 0,
        closedBy: "rows_per_table",
      },
    ],
    generatedAt: "2026-10-13T12:00:00.000Z",
  };

  it("round-trips a valid cursor, through JSON as the database stores it", () => {
    expect(parseResumeCursor(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    for (const phase of ["tables", "files", "index"] as const) {
      expect(parseResumeCursor({ ...valid, phase })?.phase).toBe(phase);
    }
    expect(parseResumeCursor({ ...valid, after: "" })?.after).toBe("");
  });

  it("rejects each malformed field", () => {
    const bad: [string, unknown][] = [
      ["null", null],
      ["an array", []],
      ["a string", "{}"],
      ["the wrong version", { ...valid, v: 2 }],
      ["no version", { ...valid, v: undefined }],
      ["an unknown phase", { ...valid, phase: "documents" }],
      ["a negative planIndex", { ...valid, planIndex: -1 }],
      ["a fractional planIndex", { ...valid, planIndex: 1.5 }],
      ["a non-string after", { ...valid, after: 7 }],
      ["a negative tableRowsSoFar", { ...valid, tableRowsSoFar: -3 }],
      ["a negative row count", { ...valid, rowCounts: { contacts: -1 } }],
      ["a non-object rowCounts", { ...valid, rowCounts: [] }],
      ["a withheld document with an unknown why", { ...valid, withheldDocuments: [{ id: valid.documents[0].id, why: "nope" }] }],
      ["a withheld document that is not a uuid", { ...valid, withheldDocuments: [{ id: "x", why: "not_clean" }] }],
      ["a document with negative bytes", { ...valid, documents: [{ id: valid.documents[0].id, bytes: -1 }] }],
      ["a document id that is not a uuid", { ...valid, documents: [{ id: "contract.pdf", bytes: 1 }] }],
      // NO RECORD CONTENT: a filename riding along beside the id is refused.
      [
        "a document carrying its filename",
        { ...valid, documents: [{ id: valid.documents[0].id, bytes: 1, filename: "J Smith contract.pdf" }] },
      ],
      [
        "a withheld document carrying its filename",
        { ...valid, withheldDocuments: [{ id: valid.documents[0].id, why: "unreadable", what: "J Smith.pdf" }] },
      ],
      ["the old path-carrying shape", { ...valid, documents: undefined, files: [{ path: "files/documents/x-a.pdf", bytes: 1 }] }],
      ["a part with an unknown closedBy", { ...valid, parts: [{ ...valid.parts[0], closedBy: "whim" }] }],
      ["a part numbered 0", { ...valid, parts: [{ ...valid.parts[0], part: 0 }] }],
      [
        "a slice with negative rows",
        { ...valid, parts: [{ ...valid.parts[0], slices: [{ ...valid.parts[0].slices[0], rows: -1 }] }] },
      ],
      ["a non-string generatedAt", { ...valid, generatedAt: 5 }],
    ];
    for (const [label, value] of bad) {
      expect(parseResumeCursor(value), label).toBeNull();
    }
  });
});

describe("effectiveLimits", () => {
  const db = {
    page_size: 500,
    max_rows_per_table: 50_000,
    max_total_rows: 500_000,
    max_archive_bytes: 41_943_040,
    archive_days: 7,
  };

  it("with no override is the database's numbers, and 65 535 entries", () => {
    expect(effectiveLimits(db)).toEqual({ ...db, max_entries: 65_535 });
  });

  it("an override cannot loosen a ceiling (mutant T4)", () => {
    expect(effectiveLimits(db, { max_archive_bytes: db.max_archive_bytes * 2 }).max_archive_bytes).toBe(
      db.max_archive_bytes,
    );
    expect(effectiveLimits(db, { max_entries: 70_000 }).max_entries).toBe(65_535);
  });

  it("but can tighten every one", () => {
    expect(effectiveLimits(db, { max_archive_bytes: 1000 }).max_archive_bytes).toBe(1000);
    expect(
      effectiveLimits(db, { max_rows_per_table: 3, max_total_rows: 7, max_entries: 6, page_size: 2 }),
    ).toEqual({ ...db, max_rows_per_table: 3, max_total_rows: 7, max_entries: 6, page_size: 2 });
  });
});

describe("the manifest versions", () => {
  it("parts are version 3; an ordinary archive stays version 2", () => {
    expect(CLOSURE_PARTS_MANIFEST_VERSION).toBe(3);
    expect(EXPORT_MANIFEST_VERSION).toBe(2);
  });
});

// ===========================================================================
// THE CEILING PIN (spec § 2). A document's bytes are never split, so the
// largest file an upload can produce must fit an EMPTY part with room for its
// local header, its directory record, its name twice, the end record and the
// part manifest's base reserve. If the upload cap is ever raised past that,
// this is red -- rather than a closure backup that can never be built.
// ===========================================================================
describe("one uploaded file always fits one part", () => {
  // The longest name sanitiseFilename can produce, in UTF-8 bytes: its cap is
  // 200 UTF-16 code units, and the widest a BMP code unit gets is 3 bytes.
  const longest = Buffer.byteLength(
    `files/documents/${ID}-${sanitiseFilename("☃".repeat(500))}`,
    "utf8",
  );
  const NAME_BYTES = 1024;
  const overhead = PART_MANIFEST_BASE_RESERVE + 30 + 46 + 2 * NAME_BYTES + 22;

  it("DENOMINATOR: the 1024-byte name allowance covers the longest sanitised document path", () => {
    expect(longest).toBeGreaterThan(600);
    expect(longest).toBeLessThanOrEqual(NAME_BYTES);
  });

  it("the document upload cap", () => {
    expect(
      DOCUMENT_MAX_SIZE_BYTES + overhead,
      `DOCUMENT_MAX_SIZE_BYTES (${DOCUMENT_MAX_SIZE_BYTES}) plus a part's overhead no longer fits one part of a closure backup (${EXPORT_LIMITS.maxArchiveBytes} bytes): raising the upload cap past the part ceiling makes a backup that can never be built`,
    ).toBeLessThan(EXPORT_LIMITS.maxArchiveBytes);
  });

  it("the feedback screenshot cap", () => {
    expect(
      FEEDBACK_SCREENSHOT_MAX_BYTES + overhead,
      `FEEDBACK_SCREENSHOT_MAX_BYTES (${FEEDBACK_SCREENSHOT_MAX_BYTES}) plus a part's overhead no longer fits one part (${EXPORT_LIMITS.maxArchiveBytes} bytes)`,
    ).toBeLessThan(EXPORT_LIMITS.maxArchiveBytes);
  });
});

// ===========================================================================
// THE INDEX'S RESIDUAL BOUND (Q228 fix round 1). An index that does not fit
// the current part closes it and goes alone into the next; an index that does
// not fit an EMPTY part cannot be written at all, and is a named refusal.
// ===========================================================================
describe("placeIndex", () => {
  const AT = new Date("2026-10-13T12:00:00Z");

  it("an index larger than an EMPTY part is a named refusal", () => {
    const zip = new ZipWriter(1000);
    expect(() => placeIndex(zip, 2000, true)).toThrow(
      "the index of this backup is larger than one part of the backup can hold",
    );
  });

  it("DENOMINATOR: the same index in a part that already holds something closes that part instead", () => {
    const zip = new ZipWriter(1000);
    zip.addEntry("tables/a.json", Buffer.from("[]"), AT);
    expect(placeIndex(zip, 2000, false)).toBe("bytes");
  });

  it("names the entry ceiling when that is what refused it", () => {
    const zip = new ZipWriter(1_000_000, 2);
    zip.addEntry("a", Buffer.from("1"), AT);
    zip.addEntry("b", Buffer.from("2"), AT);
    expect(placeIndex(zip, 10, false)).toBe("entries");
  });

  it("and an index that fits goes here, even in an empty part", () => {
    expect(placeIndex(new ZipWriter(1000), 100, true)).toBe("here");
  });
});

describe("CLOSURE_BACKUP_STOPPED: the two refusals that stop a closure backup part-way (Q242)", () => {
  // Bound to the migration that raises them, so a renamed hint cannot leave
  // the runner falling back to the raw SQL message on the Owner's page.
  const migration = readFileSync("supabase/migrations/20261101002000_closure_backup_stops_when_reopened.sql", "utf8");

  it("names exactly the hints export_read_page raises for them", () => {
    expect(Object.keys(CLOSURE_BACKUP_STOPPED).sort()).toEqual([
      "closure_backup_requester_not_owner",
      "closure_backup_workspace_reopened",
    ]);
    for (const hint of Object.keys(CLOSURE_BACKUP_STOPPED)) {
      expect(migration, hint).toContain(`hint = '${hint}'`);
    }
  });

  it("each is a plain sentence with no SQL in it", () => {
    for (const sentence of Object.values(CLOSURE_BACKUP_STOPPED)) {
      expect(sentence).not.toMatch(/export_read_page|closure_backup_|[A-Z]{3,}/);
      expect(sentence).toMatch(/so the backup was stopped$/);
    }
  });

  it("is not fooled by an inherited key", () => {
    expect(Object.hasOwn(CLOSURE_BACKUP_STOPPED, "toString")).toBe(false);
  });
});
