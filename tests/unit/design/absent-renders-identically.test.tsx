import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Absent } from "@/components/ui/absent";
import { Detail } from "@/components/ui/detail";

// THE EXTRACTION RENDERS THE SAME HTML, MEASURED RATHER THAN ARGUED.
//
// Replacing twenty-six hand-written copies with one component is only safe if
// the component emits exactly what the copies emitted. "Identical by
// construction" is an argument -- the author looked and believed -- and the
// gate that would normally check it is the axe scan in
// tests/e2e/accessibility.spec.ts, which needs a browser, a dev server and
// about 2 GB of free memory this machine did not have when this landed.
//
// So render it here instead. `renderToStaticMarkup` is the same server
// renderer these components run under in production, it costs nothing, and it
// turns the claim into a string comparison. The expected values below are the
// literal output of the copies as they existed before the extraction --
// transcribed from the source they replaced, NOT from running the new
// component, which would make this a tautology.
//
// This does not replace the axe scan. Axe checks the whole rendered page,
// including whether the dt/dd pairs actually sit in a <dl> at each call site,
// which no unit test can see. It closes the specific question this change
// raises: is the markup the same.

describe("the extracted primitives emit the markup they replaced", () => {
  it("Absent matches the twelve unlabelled copies byte for byte", () => {
    // From app/(app)/[orgSlug]/contacts/page.tsx before the extraction, which
    // ten other files carried verbatim.
    expect(renderToStaticMarkup(<Absent />)).toBe(
      '<span class="text-ink-muted">' +
        '<span aria-hidden="true">—</span>' +
        '<span class="sr-only">Not recorded</span>' +
        "</span>",
    );
  });

  it("Absent with a label matches the documents variant", () => {
    // From app/(app)/[orgSlug]/documents/page.tsx, whose sr-only text was a
    // prop because "Not recorded" was the wrong sentence for an uploader.
    expect(renderToStaticMarkup(<Absent label="Uploader not recorded" />)).toBe(
      '<span class="text-ink-muted">' +
        '<span aria-hidden="true">—</span>' +
        '<span class="sr-only">Uploader not recorded</span>' +
        "</span>",
    );
  });

  it("the duplicates page's cell renders the same colour it did before", () => {
    // That copy omitted `text-ink-muted` on the inner span because its <td>
    // already carries it. The shared component adds the class back, so this
    // asserts the claim that made folding it in safe: the class is redundant
    // there, not different -- the computed colour is `text-ink-muted` either
    // way, because the parent sets it and the child now sets the same value.
    const shared = renderToStaticMarkup(<Absent />);
    expect(shared).toContain('class="text-ink-muted"');
    // The old local copy, transcribed:
    const before =
      "<span>" +
      '<span aria-hidden="true">—</span>' +
      '<span class="sr-only">Not recorded</span>' +
      "</span>";
    // Same children, same text, same aria semantics -- only the redundant
    // class differs, which is the whole of the diff on that page.
    expect(shared.replace(' class="text-ink-muted"', "")).toBe(before);
  });

  it("Detail matches the six copies byte for byte", () => {
    // From app/(app)/[orgSlug]/contacts/[contactId]/page.tsx before the
    // extraction, which five other files carried verbatim.
    expect(renderToStaticMarkup(<Detail label="Email">a@b.test</Detail>)).toBe(
      '<div class="flex flex-col gap-1">' +
        '<dt class="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">' +
        "Email" +
        "</dt>" +
        '<dd class="text-base break-words text-ink">a@b.test</dd>' +
        "</div>",
    );
  });

  it("the accessibility contract survives rendering, not just the source", () => {
    // one-absent.test.ts asserts these strings appear in the SOURCE. This
    // asserts they survive into the OUTPUT, which is the thing a screen
    // reader actually meets.
    const html = renderToStaticMarkup(<Absent label="No due date" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="sr-only">No due date<');
    // The dash must NOT be announced; the label must be.
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(
      html.indexOf("sr-only"),
    );
  });
});
