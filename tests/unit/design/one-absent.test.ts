import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";

// ONE EMPTY-VALUE MARKER, AND ONE LABELLED FIELD.
//
// `Absent` had twenty call sites written out by hand -- twelve as a local
// `function Absent()` and eight inlined straight into a column renderer -- and
// `Detail` had six. They are four lines each, which is exactly why they
// spread: too small to feel worth extracting, and identical enough that nobody
// noticed there were twenty.
//
// ===========================================================================
// WHAT IS ACTUALLY AT RISK, WHICH IS NOT THE LINE COUNT
// ===========================================================================
// Both encode an ACCESSIBILITY decision, not a style one.
//
// `Absent` exists because a blank cell is indistinguishable from a rendering
// fault and is silent to a screen reader. The em dash is `aria-hidden` -- "em
// dash" is not what a screen-reader user needs to hear -- and the real content
// is `sr-only` text. Get either half wrong in one copy of twenty and that
// column goes quiet for one group of users, on one page, in a way no visual
// check and no type will catch.
//
// `Detail` renders `<dt>`/`<dd>`, which is what pairs a label with its value
// for assistive technology. A copy that drifted to `<div>`/`<span>` would look
// identical and say nothing.
//
// So this census is narrow and deliberate: nobody re-inlines the markup.

const MARKER = 'aria-hidden="true">—</span>';

/**
 * Every .tsx under app/ and components/, walked from disk.
 *
 * NOT `git ls-files`. The first version of this shelled out to git, which
 * omits a file that is not staged yet -- so the brand new component was
 * invisible to its own census and two assertions failed on correct code. A
 * census whose input depends on the index is one that passes while you are
 * still writing the thing it guards.
 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(root + dir)) {
      const rel = `${dir}/${entry}`;
      if (statSync(root + rel).isDirectory()) walk(rel);
      else if (rel.endsWith(".tsx")) out.push(rel);
    }
  };
  walk("app");
  walk("components");
  return out;
}

describe("the empty-value marker is written once", () => {
  const files = sources();

  it("finds the tree, so this cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(files).toContain("components/ui/absent.tsx");
    expect(files).toContain("components/ui/detail.tsx");
  });

  it("only components/ui/absent.tsx renders the em dash and its sr-only text", () => {
    const inliners = files.filter(
      (f) => f !== "components/ui/absent.tsx" && read(f).includes(MARKER),
    );
    expect(
      inliners,
      "a file inlines the empty-value markup instead of using <Absent />. " +
        "That markup carries an accessibility decision (the dash is " +
        "aria-hidden, the sr-only text is the real content) and a drifted " +
        "copy is silent to a screen reader while looking correct.",
    ).toEqual([]);
  });

  it("no file re-declares Absent or Detail locally", () => {
    const redeclared = files.filter((f) =>
      /^(export )?function (Absent|Detail)\s*\(/m.test(read(f)),
    );
    expect(redeclared.sort()).toEqual([
      "components/ui/absent.tsx",
      "components/ui/detail.tsx",
    ]);
  });

  it("Absent keeps both halves of the contract", () => {
    const src = read("components/ui/absent.tsx");
    expect(src).toContain('aria-hidden="true"');
    expect(src).toContain('className="sr-only"');
    // The label is optional with a default, which is what let the twelve local
    // copies and documents/page.tsx's labelled variant become one component.
    expect(src).toContain('label = "Not recorded"');
  });

  it("Detail still renders a dt/dd pair", () => {
    // A <div>/<span> drift would look identical and tell assistive technology
    // nothing about which label belongs to which value.
    const src = read("components/ui/detail.tsx");
    expect(src).toContain("<dt");
    expect(src).toContain("<dd");
  });
});
