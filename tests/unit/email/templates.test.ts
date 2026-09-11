import { describe, expect, it } from "vitest";
import {
  buildFeedbackEmail,
  buildIncidentAlertDigest,
  escapeHtml,
} from "@/lib/email/templates";

// The two transactional bodies, as pure functions. The load-bearing property
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
