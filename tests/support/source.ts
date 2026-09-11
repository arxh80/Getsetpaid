import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Shared plumbing for the census suites -- the tests that read PROJECT SOURCE
// as text and assert a shape over it (tests/unit/crm/source-shape.test.ts and
// its network siblings, one-cursor-only, the date-formatting census).
//
// Nine files declared `root` themselves, four declared a byte-identical
// `read`, and four a byte-identical `stripComments`. That is ordinary
// duplication with one sharp edge in it, below.
//
// ===========================================================================
// LINE ENDINGS ARE NORMALISED, AND THAT IS NOT COSMETIC
// ===========================================================================
// Several assertions in those suites are multi-line `toContain` checks against
// source text, matching strings that contain newlines and leading indentation.
// The repository sets no `text` policy in `.gitattributes`, so a Windows
// checkout with `core.autocrlf` on has CRLF in every file, and every one of
// those assertions then fails against perfectly correct source. It was red at
// Phase 3 Task 1's starting commit for exactly that reason, on a test whose
// subject had nothing wrong with it.
//
// Four copies of `read` normalised. The fifth --
// tests/integration/list/soft-delete-tables-match-db.test.ts -- did not, and
// so carried that Windows-only failure waiting for someone to add a
// multi-line assertion to it. Sharing one implementation is what makes the
// fix hold everywhere instead of in the four places somebody remembered.
//
// Normalising here rather than in `.gitattributes` keeps the fix local: a
// repository-wide `text=auto` rewrites every file's line endings in one
// commit, which is a decision for its own change (filed in FOLLOW-UPS.md).
// Nothing these suites assert is ABOUT line endings, so nothing is weakened.

/** Absolute path of the repository root, with a trailing separator. */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Read a repo-relative file as text, with line endings normalised to \n. */
export function readSource(relative: string): string {
  return readFileSync(repoRoot + relative, "utf8").replace(/\r\n/g, "\n");
}

/**
 * The same text with comments removed, so a census cannot be satisfied -- or
 * defeated -- by prose.
 *
 * The suites that use this are asserting what the CODE does. A file whose
 * comment quotes the very pattern the test forbids would otherwise fail, and a
 * file whose comment promises the pattern the test requires would otherwise
 * pass. Both have happened often enough in this repo's history to be worth
 * stripping first: block comments whole, then the tail of any line after `//`.
 */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}
