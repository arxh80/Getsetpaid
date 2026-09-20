import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalBody } from "@/components/legal/legal-body";
import { LegalDocumentView } from "@/components/legal/legal-document-view";
import { supportContact, UNSET_CONTACT_SENTENCE } from "@/lib/legal/contact";
import { BROWSER_STORAGE } from "@/lib/legal/storage-inventory";
import { SUB_PROCESSORS } from "@/lib/legal/sub-processors";

// THE RENDERED OUTPUT, not the parser's data: what a browser would actually
// receive for hostile stored text. renderToStaticMarkup is the server
// renderer these components run under in production.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function render(source: string, contactAddress: string | null = null): string {
  return renderToStaticMarkup(<LegalBody source={source} contactAddress={contactAddress} />);
}

describe("the rendered body carries no executable link or markup", () => {
  it("POSITIVE CONTROL: an allowed link renders as an anchor with its href", () => {
    const html = render("See [the ICO](https://ico.org.uk/make-a-complaint/) and [privacy](/legal/privacy).");
    expect(html).toContain('href="https://ico.org.uk/make-a-complaint/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="/legal/privacy"');
  });

  it.each([
    "[x](javascript:alert(document.cookie))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.example/)",
  ])("renders %j with no href at all", (source) => {
    const html = render(source);
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toMatch(/javascript:|data:|vbscript:|evil\.example/i);
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=https://evil.example></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<svg onload=alert(1)>",
  ])("renders %j with no element it did not come from", (source) => {
    const html = render(`Before ${source} after`);
    expect(html).not.toMatch(/<(script|img|iframe|svg)\b/i);
    expect(html).not.toMatch(/onerror|onload|javascript:/i);
    expect(html).toContain("Before");
    expect(html).toContain("after");
  });

  it("escapes what is left as text rather than interpreting it", () => {
    // A bare `<` that opens no tag stays in the text, and React escapes it.
    const html = render('3 < 4 & "quoted"');
    expect(html).toContain("3 &lt; 4 &amp; &quot;quoted&quot;");
  });
});

describe("the contact placeholder is filled from configuration", () => {
  it("renders a mailto link when an address is configured", () => {
    const html = render("Email {{support_email}}.", "help@example.test");
    expect(html).toContain('href="mailto:help@example.test"');
    expect(html).toContain(">help@example.test</a>");
    expect(html).not.toContain("{{support_email}}");
  });

  it("says so in words when it is not, and never renders an empty link", () => {
    const html = render("Email {{support_email}}.", null);
    expect(html).toContain(UNSET_CONTACT_SENTENCE);
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toContain("{{support_email}}");
  });

  // Fix round 1, M3: these rendered the literal placeholder, with neither an
  // address nor the "not configured" sentence.
  it.each([
    "Email **{{support_email}}** today.",
    "[{{support_email}}](/legal/contact)",
    "Our providers: {{subprocessors}}",
  ])("never renders a raw placeholder, even for text the save path refuses: %j", (source) => {
    for (const address of ["help@example.test", null]) {
      const html = render(source, address);
      expect(html).not.toContain("{{");
      expect(html).not.toContain("}}");
    }
  });

  it("treats a malformed or injected configured value as unset", () => {
    expect(supportContact({ SUPPORT_CONTACT_EMAIL: "" }).address).toBeNull();
    expect(supportContact({}).address).toBeNull();
    expect(supportContact({ SUPPORT_CONTACT_EMAIL: "not an address" }).address).toBeNull();
    expect(supportContact({ SUPPORT_CONTACT_EMAIL: "a@b.co?bcc=x@y.co" }).address).toBeNull();
    expect(supportContact({ SUPPORT_CONTACT_EMAIL: 'a@b.co"><script>' }).address).toBeNull();
    // Positive control.
    expect(supportContact({ SUPPORT_CONTACT_EMAIL: " founder@example.test " }).address).toBe(
      "founder@example.test",
    );
  });
});

describe("the generated tables come from code", () => {
  it("renders every storage item and every subprocessor", () => {
    const html = render("{{storage_inventory}}\n\n{{subprocessors}}");
    const unescaped = html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#x27;", "'");
    expect(BROWSER_STORAGE.length).toBe(4);
    for (const item of BROWSER_STORAGE) expect(unescaped).toContain(item.name);
    expect(SUB_PROCESSORS.length).toBeGreaterThan(0);
    for (const vendor of SUB_PROCESSORS) expect(unescaped).toContain(vendor.name);
  });
});

describe("the draft notice", () => {
  const view = (reviewed: boolean) =>
    renderToStaticMarkup(
      <LegalDocumentView title="Terms" version={3} effectiveDate="2026-09-22" reviewed={reviewed} body="Text." />,
    );

  it("is present on an unreviewed version, between the title and the body", () => {
    const html = view(false);
    const notice = html.indexOf('data-testid="legal-draft-notice"');
    expect(notice).toBeGreaterThan(html.indexOf("<h1"));
    expect(notice).toBeLessThan(html.indexOf('data-testid="legal-body"'));
    expect(html).toContain("Pending legal review.");
    // Nothing to dismiss it with.
    expect(html.slice(notice, html.indexOf('data-testid="legal-body"'))).not.toMatch(/<button|<input/);
  });

  // Fix round 1, M9: the editor embeds the view below its own headings, and
  // the document's outline must continue from there rather than restart.
  it("keeps the outline in order at every embedding level", () => {
    const levels = (html: string) => [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    for (const headingLevel of [1, 2, 3, 4] as const) {
      const html = renderToStaticMarkup(
        <LegalDocumentView
          title="Terms"
          version={3}
          effectiveDate="2026-09-22"
          reviewed
          body={"## Section\n\nText.\n\n### Sub\n\nMore."}
          headingLevel={headingLevel}
        />,
      );
      expect(levels(html)).toEqual([headingLevel, headingLevel + 1, headingLevel + 2]);
    }
  });

  it("is absent on a reviewed version (the paired control)", () => {
    const html = view(true);
    expect(html).not.toContain("legal-draft-notice");
    expect(html).toContain("Reviewed by legal counsel");
    expect(html).toContain("Version <span");
  });
});

describe("no raw-HTML escape hatch exists on the legal path", () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("finds the files at all, so this cannot pass vacuously", () => {
    const files = [
      ...sources(join(ROOT, "components", "legal")),
      ...sources(join(ROOT, "lib", "legal")),
      ...sources(join(ROOT, "app", "legal")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("no file under components/legal, lib/legal, app/legal or the editor uses dangerouslySetInnerHTML", () => {
    const files = [
      ...sources(join(ROOT, "components", "legal")),
      ...sources(join(ROOT, "lib", "legal")),
      ...sources(join(ROOT, "app", "legal")),
      join(ROOT, "app", "(app)", "super", "legal", "page.tsx"),
      join(ROOT, "components", "admin", "legal-editor-forms.tsx"),
      join(ROOT, "components", "admin", "legal-editor-outcome.tsx"),
      join(ROOT, "components", "ui", "action-outcome.tsx"),
    ];
    // The ATTRIBUTE or a DOM write, not the word: two headers name the prop in
    // order to say it is not used.
    const offenders = files.filter((f) =>
      /dangerouslySetInnerHTML\s*=|\.(inner|outer)HTML\s*=|insertAdjacentHTML/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
