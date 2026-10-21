import { describe, expect, it } from "vitest";
import {
  buildFeedbackEmail,
  buildIncidentAlertDigest,
  buildLockoutNotification,
  escapeHtml,
} from "@/lib/email/templates";
import { SUPPORT_ACCESS_LABEL } from "@/lib/feedback/contract";

// The three transactional bodies, as pure functions. The load-bearing property
// is ESCAPING: a feedback message is untrusted content and lands in an HTML
// body an email client renders.

const HOSTILE = `<script>alert("x")</script> & 'quotes'`;

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(HOSTILE)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;",
    );
  });
});

describe("buildFeedbackEmail", () => {
  const base = {
    feedbackId: "11111111-2222-4333-8444-555555555555",
    category: "bug" as const,
    message: HOSTILE,
    route: "/org-alpha/contacts/abc",
    submitterEmail: "someone@example.com",
    organisationName: "Alpha <Co>",
    organisationSlug: "org-alpha",
    organisationRole: "manager",
    userAgent: "Mozilla/5.0",
    screenshot: "clean" as const,
    siteUrl: "https://app.example.test/",
  };

  it("escapes the message and the workspace name in the HTML body", () => {
    const { html } = buildFeedbackEmail(base);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Alpha &lt;Co&gt;");
  });

  it("carries the message verbatim in the text body", () => {
    const { text } = buildFeedbackEmail(base);
    expect(text).toContain(HOSTILE);
    expect(text).toContain("Page: /org-alpha/contacts/abc");
    expect(text).toContain("Role: manager");
  });

  it("subject names the category and the workspace; the link points at the dashboard without a double slash", () => {
    const { subject, html } = buildFeedbackEmail(base);
    expect(subject).toBe("[Feedback · Bug] Alpha <Co>");
    expect(html).toContain('href="https://app.example.test/super/feedback"');
  });

  it("says when there was no workspace and no screenshot", () => {
    const { text, subject } = buildFeedbackEmail({
      ...base,
      organisationName: null,
      organisationSlug: null,
      organisationRole: null,
      screenshot: "none",
    });
    expect(subject).toContain("No workspace");
    expect(text).toContain("no workspace (submitted outside one)");
    expect(text).toContain("No screenshot attached.");
  });

  it("names a quarantined screenshot as not shown", () => {
    const { text } = buildFeedbackEmail({ ...base, screenshot: "quarantined" });
    expect(text).toMatch(/quarantined/);
  });
});

describe("buildIncidentAlertDigest", () => {
  const rows = [
    {
      id: "a1",
      alertType: "rate_limit_tripped",
      summary: "Rate limit exceeded: search (limit 60 per 60 seconds).",
      createdAt: "2026-09-11T10:00:00Z",
      organisationId: null,
    },
    {
      id: "a2",
      alertType: "upload_quarantined",
      summary: "A file upload was quarantined by the malware scanner.",
      createdAt: "2026-09-11T10:05:00Z",
      organisationId: "org-1",
    },
  ];

  it("counts, pluralises, lists every row and links to /super/health", () => {
    const { subject, text, html } = buildIncidentAlertDigest(rows, "https://app.example.test");
    expect(subject).toBe("[GetSetPaid] 2 new incident alerts");
    expect(text).toContain("a1");
    expect(text).toContain("a2");
    expect(text).toContain("[not attributed to a workspace]");
    expect(text).toContain("[org org-1]");
    expect(html).toContain('href="https://app.example.test/super/health"');
  });

  it("singular for one", () => {
    expect(buildIncidentAlertDigest(rows.slice(0, 1), "x").subject).toBe(
      "[GetSetPaid] 1 new incident alert",
    );
  });
});

// ===========================================================================
// THE ACCOUNT HOLDER'S LOCKOUT NOTICE (founder ruling Q114)
// ===========================================================================
// This one is read by a worried person who cannot sign in, so the copy IS the
// feature. Three things it must say -- the brief's own list -- and one whole
// category it must never say.
describe("buildLockoutNotification", () => {
  const body = buildLockoutNotification({
    lastAttemptAt: "2026-09-16T09:30:00.000Z",
    maxAttempts: 5,
    windowSeconds: 900,
    siteUrl: "https://app.example.test/",
  });

  it("says what happened, in the subject a person will scan", () => {
    expect(body.subject).toBe("Someone is trying to sign in to your GetSetPaid account");
  });

  it("says the password was NOT compromised by this", () => {
    expect(body.text).toContain("does NOT mean your password was compromised");
    expect(body.html).toContain("does not mean your password was compromised");
  });

  it("says how to get in right now -- the magic link and Google, the escape hatch", () => {
    expect(body.text).toContain("magic link");
    expect(body.text).toContain("Google");
    expect(body.html).toContain('href="https://app.example.test/login"');
  });

  it("quotes the policy's own numbers rather than a hardcoded sentence", () => {
    expect(body.text).toContain("15 minutes");
    expect(body.text).toContain("5 failed attempts");
    // The same builder must follow a policy change made by UPDATE, not by
    // editing this file -- the numbers come from the alert row.
    const changed = buildLockoutNotification({
      lastAttemptAt: "2026-09-16T09:30:00.000Z",
      maxAttempts: 3,
      windowSeconds: 1800,
      siteUrl: "x",
    });
    expect(changed.text).toContain("30 minutes");
    expect(changed.text).toContain("3 failed attempts");
  });

  // FIX ROUND 1, M6: the wait advice must not promise something the lockout
  // does not deliver. The window is fixed and epoch-aligned, so the remaining
  // lock is AT MOST the policy's minutes and usually less; and a sustained
  // attack re-crosses the threshold every window, which SECURITY.md § 5 calls
  // "indefinitely". "Wait N minutes and try again" was true in neither
  // direction.
  it("does not promise that waiting out the window works", () => {
    expect(body.text).toContain("at most 15 minutes");
    expect(body.text).toContain("re-locks if the attempts keep coming");
    expect(body.text).not.toContain("wait 15 minutes and try again");
    expect(body.html).not.toContain("wait <strong>15 minutes</strong>");
  });

  it("carries nothing about the attempts themselves -- no IP, no location, nothing typed", () => {
    const all = `${body.subject}
${body.text}
${body.html}`.toLowerCase();
    for (const forbidden of [
      "ip address",
      "attempted password",
      "the password used",
      "location",
      "user agent",
      "browser",
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it("says the notice went to nobody else", () => {
    expect(body.text).toContain("We do not tell anyone else");
  });
});

// ===========================================================================
// Q121: a support-access submission names no workspace, and says so
// ===========================================================================
describe("buildFeedbackEmail under support access", () => {
  const base = {
    feedbackId: "f1",
    category: "bug" as const,
    message: "the venue picker forgets my filter",
    route: "/org-alpha/venues",
    submitterEmail: "founder@example.test",
    organisationName: null,
    organisationSlug: null,
    organisationRole: null,
    userAgent: "vitest/1.0",
    screenshot: "none" as const,
    siteUrl: "https://app.example.test",
  };

  it("labels the workspace line and the subject, instead of reading as 'No workspace'", () => {
    const labelled = buildFeedbackEmail({ ...base, supportAccess: true });
    expect(labelled.subject).toContain(SUPPORT_ACCESS_LABEL);
    expect(labelled.text).toContain(SUPPORT_ACCESS_LABEL);
  });

  it("an ordinary workspace-less submission is NOT labelled", () => {
    const plain = buildFeedbackEmail(base);
    expect(plain.subject).toContain("No workspace");
    expect(plain.text).not.toContain(SUPPORT_ACCESS_LABEL);
  });
});
