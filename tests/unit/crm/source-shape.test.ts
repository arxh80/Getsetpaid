import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  PERMISSION_FOR_ENTITY,
} from "@/lib/crm/custom-fields";

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

// LINE ENDINGS ARE NORMALISED, AND THAT IS NOT COSMETIC.
//
// Several assertions in this file are multi-line `toContain` checks against
// source text -- the I-2 block below is the clearest, matching a string that
// contains an escaped newline followed by six spaces. The repository sets no
// `text` policy in `.gitattributes`, so a Windows checkout with
// `core.autocrlf` on has CRLF in every file, and every one of those
// assertions then fails against perfectly correct source. It was red at
// Phase 3 Task 1's starting commit for exactly that reason, on a test whose
// subject had nothing wrong with it.
//
// Normalising here rather than in `.gitattributes` keeps the fix local: a
// repository-wide `text=auto` rewrites every file's line endings in one
// commit, which is a decision for its own change (filed in FOLLOW-UPS.md).
// Nothing this file asserts is ABOUT line endings, so nothing is weakened.
function read(relative: string): string {
  return readFileSync(root + relative, "utf8").replace(/\r\n/g, "\n");
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
    // Phase 3 Task 4 raised this from SEVEN to TWENTY-NINE, counted rather
    // than guessed, and the breakdown is the point of writing the number
    // down: agencies 3, artists 6, companies 3, contacts 4,
    // custom-field-actions 3, events 3, merge 1, venues 6. Task 4b's seven
    // was the state of lib/crm/ before Task 5 and Task 6 landed and before
    // this file's own directory scan started covering them; the three new
    // ones are lib/crm/events.ts's update, soft-delete and restore (there is
    // no DELETE policy on the table and no grant for one).
    expect(sites.length).toBeGreaterThanOrEqual(29);
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

  it("I-3: contacts.ts has NO private liveInOrg -- it imports the shared one", () => {
    // Final review I-3. This file used to define its own `liveInOrg`,
    // byte-for-byte identical to `lib/crm/actions.ts`'s, and there was no
    // mirror test between them -- two copies of the workspace-boundary check
    // RLS deliberately does not perform. What the surviving copy must do is
    // asserted once, over lib/crm/actions.ts, in "the new child writes refuse
    // a soft-deleted parent" below.
    expect(contacts).not.toContain("async function liveInOrg(");
    expect(contacts).toContain('import { liveInOrg } from "@/lib/crm/actions";');
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

// ===========================================================================
// TASK 4b FIX ROUND 1
// ===========================================================================

describe("I-2: a refused write does not throw away what was typed", () => {
  // createRepresentationAction's two field-level refusals ("Choose an
  // artist." / "Choose an agency.") shipped without `values`, discarding
  // every OTHER typed field (role, territory, named agent, both dates,
  // exclusivity) on the most likely first mistake on this form -- the picker
  // defaults to an empty option. The same omission existed on the
  // `if (!id) return { error: FAILED_MESSAGE }` guards this block also
  // checks, in artists.ts and venues.ts -- hidden fields, so effectively
  // unreachable through the rendered form, but the same line. `agencies.ts`'s
  // three equivalents are the same shape and were NOT named by the review, so
  // they are deliberately left alone here (task-4b-fix-1-report.md records
  // the omission).
  const artists = read("lib/crm/artists.ts");
  const venues = read("lib/crm/venues.ts");

  function actionBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport async function ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it("createRepresentationAction echoes values on BOTH the artist and the agency refusal", () => {
    const body = actionBody(artists, "createRepresentationAction");
    expect(body).toContain(
      'fieldErrors: { artistId: "Choose an artist." },\n      values: echoedValues(formData),',
    );
    expect(body).toContain(
      'fieldErrors: { agencyId: "Choose an agency." },\n      values: echoedValues(formData),',
    );
  });

  for (const action of [
    "updateArtistAction",
    "deleteArtistAction",
    "restoreArtistAction",
    "updateRepresentationAction",
    "deleteRepresentationAction",
    "restoreRepresentationAction",
  ]) {
    it(`${action}'s missing-id guard carries values`, () => {
      expect(actionBody(artists, action)).toContain(
        "error: FAILED_MESSAGE, values: echoedValues(formData)",
      );
    });
  }

  for (const action of [
    "updateVenueAction",
    "deleteVenueAction",
    "restoreVenueAction",
    "addRoomAction",
    "renameRoomAction",
    "closeRoomAction",
    "reopenRoomAction",
  ]) {
    it(`${action}'s missing-id guard carries values`, () => {
      expect(actionBody(venues, action)).toContain(
        "error: FAILED_MESSAGE, values: echoedValues(formData)",
      );
    });
  }

  it("setPrimaryRepresentationAction's guard now carries values too", () => {
    // Task 4b fix round 1 left this one alone because the review's I-2
    // paragraph did not name it. The final review's I-1 named the whole class
    // instead, so the exception is gone: there is no action in lib/crm/ whose
    // refusal is allowed to drop what was typed.
    const body = actionBody(artists, "setPrimaryRepresentationAction");
    expect(body).toContain(
      "if (!artistId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };",
    );
  });
});

// ===========================================================================
// FINAL REVIEW I-1 / L797 -- THE SAME OMISSION ON EVERY CREATE PATH
// ===========================================================================
//
// Fix round 1 swept the EDIT paths (the block above). The final review found
// the CREATE paths untouched: every `createXAction` in all five entity
// modules, plus the child/join creates, returned `{ error: REFUSED_MESSAGE }`
// or `{ error: FAILED_MESSAGE }` with no `values`, and React 19 resets a form
// after a Server Action -- so an ordinary policy refusal (a role change
// mid-session, a workspace suspended between page load and submit) threw away
// the whole record the user had just typed.
//
// A per-action list would have missed them, twice now. This is the census
// form instead: EVERY refusal return in EVERY lib/crm module must carry
// `values`. A new module, or a new guard in an old one, is covered the day it
// is written rather than the day someone re-reads the file.
//
// The regex is deliberately the narrow, literal shape -- `return { error: X };`
// on one line, X being a SCREAMING_CASE constant -- because that is the exact
// text the defect has taken all three times it was found, and a broader
// pattern would start matching `failureState()`'s own construction.
describe("I-1: no refusal in lib/crm/ discards what the user typed", () => {
  const BARE_REFUSAL = /return \{ error: [A-Z_]+ \};/g;

  it("finds refusal returns at all, so this cannot pass vacuously", () => {
    // Every `return { error: CONST, values: ... }` across the modules. If a
    // refactor renames the constants or moves every refusal behind a helper,
    // this floor goes red and the guard below stops being a guard silently.
    const withValues = CRM_SOURCES.flatMap(
      (file) => file.text.match(/return \{ error: [A-Z_]+, values: /g) ?? [],
    );
    expect(withValues.length).toBeGreaterThanOrEqual(60);
  });

  for (const file of CRM_SOURCES) {
    it(`${file.name} has no refusal without values`, () => {
      const bare = file.text.match(BARE_REFUSAL);
      expect(
        bare,
        `a refusal with no \`values\` discards the user's work: ${(bare ?? []).join(", ")}`,
      ).toBeNull();
    });
  }
});

// ===========================================================================
// TASK 5 -- the custom fields engine
// ===========================================================================

// PERMISSION_FOR_ENTITY's mirror MOVED TO
// tests/integration/crm/permission-for-entity-matches-db.test.ts IN PHASE 3
// TASK 2 (Task 1 fix round 1, review finding I-2). It does not belong in a
// source-shape file, and being here is what made it wrong twice over:
//
//   * it iterated its OWN hardcoded five-entry EXPECTED map rather than
//     PERMISSION_FOR_ENTITY itself, so Task 1's sixth entry
//     (`event: "manage_events"`) was asserted in neither direction and adding
//     it turned nothing red;
//   * it read 20260828120500_crm_policy_helpers.sql AS TEXT -- the file that
//     first CREATED private.entity_is_manageable(). `create or replace
//     function` means that file stopped being what is deployed the moment
//     20260901010000 replaced it, so it was mirroring a body the database no
//     longer runs.
//
// The replacement iterates the real table, reads the deployed body through
// pg_get_functiondef(), asserts the two key sets are EQUAL (so a seventh entry
// on either side alone is red), checks every key it names exists in
// public.permissions, and drives the dispatch behaviourally as a Booker --
// who holds manage_events and manage_artists and NOT manage_venues, which is
// the one role that can tell "the key is chosen per entity type" from "the
// key is ignored". It needs the local stack, which is why it is an
// integration test and not this one.
//
// ===========================================================================
// AND THAT MOVE COST SOMETHING: **NO PULL-REQUEST GATE WATCHES
// PERMISSION_FOR_ENTITY ANY MORE.**
// ===========================================================================
// CI runs `pnpm exec vitest run tests/unit` and nothing else
// (`.github/workflows/ci.yml`, "Unit tests" -- deliberately named by directory
// so a new integration test does not silently start being skipped). Everything
// under tests/integration/ talks to a live local Supabase stack over HTTP, so
// it runs on a developer's machine via `pnpm test` with the stack up, and on
// no pull request at all.
//
// The replacement is strictly better than what it replaced -- but only where
// it runs. So a CHEAP STATIC HALF stays here, below, and the split is:
//
//   unit (runs in CI, every PR)  -- the TS table is total over the entity
//     vocabulary, and every key it names is a real seeded permission key. That
//     catches a typo, a dropped entry, or a seventh entity type shipped
//     without its mapping, on the PR that introduces it.
//   integration (runs locally)   -- the TS table agrees with the DEPLOYED
//     dispatch about WHICH key each entity type resolves to, and the dispatch
//     really behaves that way. That cannot be asked without a database.
//
// Neither half subsumes the other, and the unit half deliberately does NOT
// re-implement the mapping: it asserts totality and membership, never
// `event -> manage_events`, because a hardcoded expected mapping here is
// exactly the thing that was wrong before. Recorded in FOLLOW-UPS.md.

describe("PERMISSION_FOR_ENTITY is total and names only real permission keys", () => {
  // The CI-side half of the mirror. See the block above for the split.
  const migrations = readdirSync(root + "supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read("supabase/migrations/" + f))
    .join("\n");

  it("finds the permission seed statements at all, so this cannot pass vacuously", () => {
    // Without this, a rename of the catalogue table would make every
    // membership assertion below vacuously true -- there would simply be no
    // seed text to fail against.
    expect(migrations).toContain("insert into public.permissions");
    expect(migrations).toMatch(/\('view_crm',\s+true,/);
  });

  it("is total over CUSTOM_FIELD_ENTITY_TYPES -- no entity type without a key", () => {
    // `PERMISSION_FOR_ENTITY` is typed `Record<CustomFieldEntityType, string>`,
    // so tsc already refuses a MISSING key -- but tsc does not run in every
    // context this file does, and an entity type added to the tuple in the
    // same commit as a `// @ts-expect-error` would slip. This is the runtime
    // restatement, and it is what turns "six" into a number somebody chose.
    expect([...Object.keys(PERMISSION_FOR_ENTITY)].sort()).toEqual(
      [...CUSTOM_FIELD_ENTITY_TYPES].sort(),
    );
    expect(Object.keys(PERMISSION_FOR_ENTITY)).toHaveLength(6);
  });

  it("every key it names is a permission actually seeded by a migration", () => {
    // THE TYPO CATCHER. A key absent from public.permissions is absent from
    // the join inside private.permitted_organisations(), which returns no
    // rows, which fails CLOSED -- so `manage_evnets` would deny every event
    // write in the product and raise nothing anywhere. The seed row shape is
    // `('<key>', <bool>,` in both 20260828210000 and 20260901010000.
    const missing = [...new Set(Object.values(PERMISSION_FOR_ENTITY))].filter(
      (key) =>
        !new RegExp(String.raw`\('${key}',\s+(true|false),`).test(migrations),
    );
    expect(
      missing,
      `permission key(s) named by PERMISSION_FOR_ENTITY but seeded by no ` +
        `migration: ${missing.join(", ")}. A key absent from ` +
        `public.permissions fails CLOSED -- it denies every write of that ` +
        `entity type and raises nothing.`,
    ).toEqual([]);
  });

  it("...and the same check really can fail, on a key nobody seeded", () => {
    // The paired negative. Without it the assertion above passes against a
    // regexp that matches everything -- which is how a source-text guard dies.
    expect(/\('manage_evnets',\s+(true|false),/.test(migrations)).toBe(false);
  });
});

describe("the custom fields panel carries the checkbox-group markers", () => {
  // Same defect as I-2, twice over: `multi_select` is a checkbox group and
  // `boolean` is a group of one, and an unticked box submits nothing -- so
  // without the marker an emptied field is indistinguishable from a form that
  // never had it, and a failed submit re-ticks what the user just cleared. No
  // assertion on a pure function can see an <input> deleted from a .tsx file.
  const panel = read("components/crm/custom-fields-panel.tsx");

  it("renders the hidden marker in BOTH group controls", () => {
    expect(panel.match(/name=\{groupMarkerName\(name\)\}/g)).toHaveLength(2);
    expect(panel).toContain(`type="hidden"`);
  });

  it("derives what is ticked through selectedInGroup, in both", () => {
    expect(panel.match(/selectedInGroup\(/g)).toHaveLength(2);
  });

  it("renders a url value through cell.href, never the raw column", () => {
    // The render-side half of the protocol rule. `cell.href` is safeHref()'s
    // answer; a stored javascript: arrives as null and is rendered as inert
    // text.
    expect(panel).toContain("href={cell.href}");
    expect(panel).not.toContain("href={cell.display}");
  });
});

// ===========================================================================
// FINAL REVIEW I-12 / L858, L859 -- THREE DEFECTS AXE CANNOT SEE
// ===========================================================================
//
// The axe run reported ZERO violations on the custom-fields settings page,
// including on this component, which is the whole point of asserting the
// markup here instead:
//
//   * an error rendered INSIDE a <label> becomes part of the control's
//     accessible name rather than a separately announced error;
//   * an error <p> that nothing references by aria-describedby is announced to
//     nobody -- it is valid markup, so an automated scan is content;
//   * a <form> inside a <span> is invalid (phrasing content cannot contain
//     flow content) and a scanner treats it as a parse quirk, not a violation.
//
// components/ui/field.tsx implements the correct pattern for all three.
describe("I-12: the custom-field editor's accessibility wiring", () => {
  const editor = read("components/crm/custom-field-editor.tsx");
  const panel = read("components/crm/custom-fields-panel.tsx");

  it("the type select is bound by htmlFor/id, not by wrapping", () => {
    expect(editor).toContain('<label htmlFor={typeId}');
    expect(editor).toContain("id={typeId}");
    expect(editor).toContain("aria-describedby={typeError ? typeErrorId : undefined}");
  });

  it("the type error is a <p role=\"alert\"> OUTSIDE the label", () => {
    // The label element must now contain nothing but its text.
    const label = editor.slice(
      editor.indexOf("<label htmlFor={typeId}"),
      editor.indexOf("</label>", editor.indexOf("<label htmlFor={typeId}")),
    );
    expect(label).not.toContain("typeError");
    expect(editor).toContain("id={typeErrorId}");
  });

  it("RemoveField and RestoreField do not put a <form> inside a <span>", () => {
    // Both wrappers, and the two message elements in each.
    expect(editor).not.toContain('<span className="flex flex-col items-end gap-1">');
    expect(
      editor.match(/<div className="flex flex-col items-end gap-1">/g),
    ).toHaveLength(2);
    expect(editor).not.toContain('<span role="alert"');
    expect(editor).not.toContain('<span role="status"');
  });

  it("MultiSelectControl's error is referenced by every checkbox in the group", () => {
    const control = panel.slice(
      panel.indexOf("function MultiSelectControl("),
      panel.indexOf("/** One field, rendered as text."),
    );
    expect(control).toContain("const errorId = ");
    expect(control).toContain("aria-describedby={describedBy}");
    expect(control).toContain("aria-invalid={error ? true : undefined}");
    expect(control).toContain("<p id={errorId} role=\"alert\"");
  });
});

describe("the definition writes carry the entity type as well as the id", () => {
  // A forged `fieldId` naming a definition on a DIFFERENT entity type in the
  // same workspace is permitted by the policy -- it asks whether the caller
  // may write the row, not whether the row is the one this tab is about. The
  // extra `.eq` is what closes it, and it is one line that is easy to drop
  // while copying. Same rule the child writes in artists.ts/venues.ts follow.
  const actions = read("lib/crm/custom-field-actions.ts");

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

  it("every custom_field_definitions UPDATE scopes org, entity type and id", () => {
    const writes = commitWrites(actions).filter((call) =>
      call.includes(`.from("custom_field_definitions")`),
    );
    // update, remove (soft delete) and restore.
    expect(writes).toHaveLength(3);
    for (const call of writes) {
      expect(call).toContain(`.eq("organisation_id", org.id)`);
      expect(call).toContain(`.eq("entity_type", entityType)`);
      expect(call).toContain(`.eq("id", fieldId)`);
      expect(call).toContain(`count: "exact"`);
    }
  });

  it("the create INSERT never takes the organisation from the form", () => {
    const body = actions.slice(
      actions.indexOf("export async function createCustomFieldAction("),
      actions.indexOf("export async function updateCustomFieldAction("),
    );
    expect(body).toContain("organisation_id: org.id");
    expect(body).not.toContain('field(formData, "organisationId")');
  });

  it("updateCustomFieldAction never writes `key` -- it is immutable after creation", () => {
    const body = actions.slice(
      actions.indexOf("export async function updateCustomFieldAction("),
      actions.indexOf("export async function deleteCustomFieldAction("),
    );
    expect(body).not.toContain("key:");
  });
});

describe("the values RPC is called with the workspace, and every refusal echoes", () => {
  const actions = read("lib/crm/custom-field-actions.ts");

  it("passes p_organisation_id from the resolved org, never from the form", () => {
    // 20260828234500: PostgREST resolves an RPC by argument name, so there is
    // no 3-argument overload to fall back to -- omitting the key is a 404
    // rather than an unscoped write, and a 404 rendered as "something went
    // wrong" is still a defect.
    expect(actions).toContain(`supabase.rpc("set_custom_field_values"`);
    expect(actions).toContain("p_organisation_id: org.id");
  });

  it("checks the parent record is live through the shared liveInOrg", () => {
    const body = actions.slice(
      actions.indexOf("export async function saveCustomFieldValuesAction("),
    );
    expect(body).toContain("liveInOrg(");
    expect(body).toContain("refusedEndState(");
  });

  it("every missing-id and validation refusal carries the submitted values", () => {
    // React 19 resets a <form action> once the action resolves, so a refusal
    // with no `values` throws away what the user typed. Every `return` that
    // is not a success in this file has to carry them.
    const bare = actions.match(/return \{ error: FAILED_MESSAGE \};/g);
    expect(bare, "a refusal with no `values` discards the user's work").toBeNull();
    expect(actions).not.toContain("return { error: REFUSED_MESSAGE };");
  });
});

// ---------------------------------------------------------------------------
// TASK 6. The merge is the most destructive write in the phase, so the census
// covers it too -- and the two properties below are the ones nothing else can
// see. `pnpm typecheck` catches the missing switch arm; the RLS suite catches
// the policy; only this catches the merge going round lib/crm/write.ts, or a
// create quietly losing its screening call.
// ---------------------------------------------------------------------------
describe("the merge path goes through the shared write vocabulary", () => {
  const merge = read("lib/crm/merge.ts");

  const dedup = read("lib/crm/dedup.ts");

  it("both RPCs pass p_organisation_id from the resolved org", () => {
    // No 2-argument overload exists, by design (20260828234500): PostgREST
    // resolves by argument name, so an unscoped variant would be one missing
    // key away. Omitting it is a 404, which is a worse failure than a refusal
    // because it renders as "something went wrong".
    expect(merge).toContain(`supabase.rpc("merge_records"`);
    expect(dedup).toContain(`supabase.rpc("screen_for_duplicates"`);
    expect(merge).toContain("p_organisation_id: org.id");
    expect(dedup).toContain("p_organisation_id: organisationId");
  });

  it("screenAfterCreate is NOT exported from the \"use server\" module", () => {
    // A module carrying "use server" exports every function in it as a public
    // HTTP endpoint, and this one takes a raw organisation uuid rather than a
    // slug it re-resolves. The database refuses a workspace the caller is not
    // in either way; the convention exists so nobody has to make that argument
    // at each call site.
    expect(merge.startsWith('"use server"')).toBe(true);
    expect(merge).not.toContain("export async function screenAfterCreate");
    expect(dedup).not.toContain('"use server"');
    expect(dedup).toContain("export async function screenAfterCreate");
  });

  it("every write is classified rather than assumed", () => {
    // A merge that reports success without applying is the worst instance of
    // the 204 defect class in this phase -- it has destroyed one of two
    // records. Two call sites here (the merge and the dismissal) and one in
    // lib/crm/dedup.ts (the auto-merge).
    expect(merge.match(/await commitWrite\(/g)).toHaveLength(2);
    expect(dedup.match(/await commitWrite\(/g)).toHaveLength(1);
    // And the dismissal is a PATCH, so it needs the row count for real.
    expect(merge).toContain(`count: "exact"`);
  });

  it("every refusal carries the submitted values back", () => {
    const bare = merge.match(/return \{ error: [A-Z_]+ \};/g);
    expect(bare, "a refusal with no `values` discards the user's work").toBeNull();
  });

  it("the outcome switch has no default arm", () => {
    const body = merge.slice(
      merge.indexOf("function failureState("),
      merge.indexOf("const PAIR_GONE_MESSAGE"),
    );
    expect(body).toContain("switch (result.outcome)");
    expect(
      body,
      "a `default` arm turns a new WriteResult member from a compile error " +
        "into a wrong sentence shown to somebody who has just merged two records",
    ).not.toContain("default:");
  });

  it("the field choices are read from an allowlist, never from the form's keys", () => {
    // A `choice_organisation_id=duplicate` in a forged submit must not be read
    // at all. `readChoices` iterates the allowlist and looks each key up, which
    // is the opposite of iterating the FormData.
    expect(merge).toContain("MERGEABLE_COLUMNS[entityType]");
    expect(merge).toContain("for (const key of keys)");
  });
});

// ===========================================================================
// FINAL REVIEW I-6 / L771 -- A CAP WITHOUT AN ORDER IS A RANDOM CAP
// ===========================================================================
//
// Five capped child readers in lib/crm/queries.ts carried `.limit(100)` with
// no `ORDER BY`. Postgres returns rows in whatever order it likes, so above
// the cap the hundred that came back were a different hundred on every render.
// The RENDERED order was never at risk -- every one of them sorts again in
// memory -- which is exactly why nothing caught it: the defect is invisible
// until a record crosses 100 children.
//
// A source assertion because reproducing it needs 101 rows on one parent and a
// planner willing to change its mind. Blunt on purpose, like the rest of this
// file.
describe("I-6: every capped reader in lib/crm/queries.ts orders before it caps", () => {
  const queries = read("lib/crm/queries.ts");
  const lines = queries.split(/\r?\n/);
  const caps = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(".limit(") && !line.trimStart().startsWith("//"));

  it("finds the capped readers at all, so this cannot pass vacuously", () => {
    // Six today: two link panels, two representation panels, the rooms panel
    // and the link picker. A floor, so Phase 3 adding one is not a red for the
    // wrong reason -- but deleting them all is.
    expect(caps.length).toBeGreaterThanOrEqual(6);
  });

  for (const { line, index } of caps) {
    it(`the .limit( at queries.ts:${index + 1} is preceded by .order(`, () => {
      // The line immediately above it, in a chained builder, is the last
      // clause before the cap. `.order()` after `.limit()` would be a
      // different query and PostgREST would not apply it to the truncation.
      expect(lines[index - 1], line.trim()).toContain(".order(");
    });
  }
});

// ===========================================================================
// FINAL REVIEW I-2 / L948 -- THE KEYING HALF
// ===========================================================================
//
// The "agreed" half is tested as a pure function in merge-agreement.test.ts.
// This half is not reachable from a node test: the defect is that React does
// not reset an UNCONTROLLED input's DOM state on re-render, which needs a DOM,
// a render and a re-render -- and this repository has no React Testing Library
// (tests/unit is pure functions only, by vitest.config.ts's own rule).
//
// So the assertion is over the source, like the rest of this file. The
// property is exactly one character wide and entirely load-bearing: the field
// rows must be keyed on the SURVIVOR as well as the column, or a swap leaves
// every radio where it was while the default the screen claims to be showing
// has moved underneath it.
describe("I-2: the merge screen's field rows are keyed on the survivor", () => {
  const form = read("components/crm/merge-form.tsx");

  it("FieldRow's key includes the survivor, not just the column", () => {
    expect(form).toContain("key={`${survivor}:${row.key}`}");
    // The FieldRow element specifically -- `key={row.key}` also appears on the
    // AGREED list's <li>, which is read-only markup with no radios in it and
    // is correct as it stands.
    const element = form.slice(form.indexOf("<FieldRow"), form.indexOf("/>", form.indexOf("<FieldRow")));
    expect(element).toContain("key={`${survivor}:${row.key}`}");
  });

  it("the survivor selector is still controlled, so the key can change", () => {
    // The key is only useful because `survivor` is React state. If the
    // selector ever became uncontrolled too, this whole fix would be inert.
    expect(form).toContain('const [survivor, setSurvivor] = useState<"keep" | "duplicate">("keep")');
    expect(form).toContain("checked={survivor === value}");
  });

  it("the agreed/differing split reads row.agreed, never the rendered strings", () => {
    expect(form).toContain("rows.filter((row) => !row.agreed)");
    expect(form).toContain("rows.filter((row) => row.agreed)");
    expect(
      form,
      "comparing displayValue strings is the defect I-2 named",
    ).not.toContain("row.keepValue !== row.duplicateValue");
  });

  it("the page computes `agreed` with valuesAgree, over the STORED values", () => {
    const page = read("app/(app)/[orgSlug]/duplicates/[candidateId]/page.tsx");
    expect(page).toContain(
      "agreed: valuesAgree(keep.values[column], duplicate.values[column])",
    );
    expect(page).toContain(
      "agreed: valuesAgree(keep.custom[definition.id], duplicate.custom[definition.id])",
    );
  });
});

// ===========================================================================
// FINAL REVIEW I-4 / L1039 -- THE TOOLBAR'S name ATTRIBUTES
// ===========================================================================
//
// The derivation is unit-tested in tests/unit/list/param-prefix.test.ts § 5.
// This asserts the toolbar actually USES it: the whole defect was a component
// that computed the right answer one way (buildListHref) and wrote a different
// one into the DOM, so the guard has to be on the DOM half.
describe("I-4: no hardcoded query key in the list toolbar", () => {
  const toolbar = read("components/list/list-toolbar.tsx");

  it("every name= goes through toolbarParamNames", () => {
    expect(toolbar).toContain("const names = toolbarParamNames(spec);");
    for (const bare of [
      'name="q"',
      'name="sort"',
      'name="dir"',
      'name="size"',
      "name={key}",
    ]) {
      expect(toolbar, `${bare} bypasses the spec's namespace`).not.toContain(bare);
    }
  });

  it("the JS submit reads the same names it wrote", () => {
    // The other half, and the one a no-JS test would not catch: FormData is
    // keyed by the rendered `name`, so reading `data.get("q")` after writing
    // `name={names.q}` finds nothing on a prefixed spec.
    expect(toolbar).toContain("data.get(names.q)");
    expect(toolbar).toContain("data.get(names.filters[key])");
  });
});

describe("every create screens for duplicates", () => {
  // Screening is one line per create action and its absence is completely
  // silent: the record saves, the user is happy, and the duplicate is never
  // flagged. Five entity modules, five chances to omit it in a copied file.
  for (const file of [
    "lib/crm/contacts.ts",
    "lib/crm/companies.ts",
    "lib/crm/artists.ts",
    "lib/crm/agencies.ts",
    "lib/crm/venues.ts",
  ]) {
    it(`${file} calls screenAfterCreate and honours an auto-merge`, () => {
      const source = read(file);
      expect(source).toContain("screenAfterCreate(org.id,");
      // AND redirects to the surviving record. Without this branch a contact
      // that auto-merged away redirects to its own page, which is now a
      // soft-deleted record -- a 404 the user caused by saving a form.
      expect(source).toContain("if (screened.mergedInto)");
    });
  }
});

// ===========================================================================
// PHASE 3 TASK 4 -- the event write path
// ===========================================================================
//
// The `.update(` / `.delete(` census above already covers `lib/crm/events.ts`
// without an edit: `CRM_SOURCES` reads the whole directory. What needed
// raising is the FLOOR, whose stated job is that the suite cannot pass
// vacuously -- see the assertion's own comment for the number and how it was
// counted.

describe("loadVenuesForPicker does not offer soft-deleted venues or rooms", () => {
  // The same mutation as `loadLinkOptions` above (mutation 8 in the Task 4
  // review's table: dropping the filter was invisible to the whole suite), one
  // picker along -- and this one matters more, because the record it would
  // start offering is a venue an event would then be SAVED against.
  const queries = read("lib/crm/queries.ts");
  const body = queries.slice(queries.indexOf("export async function loadVenuesForPicker"));

  it("filters deleted_at in the query", () => {
    expect(body).toContain(`.is("deleted_at", null)`);
  });

  it("scopes the query to one organisation", () => {
    expect(body).toContain(`.eq("organisation_id", organisationId)`);
  });

  it("...and both filters are on the VENUES query, not only the rooms one", () => {
    // The function runs two capped queries. A `.is("deleted_at", null)`
    // anywhere in the body satisfies the two assertions above, so this one
    // pins the half that decides which venues are offered.
    const venuesQuery = body.slice(
      body.indexOf(`.from("venues")`),
      body.indexOf(`.limit(LINK_PANEL_LIMIT)`),
    );
    expect(venuesQuery).toContain(`.eq("organisation_id", organisationId)`);
    expect(venuesQuery).toContain(`.is("deleted_at", null)`);
  });

  it("the two deliberate exceptions are the stored-value lookups, and they are named", () => {
    // `lookupPlace` and the stored-room query must NOT filter `deleted_at`:
    // their whole job is to find the deleted venue or closed room an event
    // already names, so the `<select>` contains the stored value and editing
    // another field does not silently clear it. Asserted so that "adding the
    // filter everywhere" is a red rather than a silent data loss.
    const lookup = queries.slice(
      queries.indexOf("async function lookupPlace("),
      queries.indexOf("/** One venue in the event form's picker"),
    );
    expect(lookup).toContain(`.select("name, deleted_at")`);
    expect(lookup).not.toContain(`.is("deleted_at", null)`);
  });
});

describe("loadEvent serves a soft-deleted event, so restore is reachable", () => {
  // The same rule as every other detail loader, and the one a copy of a LIST
  // query would get wrong: a 404 after deleting is the shape that makes people
  // afraid of the delete button, and the restore list would link into nothing.
  const queries = read("lib/crm/queries.ts");
  const body = queries.slice(
    queries.indexOf("export async function loadEvent("),
    queries.indexOf("async function lookupPlace("),
  );

  it("selects deleted_at rather than filtering it", () => {
    expect(body).toContain("deleted_at");
    expect(body).not.toContain(`.is("deleted_at", null)`);
  });

  it("scopes to one organisation and renders the ticket link through safeHref", () => {
    expect(body).toContain(`.eq("organisation_id", organisationId)`);
    // The render-side half of the protocol rule. A stored `javascript:` --
    // from an import, or a direct PostgREST PATCH with the anon key past the
    // CHECK constraint's reach -- must reach the page as `null` and be
    // rendered as inert text.
    expect(body).toContain("ticketLinkHref: safeHref(");
    expect(body).not.toContain("ticketLinkHref: data.ticket_link");
  });
});

describe("the event writes refuse a soft-deleted venue", () => {
  // THE ONE END THAT IS APPLICATION-ONLY. `events_venue_fkey` is composite on
  // (venue_id, organisation_id), so the DATABASE holds the tenant half -- but
  // there is no `deleted_at` term in the events write policies, deliberately,
  // so nothing except these four lines refuses a save against a venue the
  // workspace has deleted.
  //
  // A source assertion because a Server Action is not drivable from a node
  // test in this repository (tests/unit is pure functions only, by the
  // config's own rule). The behavioural half is the browser walk in the task
  // report.
  const events = read("lib/crm/events.ts");

  function actionBody(name: string): string {
    const start = events.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = events.indexOf("\nexport async function ", start + 1);
    return events.slice(start, next === -1 ? undefined : next);
  }

  const ACTIONS = [
    "createEventAction",
    "updateEventAction",
    "deleteEventAction",
    "restoreEventAction",
  ] as const;

  it("exactly the two WRITES check the venue end, and the two lifecycle actions do not", () => {
    // The denominator, so this block cannot pass vacuously by nobody calling
    // `liveInOrg` at all -- which is exactly what factoring the check into a
    // helper would produce. Delete and restore touch no `venue_id`, and
    // refusing to delete an event because somebody else deleted its venue
    // would leave the user with a record they cannot remove.
    const checking = ACTIONS.filter((name) => actionBody(name).includes("liveInOrg("));
    expect(checking).toEqual(["createEventAction", "updateEventAction"]);
  });

  for (const action of ACTIONS) {
    it(`${action} pairs liveInOrg with refusedEndState, or has neither`, () => {
      const body = actionBody(action);
      if (!body.includes("liveInOrg(")) {
        expect(body).not.toContain("refusedEndState(");
        return;
      }
      expect(body).toContain(`liveInOrg(supabase, "venues", org.id, parsed.values.venueId)`);
      expect(body).toContain("refusedEndState(ends, formData)");
    });
  }

  it("createEventAction does NOT screen for duplicates, and says why", () => {
    // The inverse of "every create screens for duplicates" below, and it is a
    // decision rather than an omission: 20260901001000 § (c) (Q30) gave
    // private.dedup_entity_table() no 'event' arm, so the call would FAIL
    // rather than return null -- unlike the four Phase 2 entities whose
    // auto-merge branch is dead but harmless. There must also be no dead
    // branch left behind pretending otherwise.
    //
    // OVER THE CODE, NOT THE PROSE. This file's header names both tokens in
    // order to explain their absence, and `.toContain` cannot tell a sentence
    // from a statement -- the same trap N-3 sprang on the census above, which
    // counted a `.update(` in lib/crm/write.ts's header as a call site.
    const code = events
      .split("\n")
      .map((line) => (line.trimStart().startsWith("//") ? "" : line))
      .join("\n");
    expect(code).not.toContain("screenAfterCreate(");
    expect(code).not.toContain("screened.mergedInto");
    // The decision's name, in the prose, so the absence is explained and not
    // merely true.
    expect(events).toContain("20260901001000");
  });

  it("every write asks for the row count and pins the organisation", () => {
    // Belt and braces over the directory-wide census above, because the three
    // writes here are the ones a copied file loses first.
    const writes = events.match(/\.update\(/g) ?? [];
    expect(writes).toHaveLength(3);
    for (const action of ["updateEventAction", "deleteEventAction", "restoreEventAction"]) {
      const body = actionBody(action);
      expect(body, action).toContain(`count: "exact"`);
      expect(body, action).toContain(`.eq("organisation_id", org.id)`);
      expect(body, action).toContain(`.eq("id", eventId)`);
    }
  });
});

describe("the event form echoes every field a refusal would otherwise wipe", () => {
  // React 19 resets a `<form action>` once the action resolves, so an
  // UNCONTROLLED form -- which this one is, deliberately, because it then works
  // with JavaScript disabled -- puts every input back to its `defaultValue`.
  // A field whose default does not read the echo comes back EMPTY after a
  // refusal, and the user who mistyped one character loses the record they
  // just entered. That is invisible to tsc, to lint, and to every other test
  // here: no assertion on a pure function can see a `??` deleted from a .tsx
  // file.
  //
  // ONE ECHO PER RENDERED FIELD, WRITTEN OUT RATHER THAN THROUGH A HELPER.
  // components/crm/venue-form.tsx routes its defaults through a `shown()`
  // closure, which is tidier and leaves exactly one `state.values?.` in the
  // file -- so a field added without an echo is invisible to a census. Here
  // the ten are literal, and the count below is the guard.
  const form = read("components/crm/event-form.tsx");

  const FIELDS = [
    "name",
    "startsAt",
    "endsAt",
    "eventType",
    "status",
    "venueId",
    "venueRoomId",
    "location",
    "ticketLink",
    "notes",
  ] as const;

  it("reads the echo for each of the ten fields, and for no others", () => {
    const echoes = form.match(/state\.values\?\.[A-Za-z]+/g) ?? [];
    expect(
      [...echoes].sort(),
      "a field rendered without `state.values?.<name> ??` loses what was typed",
    ).toEqual(FIELDS.map((name) => `state.values?.${name}`).sort());
    // The count as well as the set: a duplicated echo would pass the set
    // comparison above while meaning a field is rendered twice.
    expect(echoes).toHaveLength(FIELDS.length);
    expect(FIELDS).toHaveLength(10);
  });

  it("every echo falls back to the stored value rather than to an empty string", () => {
    // `state.values?.name ?? ""` on an EDIT form renders an empty input over a
    // record that has a name -- the mirror-image defect, and the one a
    // careless fix for the first would introduce.
    for (const name of FIELDS) {
      expect(form, name).toContain(`state.values?.${name} ?? values.${name}`);
    }
  });

  it("carries NO checkbox-group marker, and says so", () => {
    // Every other form in components/crm/ carries `groupMarkerName(...)`,
    // because an unticked checkbox submits nothing and "none" then collides
    // with "not asked" (lib/forms.ts). This form has no checkbox and no
    // multi-select -- status and type are `<select>`s over closed
    // vocabularies, which always submit -- so the marker would be dead code.
    // Its ABSENCE is asserted with the explanation required beside it, because
    // an unexplained absence here reads as the I-2 bug.
    expect(form).not.toContain("groupMarkerName(");
    expect(form).toContain("NO CHECKBOX GROUP ON THIS FORM");
  });
});
