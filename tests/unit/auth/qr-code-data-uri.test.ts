// Regression tests for the enrolment QR code (review NEW-2).
//
// The bug: components/auth/mfa-enroll-gate.tsx applied
// `data:image/svg+xml;utf-8,` + encodeURIComponent() to a value that was
// ALREADY a complete data URI, so the QR image never rendered for any user on
// any enrolment. It survived every source-only review because the manual key
// underneath is a working fallback -- enrolment still completes if you type
// the key, so nothing failed loudly.
//
// These pin the shape of the output rather than a golden string, because the
// SVG payload is ~360KB of generated markup that changes per enrolment.
import { describe, expect, it } from "vitest";
import { qrCodeDataUri } from "@/components/auth/mfa-enroll-gate";

const PREFIX = "data:image/svg+xml;utf-8,";
const SVG = '<svg width="231" height="231"><rect style="fill:white"/></svg>';

describe("qrCodeDataUri — the enrolment QR image source", () => {
  it("REGRESSION: does not double-prefix a value that is already a data URI", () => {
    const out = qrCodeDataUri(`${PREFIX}${SVG}`);

    // The exact failure signature of the bug: the prefix, percent-encoded,
    // appearing inside the payload.
    expect(out).not.toContain("data%3Aimage%2Fsvg%2Bxml");
    expect(out.indexOf(PREFIX)).toBe(0);
    expect(out.indexOf(PREFIX, 1)).toBe(-1);
  });

  it("round-trips back to exactly the original SVG", () => {
    const decoded = decodeURIComponent(
      qrCodeDataUri(`${PREFIX}${SVG}`).slice(PREFIX.length),
    );
    expect(decoded).toBe(SVG);
  });

  it("also handles a bare SVG, in case Supabase stops sending the prefix", () => {
    const decoded = decodeURIComponent(
      qrCodeDataUri(SVG).slice(PREFIX.length),
    );
    expect(decoded).toBe(SVG);
  });

  it("percent-encodes '#', which would otherwise truncate the URI at a fragment", () => {
    // Today's payload uses style="fill:white" and contains no '#'. This is the
    // property that keeps it safe if it ever uses hex colours instead.
    const withHash = '<svg><rect style="fill:#ffffff"/></svg>';
    const out = qrCodeDataUri(`${PREFIX}${withHash}`);

    expect(out).not.toContain("#");
    expect(decodeURIComponent(out.slice(PREFIX.length))).toBe(withHash);
  });

  it("produces something a browser will treat as an SVG image, not an empty src", () => {
    const out = qrCodeDataUri(`${PREFIX}${SVG}`);
    expect(out.startsWith("data:image/svg+xml;utf-8,%3Csvg")).toBe(true);
  });
});
