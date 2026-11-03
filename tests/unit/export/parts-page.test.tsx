import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobPartsList } from "@/components/account/export-job-list";
import { parsePartsCursor, partsCursorParam } from "@/lib/export/contract";
import { PARTS_PAGE_SIZE, pageOfParts, partsPageFor, type OwnExportJob, type PartRow } from "@/lib/export/jobs";

// Q228 FINAL REVIEW I2: THE PARTS LIST PAGES ONE BACKUP AT A TIME, BOTH WAYS.
//
// The workspace export page listed a multi-part backup's parts fifty at a
// time with ONE shared `?partsFrom=` for every listed backup, no way back to
// the first page, and nothing at all for a backup whose page came back empty.
// None of it was tested. These are the pure halves: the page boundary, the
// job-scoped cursor, and the list's links as the server renders them.

const JOB = "6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a7b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

function rows(from: number, count: number): PartRow[] {
  return Array.from({ length: count }, (_, i) => ({ part_no: from + i, byte_size: String(1024 * (from + i)) }));
}

function job(partCount: number): OwnExportJob {
  return {
    id: JOB,
    kind: "workspace",
    organisationId: OTHER,
    status: "succeeded",
    requestedAt: "2026-10-16T09:00:00Z",
    completedAt: "2026-10-16T10:00:00Z",
    expiresAt: "2026-11-15T10:00:00Z",
    byteSize: 1,
    rowCount: 1,
    tableCount: 1,
    failureReason: null,
    manifest: null,
    closureBackup: true,
    partCount,
  };
}

const href = (jobId: string, from: number) => `/ws/settings/export?parts=${partsCursorParam(jobId, from)}`;

function render(partCount: number, from: number, available: number): string {
  // What getExportJobParts reads: part_no >= from, limit + 1 rows.
  const page = pageOfParts(rows(from, Math.max(0, Math.min(PARTS_PAGE_SIZE + 1, available - from + 1))), PARTS_PAGE_SIZE);
  return renderToStaticMarkup(
    <JobPartsList job={job(partCount)} page={{ ...page, total: partCount }} partsHref={href} />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("pageOfParts: the boundary at exactly one page", () => {
  it("50 rows is one page and no next", () => {
    const page = pageOfParts(rows(1, 50), 50);
    expect(page.parts.map((p) => p.part)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(page.nextFrom).toBeNull();
  });

  it("51 rows is one page of 50, and the 51st is the next page's first", () => {
    const page = pageOfParts(rows(1, 51), 50);
    expect(page.parts).toHaveLength(50);
    expect(page.parts.at(-1)?.part).toBe(50);
    expect(page.nextFrom).toBe(51);
  });

  it("a byte size read as text is a number", () => {
    expect(pageOfParts([{ part_no: 2, byte_size: "41943040" }], 50).parts).toEqual([{ part: 2, byteSize: 41943040 }]);
  });
});

describe("parsePartsCursor: one job's page, never an error", () => {
  it("reads back what partsCursorParam writes", () => {
    expect(parsePartsCursor(partsCursorParam(JOB, 51))).toEqual({ jobId: JOB, from: 51 });
    expect(parsePartsCursor(partsCursorParam(JOB.toUpperCase(), 2))).toEqual({ jobId: JOB, from: 2 });
  });

  it.each([null, undefined, "", "51", JOB, `${JOB}:`, `${JOB}:0`, `${JOB}:01`, `${JOB}:-1`, `${JOB}:abc`, `not-a-uuid:51`, `${JOB}:51:2`])(
    "%j is no cursor (every job on its first page)",
    (raw) => {
      expect(parsePartsCursor(raw)).toBeNull();
    },
  );
});

describe("JobPartsList: next, previous, and never silently nothing", () => {
  it("page one of 75: parts 1-50, a next link to 51 for THIS job, no previous", () => {
    const html = render(75, 1, 75);
    expect(count(html, 'data-testid="export-part-download"')).toBe(50);
    expect(html).toContain("Part 1 of 75");
    expect(html).toContain("Part 50 of 75");
    expect(html).not.toContain("Part 51 of 75");
    expect(html).toContain(`href="${href(JOB, 51)}"`);
    expect(html).toContain("Show parts 51 to 75");
    expect(html).not.toContain('data-testid="export-parts-previous"');
  });

  it("page two of 75: parts 51-75, a previous link back to part 1, no next", () => {
    const html = render(75, 51, 75);
    expect(count(html, 'data-testid="export-part-download"')).toBe(25);
    expect(html).toContain("Part 51 of 75");
    expect(html).toContain("Part 75 of 75");
    expect(html).toContain(`href="${href(JOB, 1)}"`);
    expect(html).toContain("Show parts 1 to 50");
    expect(html).not.toContain('data-testid="export-parts-next"');
  });

  it("a middle page links both ways", () => {
    const html = render(120, 51, 120);
    expect(html).toContain("Show parts 1 to 50");
    expect(html).toContain("Show parts 101 to 120");
  });

  it("exactly 50 parts: one page, no paging links at all", () => {
    const html = render(50, 1, 50);
    expect(count(html, 'data-testid="export-part-download"')).toBe(50);
    expect(html).not.toContain("Show parts");
  });

  it("an empty page says so rather than rendering nothing", () => {
    const html = renderToStaticMarkup(
      <JobPartsList job={job(12)} page={{ parts: [], nextFrom: null, total: 12 }} partsHref={href} />,
    );
    expect(html).toContain('data-testid="export-parts-unlisted"');
    expect(html).toContain("could not be listed");
    expect(html).not.toContain('data-testid="export-part-download"');
  });
});

describe("partsPageFor: the cursor pages ITS job only, and an empty page falls back", () => {
  // A fake reader over two backups, 75 and 12 parts, recording every call.
  function reader() {
    const calls: [string, number][] = [];
    const totals: Record<string, number> = { [JOB]: 75, [OTHER]: 12 };
    const read = async (jobId: string, from: number) => {
      calls.push([jobId, from]);
      const n = Math.max(0, Math.min(PARTS_PAGE_SIZE + 1, totals[jobId] - from + 1));
      return pageOfParts(rows(from, n), PARTS_PAGE_SIZE);
    };
    return { calls, read };
  }

  it("the named job gets its page; the other backup stays on page one (review scenario 2)", async () => {
    const { calls, read } = reader();
    const cursor = { jobId: JOB, from: 51 };
    const mine = await partsPageFor(JOB, cursor, read);
    const other = await partsPageFor(OTHER, cursor, read);
    expect(mine.parts[0].part).toBe(51);
    expect(other.parts.map((p) => p.part)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(calls).toEqual([
      [JOB, 51],
      [OTHER, 1],
    ]);
  });

  it("no cursor is page one for everybody", async () => {
    const { calls, read } = reader();
    await partsPageFor(JOB, null, read);
    expect(calls).toEqual([[JOB, 1]]);
  });

  it("a stale cursor past the last part falls back to page one rather than an empty list", async () => {
    const { calls, read } = reader();
    const page = await partsPageFor(OTHER, { jobId: OTHER, from: 999 }, read);
    expect(page.parts[0].part).toBe(1);
    expect(page.parts).toHaveLength(12);
    expect(calls).toEqual([
      [OTHER, 999],
      [OTHER, 1],
    ]);
  });
});
