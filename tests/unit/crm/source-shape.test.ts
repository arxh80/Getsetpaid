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
// are eight of them today and Task 4b adds more. `classifyWrite` itself is
// well bound (mutating it turns three assertions red); it is the CALL SITES
// that were unguarded.
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
 */
function callArguments(source: string, method: string): string[] {
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

const CRM_SOURCES = readdirSync(root + "lib/crm")
  .filter((name) => name.endsWith(".ts"))
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
    // Eight in the task as shipped. Asserted as a floor rather than an exact
    // number so Task 4b adding call sites does not turn this red for the wrong
    // reason -- but deleting them all does.
    expect(sites.length).toBeGreaterThanOrEqual(8);
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
      expect(body).toContain("deletedEndState(formData)");
    });
  }

  it("liveInOrg really filters deleted_at, and really scopes the organisation", () => {
    const helper = contacts.slice(
      contacts.indexOf("async function liveInOrg("),
      contacts.indexOf("function deletedEndState("),
    );
    expect(helper).toContain(`.is("deleted_at", null)`);
    expect(helper).toContain(`.eq("organisation_id", organisationId)`);
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
