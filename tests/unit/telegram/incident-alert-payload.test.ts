import { describe, expect, it } from "vitest";

// THE TELEGRAM PAYLOAD'S ALLOWLIST (founder 2026-09-30, Q111): alert type,
// counts and a /super/health link ONLY -- no personal data, no tenant content,
// no emails, no ids. Telegram is outside the UK/EU (SECURITY.md § 12, Q198),
// so this file is the evidence for "no personal data by construction".
//
// THE DENOMINATOR (standing lesson 1): every "nothing leaked" assertion below
// runs on rows that DO carry an email, an id, a summary and an organisation
// id, cast past the builder's input type the way a careless future caller
// would, so an absence means the builder dropped them -- not that they were
// never offered.

import {
  TELEGRAM_COUNT_FIELDS,
  TELEGRAM_PAYLOAD_FIELDS,
  assertTelegramPayloadAllowlisted,
  buildTelegramAlertPayload,
  renderTelegramAlertText,
  type TelegramAlertInput,
} from "@/lib/telegram/incident-alert-payload";

const SITE = "https://app.example.test";
const EMAIL = "victim@example.test";
const ALERT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "99999999-8888-4777-8666-555555555555";
const SUMMARY = "Rate limit crossed by Neon Nights Ltd";

// Rows shaped like a full incident_alerts read, smuggled in through a cast.
const leakyRows = [
  { alertType: "rate_limit_tripped", id: ALERT_ID, summary: SUMMARY, organisationId: ORG_ID, email: EMAIL },
  { alertType: "rate_limit_tripped", id: "a2", summary: `${EMAIL} again`, organisationId: ORG_ID },
  { alertType: "upload_quarantined", id: "a3", summary: "invoice.exe", details: { document_id: ALERT_ID } },
  { alertType: "<script>not_a_type", id: "a4", summary: "x" },
] as unknown as TelegramAlertInput[];

describe("buildTelegramAlertPayload", () => {
  it("carries exactly the allowlisted fields, and every count exactly its own", () => {
    const payload = buildTelegramAlertPayload(leakyRows, SITE);
    expect(Object.keys(payload).sort()).toEqual([...TELEGRAM_PAYLOAD_FIELDS].sort());
    expect(payload.counts.length).toBeGreaterThan(0);
    for (const entry of payload.counts) {
      expect(Object.keys(entry).sort()).toEqual([...TELEGRAM_COUNT_FIELDS].sort());
    }
    expect(() => assertTelegramPayloadAllowlisted(payload)).not.toThrow();
  });

  it("counts by type, folds an unknown type into `other`, and totals the rows", () => {
    const payload = buildTelegramAlertPayload(leakyRows, SITE);
    expect(payload).toEqual({
      counts: [
        { alertType: "other", count: 1 },
        { alertType: "rate_limit_tripped", count: 2 },
        { alertType: "upload_quarantined", count: 1 },
      ],
      total: 4,
      link: `${SITE}/super/health`,
    });
  });

  it("the serialised payload and the rendered text contain no id, email, summary or org id", () => {
    const payload = buildTelegramAlertPayload(leakyRows, SITE);
    const text = renderTelegramAlertText(payload);
    for (const surface of [JSON.stringify(payload), text]) {
      for (const forbidden of [EMAIL, ALERT_ID, ORG_ID, SUMMARY, "invoice.exe", "a2", "<script>", "@"]) {
        expect(surface, `"${forbidden}" reached the Telegram payload`).not.toContain(forbidden);
      }
    }
    // ...and the denominator: the text DID render the counts and the link.
    expect(text).toContain("Rate limit tripped: 2");
    expect(text).toContain("Other: 1");
    expect(text).toContain(`${SITE}/super/health`);
  });

  it("the link is /super/health on this site, whatever trailing slash the site URL has", () => {
    expect(buildTelegramAlertPayload([], `${SITE}/`).link).toBe(`${SITE}/super/health`);
  });
});

describe("assertTelegramPayloadAllowlisted -- a PLANTED forbidden field reddens it", () => {
  const good = () => buildTelegramAlertPayload(leakyRows, SITE);

  it.each([
    ["a top-level summary", (p: Record<string, unknown>) => ({ ...p, summary: SUMMARY })],
    ["a top-level email", (p: Record<string, unknown>) => ({ ...p, email: EMAIL })],
    ["an alert id on a count", (p: Record<string, unknown>) => ({
      ...p,
      counts: [{ ...(p.counts as object[])[0], id: ALERT_ID }],
    })],
    ["an organisation id on a count", (p: Record<string, unknown>) => ({
      ...p,
      counts: [{ ...(p.counts as object[])[0], organisationId: ORG_ID }],
    })],
    ["an alert type outside the vocabulary", (p: Record<string, unknown>) => ({
      ...p,
      counts: [{ alertType: EMAIL, count: 1 }],
    })],
    ["a link that is not /super/health", (p: Record<string, unknown>) => ({
      ...p,
      link: `${SITE}/super/health?email=${EMAIL}`,
    })],
  ])("refuses %s", (_label, plant) => {
    const planted = plant(good() as unknown as Record<string, unknown>);
    expect(() => assertTelegramPayloadAllowlisted(planted)).toThrow(/telegram payload/);
    // The render path runs the same check, so a planted field never becomes text.
    expect(() => renderTelegramAlertText(planted as never)).toThrow(/telegram payload/);
  });
});
