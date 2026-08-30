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

describe("PERMISSION_FOR_ENTITY mirrors private.entity_is_manageable()", () => {
  // A FIFTH COPY OF A MAPPING THAT LIVES IN SQL, and this is what binds it.
  // The SQL function is the ENFORCEMENT -- every custom field value write is
  // decided by it through the three write policies -- while the TypeScript
  // table only decides which sentence a blocked user reads and whether the
  // panel renders controls. Getting it wrong here cannot open a write; it can
  // show the wrong explanation, or hide a control from somebody who could have
  // used it, which is the "hidden loses the explanation" mistake
  // components/crm/write-gate.tsx exists to avoid.
  //
  // The live-catalogue half (every entity type HAS a branch at all) is
  // tests/integration/crm/custom-field-entity-types-match-db.test.ts. This is
  // the half that checks WHICH KEY each branch names, which is a fact about
  // the source rather than about the deployed shape.
  const helpers = read(
    "supabase/migrations/20260828120500_crm_policy_helpers.sql",
  );
  const start = helpers.indexOf(
    "create or replace function private.entity_is_manageable(",
  );
  const body = helpers.slice(
    start,
    helpers.indexOf("comment on function private.entity_is_manageable"),
  );

  it("finds the function body at all, so this cannot pass vacuously", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("when 'venue' then");
  });

  const EXPECTED: Record<string, string> = {
    company: "manage_contacts",
    contact: "manage_contacts",
    agency: "manage_contacts",
    artist: "manage_artists",
    venue: "manage_venues",
  };

  for (const [entity, key] of Object.entries(EXPECTED)) {
    it(`'${entity}' resolves to ${key} in SQL and in TypeScript`, () => {
      // The branch text between this `when` and the next one.
      const from = body.indexOf(`when '${entity}' then`);
      expect(from, `no '${entity}' branch`).toBeGreaterThan(-1);
      const nextWhen = body.indexOf("    when '", from + 10);
      const branch = body.slice(from, nextWhen === -1 ? undefined : nextWhen);
      expect(branch).toContain(`permitted_organisations('${key}')`);

      const fields = read("lib/crm/custom-fields.ts");
      const table = fields.slice(
        fields.indexOf("export const PERMISSION_FOR_ENTITY"),
        fields.indexOf("export const ENTITY_PATH_SEGMENT"),
      );
      expect(table).toContain(`${entity}: "${key}"`);
    });
  }
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
