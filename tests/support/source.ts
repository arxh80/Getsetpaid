import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
 * stripping first.
 *
 * ==========================================================================
 * IT IS THE PARSER THAT KNOWS A COMMENT FROM A STRING (census audit A4)
 * ==========================================================================
 * This used to be two regexes, the second of which was
 * `line.replace(/\/\/.*$/, "")`. That does not remove a comment; it removes
 * everything after the first `//` ON THE LINE, wherever it appears -- inside a
 * string, inside a regex literal, inside a URL. MEASURED, before this rewrite:
 *
 *   const docs = "https://supabase.com/docs"; const q = supabase.from("notes")
 *
 * stripped to `const docs = "https:` , so the `.from("notes")` that follows was
 * invisible to `no-private-table-in-network-path.test.ts` -- the guard on the
 * private/network split, silently blind in the LEAK-PERMITTING direction. The
 * same defect was found and fixed once already for the storage census
 * (tests/unit/support/app-source.ts:19-22); this was the copy that was missed.
 *
 * So the comment ranges come from the TypeScript parser, which has already
 * decided what is a string, a template, a regex literal and a comment. Each
 * comment is blanked IN PLACE, newlines kept, so every line number and every
 * column a consuming assertion depends on is unchanged.
 */
export function stripComments(code: string): string {
  const sf = parseForComments(code);
  const text = sf.getFullText();
  const out = text.split("");
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end && i < out.length; i += 1) {
      const ch = out[i];
      if (ch !== String.fromCharCode(10) && ch !== String.fromCharCode(13)) out[i] = " ";
    }
  };
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    for (const child of node.getChildren(sf)) {
      if (child.getChildCount(sf) === 0) {
        // JSX text is not code and carries no trivia: `// not a comment` inside
        // an element's text would otherwise be scanned as one.
        if (child.kind === ts.SyntaxKind.JsxText) continue;
        const full = child.getFullStart();
        if (!seen.has(full)) {
          seen.add(full);
          // Both: `getLeadingCommentRanges` deliberately omits a comment that
          // sits on the same line as the PREVIOUS token (a trailing `// ...`),
          // which is the commonest comment there is.
          for (const r of ts.getLeadingCommentRanges(text, full) ?? []) blank(r.pos, r.end);
          for (const r of ts.getTrailingCommentRanges(text, full) ?? []) blank(r.pos, r.end);
        }
      } else {
        visit(child);
      }
    }
  };
  visit(sf);
  return out.join("");
}

/**
 * Parses as TSX and falls back to TS when that produces more syntax errors --
 * the two differ over `<T>expr` casts and generic arrow functions, and this
 * helper is handed both .ts and .tsx text with no filename to tell them apart.
 * `ts.createSourceFile` never throws, so the fallback is chosen on the
 * recovered-error count rather than on an exception.
 */
function parseForComments(code: string): ts.SourceFile {
  const asKind = (kind: ts.ScriptKind): ts.SourceFile =>
    ts.createSourceFile("source.tsx", code, ts.ScriptTarget.Latest, true, kind);
  const tsx = asKind(ts.ScriptKind.TSX);
  if (problemCount(tsx) === 0) return tsx;
  const plain = asKind(ts.ScriptKind.TS);
  return problemCount(plain) < problemCount(tsx) ? plain : tsx;
}

function problemCount(sf: ts.SourceFile): number {
  return ((sf as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length;
}
