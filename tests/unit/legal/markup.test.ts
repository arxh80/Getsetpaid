import { describe, expect, it } from "vitest";
import {
  parseLegalMarkup,
  safeHref,
  type Block,
  type Inline,
} from "@/lib/legal/markup";
import { validateDraft } from "@/lib/legal/draft-validation";

// THE PARSER IS THE CHOKEPOINT between a stored legal text and the page, so
// the refusals are asserted here against hostile input -- and each refusal is
// paired with the accepted neighbour it must not be confused with, because a
// parser that dropped EVERY link would pass every "rejects javascript:" test.

function links(blocks: readonly Block[]): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const walk = (content: readonly Inline[]) => {
    for (const part of content) if (part.kind === "link") out.push({ text: part.text, href: part.href });
  };
  for (const b of blocks) {
    if (b.kind === "paragraph" || b.kind === "heading") walk(b.content);
    if (b.kind === "list") b.items.forEach(walk);
  }
  return out;
}

function text(blocks: readonly Block[]): string {
  const parts: string[] = [];
  const walk = (content: readonly Inline[]) => {
    for (const p of content) parts.push(p.kind === "support-email" ? "<EMAIL>" : p.text);
  };
  for (const b of blocks) {
    if (b.kind === "paragraph" || b.kind === "heading") walk(b.content);
    if (b.kind === "list") b.items.forEach(walk);
  }
  return parts.join("|");
}

describe("safeHref -- the one link-target check", () => {
  it.each([
    "https://ico.org.uk/make-a-complaint/",
    "HTTPS://example.com/x",
    "mailto:someone@example.test",
    "/legal/privacy",
    "/legal/privacy#rights",
    "/",
  ])("ALLOWS %s", (href) => {
    expect(safeHref(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "DATA:text/html,x",
    "vbscript:msgbox(1)",
    "http://example.com",
    "//evil.example/path",
    "/\\evil.example",
    "https://",
    "mailto:not-an-address",
    "mailto:a@b.c?bcc=x@y.z extra",
    "relative/path",
    "",
    "/legal/privacy onmouseover=x",
    "/legal/<script>",
  ])("REFUSES %j", (href) => {
    expect(safeHref(href)).toBeNull();
  });
});

describe("parseLegalMarkup -- links", () => {
  it("keeps an allowed link as a link (the positive control)", () => {
    const { blocks, problems } = parseLegalMarkup("See [the ICO](https://ico.org.uk/) now.");
    expect(problems).toEqual([]);
    expect(links(blocks)).toEqual([{ text: "the ICO", href: "https://ico.org.uk/" }]);
  });

  it.each([
    "[click](javascript:alert(document.cookie))",
    "[click](JAVASCRIPT:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD4=)",
    "[click](//evil.example)",
    "[click]( javascript:alert(1))",
  ])("drops %j to its text and reports it", (source) => {
    const { blocks, problems } = parseLegalMarkup(source);
    expect(links(blocks)).toEqual([]);
    expect(text(blocks)).toContain("click");
    expect(text(blocks)).not.toMatch(/javascript|data:/i);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/is not allowed/);
  });
});

describe("parseLegalMarkup -- disallowed markup is stripped", () => {
  it.each([
    "<script>alert(1)</script>Hello",
    "<img src=x onerror=alert(1)>Hello",
    "<a href=\"javascript:alert(1)\">Hello</a>",
    "<!-- note -->Hello",
    "<SCRIPT>alert(1)</SCRIPT>Hello",
  ])("removes the tags from %j and says so", (source) => {
    const { blocks, problems } = parseLegalMarkup(source);
    const rendered = text(blocks);
    expect(rendered).not.toMatch(/<\s*\/?\s*[a-z!]/i);
    expect(rendered).not.toMatch(/onerror|javascript/i);
    expect(rendered).toContain("Hello");
    expect(problems.join(" ")).toMatch(/HTML tags are not allowed/);
  });

  it("leaves a bare < that opens no tag alone", () => {
    const { blocks, problems } = parseLegalMarkup("Fewer than <5 staff, or 3 < 4.");
    expect(problems).toEqual([]);
    expect(text(blocks)).toBe("Fewer than <5 staff, or 3 < 4.");
  });

  it("does not treat markdown images as anything but text", () => {
    const { blocks } = parseLegalMarkup("![x](https://example.com/a.png)");
    // The link survives as a link (its target is allowed); the `!` is text.
    // There is no image kind at all, so nothing can load a remote resource.
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        content: [
          { kind: "text", text: "!" },
          { kind: "link", text: "x", href: "https://example.com/a.png" },
        ],
      },
    ]);
  });
});

describe("parseLegalMarkup -- structure", () => {
  it("parses headings, paragraphs, lists and the block placeholders", () => {
    const { blocks, problems } = parseLegalMarkup(
      [
        "## Section",
        "",
        "First line",
        "continues here with **bold**.",
        "",
        "- one",
        "- two",
        "  continued",
        "",
        "1. first",
        "2. second",
        "",
        "### Sub",
        "{{subprocessors}}",
        "",
        "{{storage_inventory}}",
        "Write to {{support_email}}.",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "heading",
      "subprocessors",
      "storage-inventory",
      "paragraph",
    ]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      content: [
        { kind: "text", text: "First line continues here with " },
        { kind: "strong", text: "bold" },
        { kind: "text", text: "." },
      ],
    });
    expect(blocks[2]).toEqual({
      kind: "list",
      ordered: false,
      items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two continued" }]],
    });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toMatchObject({ kind: "heading", level: 3 });
    expect(blocks[7]).toEqual({
      kind: "paragraph",
      content: [
        { kind: "text", text: "Write to " },
        { kind: "support-email" },
        { kind: "text", text: "." },
      ],
    });
  });

  it("refuses an # heading (the page title is the document title) but still renders it as a section", () => {
    const { blocks, problems } = parseLegalMarkup("# Big");
    expect(problems.join(" ")).toMatch(/headings are not allowed/);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
  });

  it("drops an unknown placeholder and a block placeholder used inline", () => {
    const { blocks, problems } = parseLegalMarkup("A {{secret_key}} and {{subprocessors}} inline.");
    expect(text(blocks)).toBe("A  and  inline.");
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/not a known placeholder/);
    expect(problems.join(" ")).toMatch(/must be on a line of its own/);
  });
});

describe("validateDraft -- save-time refusals, beside their fields", () => {
  const ok = { title: "Cookie Policy", body: "Intro\n\n{{storage_inventory}}", effectiveDate: "2026-09-22" };

  it("accepts a valid draft (the positive control)", () => {
    expect(validateDraft("cookies", ok)).toEqual({ ok: true, value: ok });
  });

  it("refuses a Cookie Policy without its generated table", () => {
    const result = validateDraft("cookies", { ...ok, body: "Intro only." });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.body).toMatch(/must contain \{\{storage_inventory\}\}/);
  });

  it("refuses a contact page without the contact placeholder, and a subprocessor page without its table", () => {
    expect(validateDraft("contact", { ...ok, body: "Email us." }).ok).toBe(false);
    expect(validateDraft("vulnerability-disclosure", { ...ok, body: "Email us." }).ok).toBe(false);
    expect(validateDraft("subprocessors", { ...ok, body: "None." }).ok).toBe(false);
    // ...and does not demand those placeholders of a page that needs none.
    expect(validateDraft("terms", { ...ok, body: "Terms." }).ok).toBe(true);
  });

  it("refuses a hostile link, a tag, a blank title and an impossible date", () => {
    const result = validateDraft("terms", {
      title: "   ",
      body: "[x](javascript:alert(1)) <b>bold</b>",
      effectiveDate: "2026-02-30",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors).sort()).toEqual(["body", "effectiveDate", "title"]);
      expect(result.fieldErrors.body).toMatch(/not allowed/);
      expect(result.fieldErrors.body).toMatch(/HTML tags/);
    }
  });
});
