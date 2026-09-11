import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root } from "../../support/source";

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
//     to a CALL-SITE COUNT, to the pairing check and to the `.range(`/`offset:`
//     ban, so without this assertion the census's blind spot is exactly the
//     defect the brief names ("a second, weaker cursor in the codebase").
//   * a route that renders a list and reaches `lib/list` by no path at all --
//     ASSERTED BELOW, and it is the assertion that replaced a floor.
//   * a page that calls `.range(` or builds an `offset` -- a second pagination
//     MODEL, not just a second implementation
//   * a module outside `lib/list` importing `decodeCursor`, which is how a
//     "quick" second cursor starts
//
// It is deliberately allowed to be noisy. A new list that this cannot see
// should fail here and be looked at.
//
// ===========================================================================
// THE OBLIGATION IS AN ENUMERATION NOW, NOT A NUMBER
// ===========================================================================
// For five phases the first assertion here was
// `callSites("fetchListPage<").length >= N`, and every edit RAISED N; the
// prose said in as many words that raising it was the obligation. If you have
// come here to restore that, read this first.
//
// The count was a PROXY for "every list goes through the one cursor", and it
// worked while every list wrote `fetchListPage<` itself. Once fourteen routes
// began delegating to the two list-page factories, fourteen occurrences became
// two: the proxy started measuring INDIRECTION rather than surface area. A
// lowered floor would have been the wrong repair, because the bypass that
// matters is invisible to a number in both directions -- a route that
// hand-rolls its own query calls nothing, so it neither raises the count nor
// trips it.
//
// So the obligation moved. Every route that renders a list is enumerated and
// must reach `lib/list` one of three ways: call `fetchListPage` itself,
// delegate to a factory, or call a loader that does. Anything else has to be
// named in an EXEMPT list with a reason. Add a list and do nothing, and it
// goes red naming your file -- which is what a number never did.


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
  // PHASE 5 TASK 2. The finance panel on the event detail page is the sixth
  // lib/list/ surface there. It declares a real `searchColumn` ("description")
  // and renders no search control, and like the lineup it shows ONE empty
  // state, so `financeParams` drops `fin_q`. The wrapper lives in
  // `lib/crm/finance-list.ts` (pure, so tests/unit can drive it and the client
  // forms can import the vocabulary); its `fetchListPage` caller is
  // `loadFinancialEntriesForEvent` in `lib/crm/finance-queries.ts` (server-only).
  { call: "financeParams", module: "lib/crm/finance-list.ts" },
] as const;

describe("every paginated list shares one implementation", () => {
  const fetchers = callers("fetchListPage<");
  const parsers = callers("parseListParams(");

  it("every route that renders a list reaches the one cursor", () => {
    // ======================================================================
    // THIS REPLACED A FLOOR, AND THE INVARIANT CHANGED WITH IT. READ THIS
    // BEFORE RESTORING A NUMBER
    // ======================================================================
    // For five phases this was `callSites("fetchListPage<").length >= N`, and
    // every edit RAISED N -- the file said in as many words that raising it
    // was the obligation. That assertion is gone, and its replacement is not
    // a smaller number: it is a different claim.
    //
    // The count was only ever a PROXY for "every list goes through the one
    // cursor". It worked while each list wrote `fetchListPage<` itself. Once
    // fourteen routes began delegating to components/list/entity-list-page.tsx
    // and components/list/deleted-records-page.tsx, fourteen occurrences
    // became two, and the proxy started measuring indirection rather than
    // surface area. A lowered floor would have been the wrong repair: it
    // still counts call sites, and a sixth entity that HAND-ROLLS its own
    // query calls nothing, so it neither raises the count nor trips it. The
    // bypass is invisible to a number in both directions.
    //
    // So the obligation is now an ENUMERATION rather than a number. Every
    // route that renders a list must reach lib/list one of exactly two ways,
    // and anything that does neither has to be named here with a reason. Add
    // a list and do nothing, and this goes red naming your file.
    const LIST_MARKERS = ["<EntityList", "entityListPage(", "deletedRecordsPage("];

    // ONE INDIRECTION IS ALLOWED, AND IT IS TRANSITIVE RATHER THAN AN
    // ALLOWLIST -- the same policy this file already applies to the
    // `parseListParams` wrappers below, for the same reason.
    //
    // A detail page renders <EntityList> for a panel whose page was fetched by
    // a loader in lib/ (the venue page's "Events here" via loadEventsForVenue,
    // the network links list via loadNetworkLinksList). Those routes reach the
    // one cursor through exactly one hop, and an allowlist naming them would
    // have to be edited every time a panel moves -- which is the kind of
    // maintenance that turns a guard into a rubber stamp.
    //
    // So resolve it: any symbol EXPORTED by a module that itself calls
    // `fetchListPage<` counts as reaching it. A loader that stops calling
    // fetchListPage drops out of this set, and every route that relied on it
    // goes red -- which is the behaviour an allowlist would have suppressed.
    const loaderExports = SOURCES.filter((f) =>
      code(f.text).includes("fetchListPage<"),
    ).flatMap((f) => [
      ...code(f.text).matchAll(
        /^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((m) => `${m[1]}(`));

    const REACHES = [
      "fetchListPage<",
      "entityListPage(",
      "deletedRecordsPage(",
      ...loaderExports,
    ];

    // Routes that render something list-shaped but legitimately do not reach
    // the shared cursor by any of those routes. EMPTY, AND THAT IS THE POINT
    // -- an entry here is a declaration that a surface paginates by some other
    // means, which is the thing this suite exists to make impossible to do
    // quietly.
    const EXEMPT: readonly string[] = [];

    const listRoutes = SOURCES.filter(
      (f) =>
        f.path.startsWith("app/") &&
        f.path.endsWith("page.tsx") &&
        LIST_MARKERS.some((m) => code(f.text).includes(m)),
    );

    // The denominator, so a broken walk cannot pass this vacuously.
    expect(
      listRoutes.length,
      "routes rendering a list. If this fell, a list route was deleted or the " +
        "walk stopped seeing app/.",
    ).toBeGreaterThanOrEqual(19);

    // And the loader resolution found something, so a regex that stopped
    // matching cannot silently turn the hop above into a blanket pass.
    expect(
      loaderExports.length,
      "exported loaders in modules that call fetchListPage. If this is zero " +
        "the transitive hop is matching nothing and every panel route below " +
        "would be reported as stranded.",
    ).toBeGreaterThanOrEqual(5);

    const stranded = listRoutes
      .filter((f) => !REACHES.some((m) => code(f.text).includes(m)))
      .map((f) => f.path)
      .filter((path) => !EXEMPT.includes(path));
    expect(
      stranded,
      "a route renders a list without calling fetchListPage, without " +
        "delegating to a list-page factory, and without calling a loader that " +
        "reaches fetchListPage. That is a second cursor, or a hand-rolled " +
        "query, which is what this whole file exists to prevent.",
    ).toEqual([]);

    // And the two factories must themselves reach it, or the delegation above
    // is delegation to nothing.
    for (const factory of [
      "components/list/deleted-records-page.tsx",
      "components/list/entity-list-page.tsx",
    ]) {
      expect(
        byPath(factory),
        `${factory} must call fetchListPage -- it is the shared cursor for ` +
          "every route that delegates to it",
      ).toContain("fetchListPage<");
    }
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
    // emptying a wrapper's body cannot quietly satisfy the pairing check. EIGHT
    // is the denominator -- `activityParams`, `lineupParams`,
    // `venueEventsParams`, `artistEventsParams`, the three related-panel
    // wrappers, and `financeParams` -- and a ninth added without a row here is a
    // wrapper the pairing check cannot see.
    expect(SPEC_PARAM_WRAPPERS).toHaveLength(8);
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

  it("the three related-panel surfaces set distinct, non-empty prefixes", () => {
    // The related panel carries THREE lib/list/ surfaces on one detail page, so
    // a missing or duplicated prefix is two of them reading one `after`. The
    // VALUES are asserted here (the census's cheap structural check); the
    // wrapper pairing is covered above.
    const related = readFileSync(root + "lib/crm/related-list.ts", "utf8");
    const prefixes = [
      'paramPrefix: "rel_tasks_"',
      'paramPrefix: "rel_notes_"',
      'paramPrefix: "rel_docs_"',
    ];
    for (const p of prefixes) expect(related, p).toContain(p);
    // Distinct: three literal strings, three of them.
    expect(new Set(prefixes).size).toBe(3);
  });

  it("the timeline namespaces its query keys, because it shares a page", () => {
    // Two `parseListParams` calls on one route (the artist detail page carries
    // both `ARTIST_FEE_LIST` and the timeline) would otherwise read the SAME
    // `after`, and the two cursors belong to different specs. `paramPrefix` is
    // off by default, so no existing spec changed.
    expect(activity).toContain("paramPrefix");
  });
});
