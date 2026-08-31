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
//     to the >= 17 floor, to the pairing check and to the `.range(`/`offset:`
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

/** One file's source, by the path `callers()` reports. */
function byPath(path: string): string {
  const found = SOURCES.find((f) => f.path === path);
  if (!found) throw new Error(`[one-cursor-only] no source for ${path}`);
  return found.text;
}

/**
 * The spec-level wrappers around `parseListParams`, and where each is defined.
 *
 * A wrapper exists only where a surface has to REFUSE one of its own query
 * keys -- a spec must declare a real `searchColumn` (a fake one is a PostgREST
 * 400), and a surface with no search control must then make sure a
 * hand-edited `?<prefix>q=zzz` cannot narrow it silently. Both entries below
 * do exactly that and nothing else.
 *
 * This list is data for the two assertions above, not an exemption: the second
 * one drives each wrapper's own module and requires it to call
 * `parseListParams` and to drop a key.
 */
const SPEC_PARAM_WRAPPERS = [
  { call: "activityParams", module: "lib/crm/activity.ts" },
  { call: "lineupParams", module: "lib/crm/lineup-list.ts" },
  // PHASE 4 TASK 3. The related panel carries THREE lib/list/ surfaces on one
  // detail page (tasks, notes, documents), each declaring a real `searchColumn`
  // and rendering no search control, so each drops its own `rel_*_q`. All three
  // wrappers live in `lib/crm/related-list.ts` (pure, so tests/unit can drive
  // it) and their `fetchListPage` callers are the reverse-lookup loaders in
  // `lib/crm/queries.ts` (server-only). Three wrappers in one module, as the
  // events pair already was.
  { call: "relatedTasksParams", module: "lib/crm/related-list.ts" },
  { call: "relatedNotesParams", module: "lib/crm/related-list.ts" },
  { call: "relatedDocsParams", module: "lib/crm/related-list.ts" },
  // PHASE 3 TASK 7. The venue page's "Events here" and the artist page's
  // "Event history" are the third and fourth surfaces in the product that
  // declare a real `searchColumn` and render no search control, so each drops
  // its own `<prefix>q`. Both `fetchListPage` callers are in
  // `lib/crm/queries.ts` (server-only); both wrappers are in
  // `lib/crm/events-list.ts`, which stays pure so tests/unit can drive them --
  // and TWO WRAPPERS SHARING ONE MODULE is new, which is why the loop below
  // resolves per wrapper rather than per module.
  { call: "venueEventsParams", module: "lib/crm/events-list.ts" },
  { call: "artistEventsParams", module: "lib/crm/events-list.ts" },
] as const;

describe("every paginated list shares one implementation", () => {
  const fetchers = callers("fetchListPage<");
  const parsers = callers("parseListParams(");

  it("finds the CALL SITES at all, so this suite cannot pass vacuously", () => {
    // TWENTY as of Phase 3 Task 7, raised from seventeen: contacts,
    // companies, artists, agencies, venues and their five `deleted` twins
    // (10), the duplicates queue and its `resolved` twin (12), merge history
    // (13), the artist fee list (14), the activity timeline in
    // `lib/crm/activity.ts` (15), the events list (16), the deleted events
    // list (17), the lineup panel in `lib/crm/queries.ts` (18), and now the
    // venue page's "Events here" (19) and the artist page's "Event history"
    // (20) -- BOTH ADDED TO `lib/crm/queries.ts`, WHICH ALREADY HELD ONE. A
    // file count would have moved by zero for this task; L1143 changed this to
    // occurrences for exactly that case, and this is the first task to
    // collect on it.
    //
    // RAISING IT IS THE OBLIGATION, not paperwork. It is a FLOOR, so Task 3
    // could have added two lists and left it at fifteen and nothing would have
    // gone red -- and the census would then have been satisfied by a codebase
    // that had deleted two of the lists it is meant to be counting. The floor
    // only has teeth at the number the tree actually holds.
    //
    // COUNTED AS OCCURRENCES, NOT AS FILES (L1143). Today the two still happen
    // to be the same number -- seventeen files, one call each -- which is
    // exactly why the mismatch between this assertion and the sentence above
    // it went unnoticed. A second list added to a file that already has one
    // would not move a file count.
    // THIRTY as of Phase 4 Task 3, raised from twenty: the tasks, meetings and
    // notes list pages and their three `deleted` twins (6), and the three
    // related-panel reverse loaders in `lib/crm/queries.ts` --
    // loadTasksForEntity, loadNotesForEntity, loadDocumentsForEntity (3). Nine
    // more, counted rather than guessed. The floor has teeth only at the number
    // the tree holds; raising it is the obligation.
    expect(callSites("fetchListPage<").length).toBeGreaterThanOrEqual(29);
  });

  it("every fetchListPage caller also parses its params through lib/list", () => {
    // The pairing is the point. `fetchListPage` with hand-rolled params is a
    // page that reads `after` off the query string itself, which is where a
    // second, unvalidated cursor gets in.
    //
    // =======================================================================
    // ONE INDIRECTION IS ALLOWED, AND IT IS TRANSITIVE RATHER THAN AN
    // ALLOWLIST (Phase 3 Task 5)
    // =======================================================================
    // A spec that DROPS a query key -- `activityParams` drops `activity_q`,
    // `lineupParams` drops `lineup_q`, both because the surface declares a
    // real `searchColumn` and renders no search control -- has to own a
    // wrapper around `parseListParams`, and its callers then call the wrapper
    // rather than the parser.
    //
    // `lib/crm/activity.ts` happens to hold both halves in one file, so it
    // passed this assertion by accident of layout. `lineupParams` cannot: it
    // lives in `lib/crm/lineup-list.ts` because it must stay PURE (the client
    // panel imports the spec and the vocabulary from that module, and a
    // `server-only` import there would break the bundle) and because
    // `tests/unit` can then drive it -- tests/unit/crm/lineup-list.test.ts's
    // § 1 and § 2 are the only assertions in the repository that see the
    // prefix collision and the dropped `q` at all. Its `fetchListPage` caller
    // is `loadLineupForEvent` in `lib/crm/queries.ts`, which is server-only.
    //
    // So a file also satisfies the pairing by calling a wrapper WHOSE OWN
    // MODULE calls `parseListParams`. That is checked here, not assumed: the
    // wrapper names are resolved to their defining module and that module is
    // required to be a `parseListParams` caller. A hand-rolled
    // `myParams(raw)` that never touches lib/list therefore does NOT satisfy
    // it, which is the whole property.
    const unpaired = fetchers.filter(
      (path) => !parsers.includes(path) && !SPEC_PARAM_WRAPPERS.some(
        (wrapper) =>
          code(byPath(path)).includes(`${wrapper.call}(`) &&
          parsers.includes(wrapper.module),
      ),
    );
    expect(unpaired).toEqual([]);
  });

  it("every spec params wrapper really does go through parseListParams", () => {
    // The other half of the transitive rule above, asserted on its own so that
    // emptying a wrapper's body cannot quietly satisfy the pairing check. SEVEN
    // is the denominator -- `activityParams`, `lineupParams`,
    // `venueEventsParams`, `artistEventsParams` and the three related-panel
    // wrappers -- and an eighth added without a row here is a wrapper the
    // pairing check cannot see.
    expect(SPEC_PARAM_WRAPPERS).toHaveLength(7);
    for (const wrapper of SPEC_PARAM_WRAPPERS) {
      const body = code(byPath(wrapper.module));
      expect(body, wrapper.call).toContain(`export function ${wrapper.call}(`);
      expect(body, wrapper.call).toContain("parseListParams(");
      // And it drops a key rather than merely forwarding: that is the only
      // reason a wrapper is allowed to exist instead of the parser being
      // called directly.
      expect(body, wrapper.call).toContain("]: undefined,");
    }
  });

  it("no module outside lib/list reads a cursor param off the query string", () => {
    // THE HAND-ROLLED KEYSET. `fetchListPage` and `parseListParams` are paired
    // above, but a list that calls NEITHER -- `.gt("id", searchParams.after)`
    // with its own `.limit(n)` -- passes every other assertion in this file:
    // the >= 17 floor cannot see it, the pairing check never considers it, and
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

  it("both Task 7 surfaces namespace their keys, because they share a page", () => {
    // The venue page carries two lib/list/ surfaces and the artist page three,
    // so a missing prefix on either of these is two lists reading one `after`.
    // The VALUES, their distinctness and the cardinality of the whole set are
    // asserted in tests/unit/crm/events-list.test.ts § 1; this is the census's
    // own cheap check that the field is present at all.
    const events = readFileSync(root + "lib/crm/events-list.ts", "utf8");
    expect(events).toContain('paramPrefix: "venueevents_"');
    expect(events).toContain('paramPrefix: "artistevents_"');
  });

  it("the timeline namespaces its query keys, because it shares a page", () => {
    // Two `parseListParams` calls on one route (the artist detail page carries
    // both `ARTIST_FEE_LIST` and the timeline) would otherwise read the SAME
    // `after`, and the two cursors belong to different specs. `paramPrefix` is
    // off by default, so no existing spec changed.
    expect(activity).toContain("paramPrefix");
  });
});
