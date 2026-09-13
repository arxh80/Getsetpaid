import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import {
  DOCUMENT_MAX_SIZE_BYTES,
  SERVER_ACTION_BODY_SIZE_LIMIT,
} from "@/lib/security/upload-limits";
import { readSource as read } from "../../support/source";

// THE CAP AND THE PROMISE, HELD TOGETHER.
//
// The defect these guard was not a missing config line -- it was that nothing
// connected the framework's body cap to the 25 MiB the product states in three
// places. `next.config.ts` said nothing, so Next applied its 1 MB default,
// while `uploadDocumentAction` checked 25 MiB and rendered a sentence about a
// limit the framework had already made unreachable. An ordinary 2 MB PDF died
// with a generic error on a page promising 25 MiB.
//
// So adding the line is not the fix. The fix is that raising a promise without
// raising the cap now fails here, and that the two numbers cannot drift apart
// silently again.
//
// WHAT THIS DELIBERATELY DOES NOT DO: parse a size string. The cap is a byte
// number, so there is no string and no second parser. A test that carried its
// own parser would agree with Next's right up until Next changed, and then
// keep passing while real uploads failed -- see the module header.

/** Multipart framing plus the form's other fields: hundreds of bytes, not MiB. */
const MULTIPART_HEADROOM_BYTES = 64 * 1024;

/** What Next applies when `bodySizeLimit` is unset. The bug, in one number. */
const NEXT_DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

describe("the Server Action body cap covers what the product promises", () => {
  it("next.config.ts sets exactly this cap, in the one place", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe(
      SERVER_ACTION_BODY_SIZE_LIMIT,
    );
  });

  it("the cap is a number of bytes, not a size string", () => {
    // Not style. A string would be parsed by Next with the `bytes` package,
    // and asserting its value here would need a SECOND parser that agrees with
    // Next's only until Next changes. `SizeLimit` accepts a number, so the
    // question is removed rather than answered.
    expect(typeof SERVER_ACTION_BODY_SIZE_LIMIT).toBe("number");
    expect(Number.isInteger(SERVER_ACTION_BODY_SIZE_LIMIT)).toBe(true);
  });

  it("the cap clears the documents promise plus multipart headroom", () => {
    // The promise itself would be too tight: a file just OVER 25 MiB has to
    // reach the action so the user reads the app's own sentence rather than a
    // framework error.
    expect(DOCUMENT_MAX_SIZE_BYTES).toBe(25 * 1024 * 1024);
    expect(SERVER_ACTION_BODY_SIZE_LIMIT).toBeGreaterThanOrEqual(
      DOCUMENT_MAX_SIZE_BYTES + MULTIPART_HEADROOM_BYTES,
    );
  });

  it("the cap is above the 1 MB default that shipped the bug", () => {
    expect(SERVER_ACTION_BODY_SIZE_LIMIT).toBeGreaterThan(
      NEXT_DEFAULT_BODY_LIMIT_BYTES,
    );
  });

  it("the documents action enforces the SHARED constant, not a copy", () => {
    // The original defect's other half: the 25 MiB ceiling was a private
    // constant inside lib/crm/documents.ts, so nothing else could see it and
    // next.config.ts had nothing to be checked against. A re-declared literal
    // there would pass every assertion above while drifting from the cap.
    const src = read("lib/crm/documents.ts");
    expect(src).toContain(
      'import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/security/upload-limits"',
    );
    expect(src).toContain("file.size > DOCUMENT_MAX_SIZE_BYTES");
    expect(
      /const\s+\w*MAX_SIZE_BYTES\s*=/.test(src),
      "lib/crm/documents.ts re-declares a size ceiling instead of importing " +
        "the shared one -- that is how the cap and the promise drifted apart",
    ).toBe(false);
  });

  it("the database and the bucket agree with the promise", () => {
    // The number is enforced in three places and this is the one that can see
    // all of them at once. If a migration raises the column CHECK or the
    // bucket cap, the promise here must move with it -- and then the cap
    // assertion above forces the framework limit to follow.
    const table = read(
      "supabase/migrations/20260902001000_documents_table.sql",
    );
    const bucket = read(
      "supabase/migrations/20260902030000_documents_storage_bucket.sql",
    );
    expect(table).toContain(`size_bytes <= ${DOCUMENT_MAX_SIZE_BYTES}`);
    expect(bucket).toContain(String(DOCUMENT_MAX_SIZE_BYTES));
  });
});
