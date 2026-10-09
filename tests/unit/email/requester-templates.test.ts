import { describe, expect, it } from "vitest";
import {
  NOTICE_INPUT_ALLOWLIST,
  NoticeContentError,
  buildDsrClosedNotice,
  buildDsrReceivedNotice,
  buildErasureFailureNotice,
  buildExportReadyNotice,
} from "@/lib/email/requester-templates";

// THE CONTENT ALLOWLIST of the four DSR / export / erasure notices (founder
// 2026-09-30, Q157(3)/Q174/Q45). Each builder refuses -- at runtime, on every
// render -- an input carrying any key outside its allowlist, and a body
// carrying any URL but its one in-app link. A PLANT of each forbidden field
// is the test: the field the real row has, handed in the way a careless
// `...row` spread would hand it.

const SITE = "https://app.example.test";
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

function urls(body: { subject: string; text: string; html: string }): string[] {
  return [...`${body.subject}\n${body.text}\n${body.html}`.matchAll(URL_RE)].map((m) => m[0]);
}

const received = { reference: 42, rightType: "access", dueBy: "2026-11-03T10:00:00.000Z", siteUrl: SITE };
const closed = { reference: 42, rightType: "erasure", status: "rejected", siteUrl: SITE };
const ready = { kind: "account" as const, organisationSlug: null, expiresAt: "2026-10-11T10:00:00.000Z", siteUrl: SITE };
const failure = { count: 3, siteUrl: SITE };

describe("the allowlists are exactly what the builders are documented to take", () => {
  it("names four notices and no free-text, address, key or URL field", () => {
    expect(NOTICE_INPUT_ALLOWLIST).toEqual({
      dsrReceived: ["reference", "rightType", "dueBy", "siteUrl"],
      dsrClosed: ["reference", "rightType", "status", "siteUrl"],
      exportReady: ["kind", "organisationSlug", "expiresAt", "siteUrl"],
      erasureFailure: ["count", "siteUrl"],
    });
  });
});

describe("DSR received", () => {
  it("renders the reference, the right, the UK-local due date and ONE link to the requester's page", () => {
    const body = buildDsrReceivedNotice(received);
    expect(body.subject).toBe("We received your data request (#42)");
    expect(body.text).toContain("A copy of my data (access)");
    expect(body.text).toContain("3 November 2026");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/account/data-requests`]));
  });

  it.each([
    ["detail", "PLANTED DETAIL"],
    ["user_email", "snapshot@test.local"],
    ["email", "someone@test.local"],
    ["rejectionReason", "PLANTED REASON"],
    ["userId", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
  ])("refuses a planted %s", (key, value) => {
    expect(() => buildDsrReceivedNotice({ ...received, [key]: value } as typeof received)).toThrow(NoticeContentError);
  });
});

describe("DSR closed", () => {
  it("names the outcome but NOT the rejection reason (it points at the page)", () => {
    const body = buildDsrClosedNotice(closed);
    expect(body.subject).toBe("Your data request #42 is closed: Refused");
    expect(body.text).toContain("The reason is on your account page");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/account/data-requests`]));
  });

  it("refuses a planted rejection reason and a planted detail", () => {
    expect(() => buildDsrClosedNotice({ ...closed, rejection_reason: "PLANTED" } as typeof closed)).toThrow(NoticeContentError);
    expect(() => buildDsrClosedNotice({ ...closed, detail: "PLANTED" } as typeof closed)).toThrow(NoticeContentError);
  });

  it("refuses a status that is not closed", () => {
    expect(() => buildDsrClosedNotice({ ...closed, status: "open" })).toThrow(/not a closed status/);
  });
});

describe("export ready -- the page, never the file or a signed URL", () => {
  it("links the account export page and nothing else", () => {
    const body = buildExportReadyNotice(ready);
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/account/exports`]));
    expect(body.text).toContain("not attached to this email");
    expect(body.text).toContain("11 October 2026");
  });

  it("links a workspace export to that workspace's export page", () => {
    const body = buildExportReadyNotice({ ...ready, kind: "workspace", organisationSlug: "org-alpha" });
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/org-alpha/settings/export`]));
  });

  it.each([
    ["storageKey", "exports/3c95bee7-c40f-4713-ae99-69c053d92005.zip"],
    ["storage_key", "exports/3c95bee7-c40f-4713-ae99-69c053d92005.zip"],
    ["signedUrl", `${SITE}/storage/v1/object/sign/exports/x.zip?token=abc`],
    ["url", `${SITE}/storage/v1/object/sign/exports/x.zip?token=abc`],
    ["manifest", "{}"],
    ["jobId", "3c95bee7-c40f-4713-ae99-69c053d92005"],
  ])("refuses a planted %s", (key, value) => {
    expect(() => buildExportReadyNotice({ ...ready, [key]: value } as typeof ready)).toThrow(NoticeContentError);
  });

  it("refuses a slug that would smuggle a URL or a path in", () => {
    for (const slug of ["x/../../storage/v1/object/sign/exports/a.zip?token=1", "https://evil.test", "", null]) {
      expect(() => buildExportReadyNotice({ ...ready, kind: "workspace", organisationSlug: slug })).toThrow(NoticeContentError);
    }
  });
});

describe("erasure failure -- a count and a /super link, to the superuser", () => {
  it("carries the count and one link", () => {
    const body = buildErasureFailureNotice(failure);
    expect(body.subject).toBe("[GetSetPaid] 3 erasure jobs failed");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/super/data-requests`]));
  });

  it.each([
    ["subjectUserId", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
    ["subject_user_id", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
    ["email", "erased@test.local"],
    ["failureReason", "PLANTED REASON"],
    ["organisationId", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"],
    ["ids", ["x"]],
  ])("refuses a planted %s", (key, value) => {
    expect(() => buildErasureFailureNotice({ ...failure, [key]: value } as typeof failure)).toThrow(NoticeContentError);
  });

  it("refuses a non-positive or non-integer count", () => {
    expect(() => buildErasureFailureNotice({ ...failure, count: 0 })).toThrow(NoticeContentError);
    expect(() => buildErasureFailureNotice({ ...failure, count: 1.5 })).toThrow(NoticeContentError);
  });
});

describe("a broken origin cannot smuggle markup or a second URL in", () => {
  it("refuses a siteUrl carrying markup (the one-link check)", () => {
    expect(() => buildErasureFailureNotice({ count: 1, siteUrl: 'https://app.example.test"><script>' })).toThrow(
      NoticeContentError,
    );
  });
});
