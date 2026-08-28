import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SHAPE ASSERTIONS OVER SOURCE TEXT. Blunt on purpose.
//
// ===========================================================================
// WHY A TEST THAT READS SOURCE CODE EXISTS AT ALL
// ===========================================================================
// The Task 4 review ran two mutations that shipped 519/519 GREEN:
//
//   1. `{ count: "exact" }` removed from `updateContactAction`. Nothing red.
//      In a browser every save then reported "We couldn't save that just now"
//      while the row HAD changed -- fail-safe, and a lie.
//   2. `.is("deleted_at", null)` removed from `loadLinkOptions`. Nothing red.
//      The link picker would start offering soft-deleted records.
//
// Both are OMITTED OPTIONS on a query builder. A behavioural test cannot see
// one without a live database and a policy arranged to refuse -- which is what
// supabase/tests/rls_phase2_crm.sql does, one call site at a time, and there
// are SEVEN of them today and Task 4b adds more. (It said eight until N-3: the
// eighth was a sentence in lib/crm/write.ts's header, and the census counted
// the prose. See `CENSUS_EXEMPT` and `callArguments` below.) `classifyWrite`
// itself is well bound (mutating it turns three assertions red); it is the
// CALL SITES that were unguarded.
//
// The same reasoning covers a hidden `<input>` in a .tsx file: no assertion on
// a pure function can see it deleted, and deleting it reintroduces I-2.
//
// ===========================================================================
// WHAT THIS IS NOT
// ===========================================================================
// Not a substitute for the behavioural tests -- those are in write.test.ts,
// form-echo.test.ts and the psql/HTTP suites, and they are what says the
// options MEAN anything. This says only that they are still written down. It
// is deliberately allowed to be noisy: a new `.update(` in lib/crm/ that this
// cannot parse should fail and be looked at, not be silently skipped.

const root = fileURLToPath(new URL("../../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(root + relative, "utf8");
}

/**
 * Every call in `source` whose callee ends with `.<method>(`, returned as the
 * text between its parentheses.
 *
 * Balanced-paren scan rather than a fixed window, so a call spanning fifteen
 * lines is read whole and a short one does not accidentally swallow the next
 * statement.
 *
 * COMMENT LINES ARE STRIPPED FIRST (N-3). A line whose first non-space
 * characters are `//` is prose, and prose about `.update(` is not a call site
 * -- counting one propped the floor assertion up by a sentence. Line comments
 * only: this is a blunt census, and every real call site in lib/crm/ is
 * ordinary code, so the cheapest rule that removes the observed failure is the
 * right one. A `.update(` inside a block comment would still be counted, which
 * is a false RED and therefore safe -- the file's own header says being noisy
 * is the intended failure direction.
 */
function callArguments(rawSource: string, method: string): string[] {
  const source = rawSource
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  const needle = `.${method}(`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(at + needle.length, i));
    from = i;
  }
}

/**
 * `lib/crm/write.ts` DEFINES the discipline; it does not use it.
 *
 * N-3. It contains no query builder at all, and the census counted it anyway:
 * its header explains the mechanism in prose --
 *
 *     //   2. `Prefer: count=exact`. What `.update(values, { count: "exact" })`
 *
 * -- and `.update(` in a comment is still `.update(`. So the run showed eight
 * "call sites", the eighth was a sentence, and the floor assertion below (whose
 * stated job is "so this suite cannot pass vacuously") was one higher than the
 * number of things it guarded. Two fixes, because either alone leaves the trap:
 * this module is excluded, AND `callArguments` skips comment lines, so the next
 * module that explains itself in prose is not counted either.
 */
const CENSUS_EXEMPT = new Set(["write.ts"]);

const CRM_SOURCES = readdirSync(root + "lib/crm")
  .filter((name) => name.endsWith(".ts") && !CENSUS_EXEMPT.has(name))
  .map((name) => ({ name: `lib/crm/${name}`, text: read(`lib/crm/${name}`) }));

describe("every mutating call in lib/crm/ asks for the row count", () => {
  // A 204 IS NOT A SAVE (lib/crm/write.ts). Without `count: "exact"` the
  // response to a refused UPDATE and to one that changed fifteen rows are
  // byte-identical, and `classifyWrite` -- which fails closed on a null count
  // -- reports a failure on every save instead.
  const sites = CRM_SOURCES.flatMap((file) =>
    (["update", "delete"] as const).flatMap((method) =>
      callArguments(file.text, method).map((args, index) => ({
        label: `${file.name} .${method}(#${index + 1})`,
        args,
      })),
    ),
  );

  it("finds the call sites at all, so this suite cannot pass vacuously", () => {
    // SEVEN, not eight. The eighth was `.update(#1)` in lib/crm/write.ts's
    // header comment -- a sentence, not a statement, so the floor was one
    // higher than the number of things it guarded (N-3). Three real `.update(`
    // in companies.ts, three plus one `.delete(` in contacts.ts.
    //
    // A floor rather than an exact number so Task 4b adding call sites does
    // not turn this red for the wrong reason -- but deleting them all does.
    expect(sites.length).toBeGreaterThanOrEqual(7);
  });

  for (const site of sites) {
    it(`${site.label} carries { count: "exact" }`, () => {
      expect(site.args).toContain(`count: "exact"`);
    });
  }
});

describe("loadLinkOptions does not offer soft-deleted records", () => {
  // Mutation 8 in the review's table: dropping this filter is invisible to the
  // whole suite, and the "Link a company" picker starts listing records the
  // product says are deleted.
  const queries = read("lib/crm/queries.ts");
  const body = queries.slice(queries.indexOf("export async function loadLinkOptions"));

  it("filters deleted_at in the query", () => {
    expect(body).toContain(`.is("deleted_at", null)`);
  });

  it("scopes the query to one organisation", () => {
    expect(body).toContain(`.eq("organisation_id", organisationId)`);
  });
});

describe("the join actions refuse a soft-deleted end (M-1)", () => {
  // TWO ENDS, TWO DIFFERENT AMOUNTS OF BACKING, and that is the reason this
  // block is worth its noise:
  //
  //   contact -- ALSO enforced by the database since 20260828235000
  //              (`p.deleted_at is null` in the three contact_companies write
  //              policies). S28 in rls_phase2_crm.sql measures the refusal.
  //   company -- THIS FILE'S ASSERTIONS ARE THE ONLY THING GUARDING IT. A
  //              policy term there would collapse "deleted" into "invisible"
  //              for a record-scoped caller under Q5, so it is deliberately
  //              absent; S28b measures the database still saying yes.
  //
  // A source assertion because a Server Action is not drivable from a node
  // test in this repository (tests/unit is pure functions only, by the config's
  // own rule). The behavioural half is the browser walk in the fix report.
  const contacts = read("lib/crm/contacts.ts");

  function actionBody(name: string): string {
    const start = contacts.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = contacts.indexOf("\nexport async function ", start + 1);
    return contacts.slice(start, next === -1 ? undefined : next);
  }

  for (const action of [
    "linkCompanyAction",
    "unlinkCompanyAction",
    "setPrimaryCompanyAction",
  ]) {
    it(`${action} checks the contact is live in this organisation`, () => {
      expect(actionBody(action)).toContain(
        `liveInOrg(supabase, "contacts", org.id, contactId)`,
      );
    });

    it(`${action} checks the company too, and refuses a deleted end`, () => {
      const body = actionBody(action);
      expect(body).toContain(`liveInOrg(supabase, "companies", org.id, companyId)`);
      expect(body).toContain("refusedEndState(ends, formData)");
    });
  }

  it("liveInOrg reads deleted_at rather than FILTERING it, and scopes the organisation", () => {
    // N-8. It used to carry `.is("deleted_at", null)` and return a boolean, so
    // "soft-deleted" and "not there at all" were the same answer and got the
    // same sentence -- one that tells the user to restore a record that may be
    // live in another workspace. Reading the column is what separates them.
    const helper = contacts.slice(
      contacts.indexOf("async function liveInOrg("),
      contacts.indexOf("function refusedEndState("),
    );
    expect(helper).toContain(`.select("deleted_at")`);
    expect(helper).not.toContain(`.is("deleted_at", null)`);
    expect(helper).toContain(`.eq("organisation_id", organisationId)`);
    // The three answers, all present, and "gone" is the fail-closed one.
    expect(helper).toContain(`return "gone"`);
    expect(helper).toContain(`return data.deleted_at === null ? "live" : "deleted"`);
  });

  it("only setPrimaryCompanyAction overrides the generic conflict sentence (N-9)", () => {
    // CONFLICT_MESSAGE is wired to eight actions across two modules. Naming
    // one operation in it made the other seven wrong the moment a second 23505
    // path exists -- and CLAUDE.md § Domain entities names the feature that
    // creates one (dedup's unique index on email/name). The specific wording
    // lives at the one call site that earns it and nowhere else.
    expect(contacts).toContain("const PRIMARY_COMPANY_CONFLICT =");
    expect(
      actionBody("setPrimaryCompanyAction"),
    ).toContain("failureState(result, formData, PRIMARY_COMPANY_CONFLICT)");
    // No other action passes a conflict message, so every one of them renders
    // the generic sentence.
    expect(contacts.match(/failureState\(result, formData, /g)).toHaveLength(1);
    expect(read("lib/crm/companies.ts")).not.toContain("PRIMARY_COMPANY_CONFLICT");
    // The constant's own wording is asserted in tests/unit/crm/write.test.ts,
    // where it can be read as a value rather than as source text.
  });
});

describe("the company form carries the checkbox-group marker (I-2)", () => {
  const form = read("components/crm/company-form.tsx");

  it("renders the hidden marker input for the type group", () => {
    // Without it, an unticked group is indistinguishable from a group that was
    // never on the form, and a failed submit re-ticks what the user cleared.
    expect(form).toContain(`name={groupMarkerName("type")}`);
    expect(form).toContain(`type="hidden"`);
  });

  it("derives what is ticked through selectedInGroup, not from the echo alone", () => {
    expect(form).toContain(`selectedInGroup(state.values, "type", values.type)`);
  });
});

// ===========================================================================
// TASK 4b
// ===========================================================================

describe("the representation panel carries the checkbox-group marker", () => {
  // A GROUP OF ONE IS STILL A GROUP. `is_exclusive` is a single checkbox and
  // an unticked checkbox submits nothing, so without the marker an emptied box
  // is indistinguishable from a form that never had it -- and a failed submit
  // re-ticks the exclusivity the user just removed. Same defect as I-2,
  // narrower. No assertion on a pure function can see an `<input>` deleted
  // from a .tsx file, which is why this block is here rather than in
  // form-echo.test.ts.
  const panel = read("components/crm/representation-panel.tsx");

  it("renders the hidden marker input for the exclusivity checkbox", () => {
    expect(panel).toContain(`name={groupMarkerName("isExclusive")}`);
    expect(panel).toContain(`type="hidden"`);
  });

  it("derives what is ticked through selectedInGroup, in BOTH forms", () => {
    // The add form and the edit form each have their own `useActionState`, so
    // each derives its own. Two call sites, and the count is asserted so that
    // fixing one and forgetting the other is red.
    expect(
      panel.match(/selectedInGroup\(state\.values, "isExclusive"/g),
    ).toHaveLength(2);
  });
});

describe("the new child writes refuse a soft-deleted parent", () => {
  // THE SAME TWO-ENDS ASYMMETRY AS M-1, one entity along:
  //
  //   artist  -- ALSO enforced by the database since 20260829001000
  //             (`p.deleted_at is null` in the two artist_representations
  //             write policies). T28 measures the refusal.
  //   agency,
  //   contact -- THESE ASSERTIONS ARE THE ONLY THING GUARDING THEM. A policy
  //             term there would collapse "deleted" into "invisible" for a
  //             record-scoped caller under Q3a, so it is deliberately absent;
  //             T28b measures the database still saying yes.
  //   venue   -- ALSO enforced by the database (T29). A room has no second
  //             end, so there is nothing left application-only.
  //
  // Source assertions because a Server Action is not drivable from a node test
  // in this repository (tests/unit is pure functions only, by the config's own
  // rule). The behavioural half is the browser walk in the task report.
  const artists = read("lib/crm/artists.ts");
  const venues = read("lib/crm/venues.ts");

  function actionBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport async function ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it("representationEnds checks all three ends through liveInOrg", () => {
    const helper = artists.slice(
      artists.indexOf("async function representationEnds("),
      artists.indexOf("function revalidateRepresentation("),
    );
    expect(helper).toContain(`liveInOrg(supabase, "artists", organisationId, artistId)`);
    expect(helper).toContain(`liveInOrg(supabase, "agencies", organisationId, agencyId)`);
    expect(helper).toContain(`liveInOrg(supabase, "contacts", organisationId, contactId)`);
  });

  for (const action of [
    "createRepresentationAction",
    "updateRepresentationAction",
    "deleteRepresentationAction",
    "restoreRepresentationAction",
    "setPrimaryRepresentationAction",
  ]) {
    it(`${action} refuses when an end is not live`, () => {
      const body = actionBody(artists, action);
      expect(body).toContain("representationEnds(");
      expect(body).toContain("refusedEndState(");
    });
  }

  for (const action of [
    "addRoomAction",
    "renameRoomAction",
    "closeRoomAction",
    "reopenRoomAction",
  ]) {
    it(`${action} checks the venue is live in this organisation`, () => {
      const body = actionBody(venues, action);
      expect(body).toContain(`liveInOrg(supabase, "venues", org.id, venueId)`);
      expect(body).toContain("refusedEndState(");
    });
  }

  it("liveInOrg reads deleted_at rather than FILTERING it, and scopes the org", () => {
    // N-8, in its new home. It used to carry `.is("deleted_at", null)` and
    // return a boolean, so "soft-deleted" and "not there at all" were the same
    // answer and got the same sentence -- one that tells the user to restore a
    // record that may be live in another workspace.
    const shared = read("lib/crm/actions.ts");
    const helper = shared.slice(
      shared.indexOf("export async function liveInOrg("),
      shared.indexOf("export function refusedEndState("),
    );
    expect(helper).toContain(`.select("deleted_at")`);
    expect(helper).not.toContain(`.is("deleted_at", null)`);
    expect(helper).toContain(`.eq("organisation_id", organisationId)`);
    // The three answers, all present, and "gone" is the fail-closed one. TWO
    // `return "gone"` literals and no third: the error branch and the
    // not-found branch, byte-identical, so a caller cannot learn which.
    expect(helper.match(/return "gone";/g)).toHaveLength(2);
    expect(helper).toContain(`return data.deleted_at === null ? "live" : "deleted"`);
  });
});

describe("the child writes carry the id of the row's PARENT, not only its own", () => {
  // A forged `representationId` or `roomId` belonging to a different artist or
  // venue in the SAME workspace is permitted by the policy -- the policy asks
  // whether the caller may write the row, not whether the row is the one this
  // URL is about. The extra `.eq` is what closes it, and it is one line that
  // is easy to drop while copying.
  const artists = read("lib/crm/artists.ts");
  const venues = read("lib/crm/venues.ts");

  /**
   * The argument text of every `commitWrite(...)` call, read by the same
   * balanced-paren scan `callArguments` uses.
   *
   * SPLITTING ON THE TABLE NAME DOES NOT WORK, and the first version of these
   * two tests did exactly that and failed for the right reason: `String.split`
   * leaves the whole tail of the file as the last chunk, so a later,
   * unrelated `commitWrite` (the venue's own restore) landed inside the chunk
   * being asserted about rooms. One statement at a time is the only honest
   * unit.
   */
  function commitWrites(rawSource: string): string[] {
    const source = rawSource
      .split("\n")
      .map((line) => (line.trimStart().startsWith("//") ? "" : line))
      .join("\n");
    const needle = "commitWrite(";
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = source.indexOf(needle, from);
      if (at === -1) return out;
      let depth = 0;
      let i = at + needle.length - 1;
      for (; i < source.length; i += 1) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(source.slice(at + needle.length, i));
      from = i;
    }
  }

  it("every artist_representations UPDATE scopes to the artist", () => {
    const writes = commitWrites(artists).filter((call) =>
      call.includes(`.from("artist_representations")`),
    );
    // update, remove (soft delete) and restore.
    expect(writes).toHaveLength(3);
    for (const call of writes) {
      expect(call).toContain(`.eq("artist_id", artistId)`);
      expect(call).toContain(`.eq("id", representationId)`);
      expect(call).toContain(`count: "exact"`);
    }
  });

  it("every venue_rooms UPDATE scopes to the venue", () => {
    const writes = commitWrites(venues).filter((call) =>
      call.includes(`.from("venue_rooms")`),
    );
    // rename, close and reopen.
    expect(writes).toHaveLength(3);
    for (const call of writes) {
      expect(call).toContain(`.eq("venue_id", venueId)`);
      expect(call).toContain(`.eq("id", roomId)`);
      expect(call).toContain(`count: "exact"`);
    }
  });
});

describe("the primary-representation RPC is called with three arguments", () => {
  // 20260828234500's instruction to Task 4b in as many words: "Copy the
  // demote/promote ORDER, the raise-rather-than-return-0 rule, AND
  // p_organisation_id on BOTH statements." There is no 2-arg overload of the
  // function to fall back to, so omitting the key here is a 404 rather than an
  // unscoped write -- but a 404 rendered as "something went wrong" is still a
  // defect, and the organisation must come from the RESOLVED org.
  const artists = read("lib/crm/artists.ts");
  it("passes p_organisation_id from the resolved org, never from the form", () => {
    expect(artists).toContain(`supabase.rpc("set_artist_primary_representation"`);
    expect(artists).toContain("p_organisation_id: org.id");
  });
});

describe("only the two writes that earn it override the conflict sentence (N-9)", () => {
  // CONFLICT_MESSAGE is generic because it is wired to every action in the
  // phase. Two writes on artist_representations have a 23505 path with a
  // specific, TRUE sentence: the promote (a real race) and the restore (not a
  // race at all -- see REPRESENTATION_PRIMARY_CONFLICT). Nothing else may name
  // an operation.
  const artists = read("lib/crm/artists.ts");
  const agencies = read("lib/crm/agencies.ts");
  const venues = read("lib/crm/venues.ts");

  it("artists.ts defines exactly the two specific sentences", () => {
    expect(artists).toContain("const REPRESENTATION_PRIMARY_CONFLICT =");
    expect(artists).toContain("const PRIMARY_REPRESENTATION_CONFLICT =");
    expect(artists.match(/failureState\(result, formData, /g)).toHaveLength(2);
  });

  it("agencies.ts and venues.ts render the generic sentence only", () => {
    for (const source of [agencies, venues]) {
      expect(source).not.toContain("CONFLICT =");
      expect(source).not.toContain("failureState(result, formData, ");
    }
  });
});
