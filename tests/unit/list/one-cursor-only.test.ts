import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ONE CURSOR, AND A CENSUS THAT SAYS SO.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// The Task 8 brief § 3: "Task 3 proved pagination exhaustively for contacts
// (407 pages each way, 56 tamper cases). Tasks 4-7 added more lists. Each new
// list needs the same treatment, OR A PROOF THAT IT SHARES THE VERIFIED
// IMPLEMENTATION. A second, weaker cursor in the codebase is a defect."
//
// Re-proving 407 pages per list would be fifteen copies of one experiment. The
// cheaper and stronger claim is that there is only ONE cursor to prove: every
// list in the product goes through `fetchListPage` and `parseListParams`, and
// `encodeCursor`/`decodeCursor` are called from nowhere but `lib/list` itself.
// That claim is what the 56 tamper cases in `tests/unit/list/cursor.test.ts`
// and the keyset walk in `rls_phase2_crm.sql` § X then cover -- all of it.
//
// This is a SOURCE CENSUS, in the same spirit and with the same limits as
// `tests/unit/crm/source-shape.test.ts`: it says the shared implementation is
// the one being called, not that the shared implementation is correct. The
// correctness lives in the behavioural tests it points at.
//
// ===========================================================================
// WHAT WOULD BREAK IT, WHICH IS THE POINT
// ===========================================================================
//   * a page that reads `searchParams.after` itself instead of through
//     `parseListParams` -- ASSERTED BELOW. It is the one bullet the first
//     version of this file named without implementing (Task 8 review,
//     Important #3), and it matters more than the other two: a list that
//     hand-rolls a keyset query and never calls `fetchListPage` is invisible
//     to the >= 15 floor, to the pairing check and to the `.range(`/`offset:`
//     ban, so without this assertion the census's blind spot is exactly the
//     defect the brief names ("a second, weaker cursor in the codebase").
//   * a page that calls `.range(` or builds an `offset` -- a second pagination
//     MODEL, not just a second implementation
//   * a module outside `lib/list` importing `decodeCursor`, which is how a
//     "quick" second cursor starts
//
// It is deliberately allowed to be noisy. A new list that this cannot see
// should fail here and be looked at.

const root = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(root + dir)) {
    const rel = `${dir}/${name}`;
    if (statSync(root + rel).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/** Every source file outside `lib/list` and outside `tests`. */
const SOURCES = [...walk("app"), ...walk("lib"), ...walk("components")]
  .filter((f) => !f.startsWith("lib/list/"))
  .map((path) => ({ path, text: readFileSync(root + path, "utf8") }));

/** Comment lines stripped, for the same reason source-shape.test.ts strips
 *  them: prose about `.range(` is not a call to `.range(`, and this file's
 *  neighbours are heavily commented. */
function code(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

const callers = (needle: string) =>
  SOURCES.filter((f) => code(f.text).includes(needle)).map((f) => f.path);

/**
 * Every OCCURRENCE of `needle`, as `path#n` -- not every file containing one.
 *
 * Deferred-minor L1143. The floor below used `callers("fetchListPage<").length`
 * and the prose around it called the result "call sites". Fifteen files each
 * holding exactly one call made the two numbers identical, which is why nobody
 * noticed -- and a sixteenth list added to an EXISTING file (a detail page
 * already carrying one, which is how the artist page got its fee list) would
 * not move a file count at all. Counting occurrences makes the assertion say
 * what its comment says.
 */
function callSites(needle: string): string[] {
  return SOURCES.flatMap((f) => {
    const body = code(f.text);
    const out: string[] = [];
    for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
      out.push(`${f.path}#${out.length + 1}`);
    }
    return out;
  });
}

describe("every paginated list shares one implementation", () => {
  const fetchers = callers("fetchListPage<");
  const parsers = callers("parseListParams(");

  it("finds the CALL SITES at all, so this suite cannot pass vacuously", () => {
    // FIFTEEN at the time of writing: contacts, companies, artists, agencies,
    // venues and their five `deleted` twins (10), the duplicates queue and its
    // `resolved` twin (12), merge history (13), the artist fee list (14) and
    // the activity timeline in `lib/crm/activity.ts` (15).
    //
    // COUNTED AS OCCURRENCES, NOT AS FILES (L1143). Today the two happen to be
    // the same number -- fifteen files, one call each -- which is exactly why
    // the mismatch between this assertion and the sentence above it went
    // unnoticed. A second list added to a file that already has one would not
    // move a file count.
    //
    // A FLOOR, not an exact count, so Phase 3 adding events and lineups does
    // not turn this red for the right reason -- but deleting the shared path
    // does.
    expect(callSites("fetchListPage<").length).toBeGreaterThanOrEqual(15);
  });

  it("every fetchListPage caller also parses its params through lib/list", () => {
    // The pairing is the point. `fetchListPage` with hand-rolled params is a
    // page that reads `after` off the query string itself, which is where a
    // second, unvalidated cursor gets in.
    const unpaired = fetchers.filter((path) => !parsers.includes(path));
    expect(unpaired).toEqual([]);
  });

  it("no module outside lib/list reads a cursor param off the query string", () => {
    // THE HAND-ROLLED KEYSET. `fetchListPage` and `parseListParams` are paired
    // above, but a list that calls NEITHER -- `.gt("id", searchParams.after)`
    // with its own `.limit(n)` -- passes every other assertion in this file:
    // the >= 15 floor cannot see it, the pairing check never considers it, and
    // it uses neither `.range(` nor `offset:`. `lib/list/params.ts` owns the
    // names `after` and `before` (it reads `paramKey(spec, "after")` at line
    // 230) and is the only place allowed to take them off a query string.
    //
    // SCOPED TO A PARAMS-SHAPED RECEIVER, not to the bare word. A blanket ban
    // on `.before` is a false positive, and that is measured rather than
    // guessed: the first draft of this assertion caught `lib/crm/dedup.ts:345`,
    // `(record as Record<string, unknown>).before`, which reads a merge
    // `field_resolution` snapshot and has nothing to do with pagination.
    //
    // Covered: `searchParams.after`, `params["before"]`, and the destructured
    // `const { after } = await searchParams`. Comment lines are stripped by
    // `code()` first, which matters here -- a dozen files discuss `after` in
    // prose (the artist detail page, the activity timeline, the artists list)
    // and none of them reads it.
    const reads = [
      /\b(?:searchParams|params|query|raw)\s*(?:\.\s*|\[\s*["'`]\s*)(?:after|before)\b/,
      /\{[^}]*\b(?:after|before)\b[^}]*\}\s*=\s*(?:await\s+)?(?:searchParams|params|query|raw)\b/,
    ];
    const readers = SOURCES.filter((f) =>
      reads.some((re) => re.test(code(f.text))),
    );
    expect(readers.map((f) => f.path)).toEqual([]);
  });

  it("no module outside lib/list encodes or decodes a cursor itself", () => {
    // `encodeCursor` is called by `buildListHref`, `decodeCursor` by
    // `parseListParams`, both inside lib/list. Anywhere else is a second
    // cursor format one refactor away from disagreeing with the first.
    expect(callers("decodeCursor(")).toEqual([]);
    expect(callers("encodeCursor(")).toEqual([]);
  });

  it("no page paginates by range or offset", () => {
    // A SECOND PAGINATION MODEL, not merely a second implementation. Keyset is
    // the whole reason `lib/list/query.ts` does not degrade with depth, and an
    // offset page beside it is both slower and inconsistent under concurrent
    // writes -- the two failure modes keyset exists to remove.
    //
    // `.limit(` is NOT banned: `loadLinkOptions` and the members page use a
    // bounded `.limit()` with no cursor, which is a capped read rather than a
    // paginated one. CLAUDE.md § Non-negotiable rules asks for a ceiling on
    // every list endpoint, and a bare `.limit()` IS a ceiling. What it is not
    // is a page-2, which is why nothing offers one.
    expect(callers(".range(")).toEqual([]);
    const offsets = SOURCES.filter((f) => /\boffset:\s/.test(code(f.text)));
    expect(offsets.map((f) => f.path)).toEqual([]);
  });
});

describe("the list specs that differ from the others say how", () => {
  const activity = readFileSync(root + "lib/crm/activity.ts", "utf8");
  const query = readFileSync(root + "lib/list/query.ts", "utf8");

  it("the activity timeline is registered as a table with no soft delete", () => {
    // THE DEFECT THIS REPLACES. `fetchListPage` filtered `deleted_at`
    // unconditionally; `public.activity_events` is a view with no such column,
    // so every detail page in the product rendered "we couldn't load this
    // contact's activity" while every other gate was green (Task 7). The
    // escape is keyed on the table name rather than passed as a flag, so it
    // cannot be pointed at `contacts` by a copied spec.
    expect(query).toContain("activity_events");
    // And the binding that keeps the list honest: an integration test fails if
    // a table named here grows a `deleted_at`, or if one that has one is read
    // without the filter.
    expect(
      readFileSync(
        root + "tests/integration/list/soft-delete-tables-match-db.test.ts",
        "utf8",
      ),
    ).toContain("activity_events");
  });

  it("the timeline namespaces its query keys, because it shares a page", () => {
    // Two `parseListParams` calls on one route (the artist detail page carries
    // both `ARTIST_FEE_LIST` and the timeline) would otherwise read the SAME
    // `after`, and the two cursors belong to different specs. `paramPrefix` is
    // off by default, so no existing spec changed.
    expect(activity).toContain("paramPrefix");
  });
});
