import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NETWORK_DIRECTORY_LIST,
  NETWORK_DIRECTORY_SELECT,
} from "@/lib/network/discovery-list";
import { PUBLISHABLE_FIELDS } from "@/lib/network/fields";

// SOURCE-ONLY SHAPE ASSERTIONS OVER THE NETWORK CONTROLS.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHY IT IS IN tests/unit RATHER THAN INTEGRATION
// ===========================================================================
// The phase Global Constraints' CI note, verbatim: CI runs `pnpm lint`,
// `next typegen`, `pnpm typecheck` and `pnpm exec vitest run tests/unit` -- and
// NOT tests/integration, NOT the psql/HTTP suite, NOT Playwright. So
// "a green tick on CI is not a green phase", and it matters more in this phase
// than in any prior one: THE NETWORK-LEAKAGE SUITE -- the one CLAUDE.md calls
// the kind that "matters most" -- RUNS ONLY ON A DEVELOPER'S MACHINE.
//
// Every network control therefore additionally owes a SOURCE-ONLY assertion, so
// a source-only CI still reddens on its regression. That is what this is. It is
// deliberately blunt: it reads the migration text and the list spec and asserts
// the shapes are still WRITTEN DOWN.
//
// ===========================================================================
// WHAT THIS IS NOT
// ===========================================================================
// Not a substitute for supabase/tests/rls_phase6_network.sql, which is what
// says these shapes MEAN anything -- it drives them against a real Postgres
// with real policies and real sessions, both ways round, with denominators.
// This says only that the text has not changed. A mutation that alters
// behaviour without altering these strings passes here and fails there, which
// is the correct division of labour and the reason both exist.
//
// The same reasoning tests/unit/crm/source-shape.test.ts states for omitted
// query-builder options, applied to a boundary rather than to a save.

const root = fileURLToPath(new URL("../../../", import.meta.url));

// LINE ENDINGS ARE NORMALISED, for the reason tests/unit/crm/source-shape.ts
// gives at length: the repository sets no `text` policy in `.gitattributes`, so
// a Windows checkout with core.autocrlf has CRLF everywhere and every
// multi-line `toContain` below would fail against perfectly correct source.
// Nothing this file asserts is ABOUT line endings.
function read(relative: string): string {
  return readFileSync(root + relative, "utf8").replace(/\r\n/g, "\n");
}

const TABLES = read("supabase/migrations/20260904000000_network_tables.sql");
const HELPER = read(
  "supabase/migrations/20260904001000_network_publish_entitlement_helper.sql",
);
const PERMISSIONS = read(
  "supabase/migrations/20260904002000_network_permissions.sql",
);
const POLICIES = read(
  "supabase/migrations/20260904003000_network_rls_policies.sql",
);
const VIEWS = read(
  "supabase/migrations/20260904004000_network_discovery_views.sql",
);
const AUDIT = read(
  "supabase/migrations/20260904005000_network_audit_triggers.sql",
);

/**
 * The migration with its `--` comments removed.
 *
 * NEEDED, NOT TIDY. Several assertions below are ABSENCE claims -- no `anon`
 * grant, no DELETE grant, no mention of a rating -- and every one of those
 * things is DISCUSSED at length in the headers, because a control whose
 * absence is the point has to say so somewhere. Run over the raw text they all
 * fail against perfectly correct source, which is exactly what happened on the
 * first run of this file. So the absence claims are made against the
 * EXECUTABLE text, with the comments stripped first.
 */
function executable(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * ...and with every `comment on ... is '...';` statement removed as well.
 *
 * A `comment on` body is documentation that happens to be a statement, so it
 * survives `executable()`. The ratings guard needs it gone for the same reason
 * psql § NF reads policy/view/function BODIES rather than whole objects: the
 * migrations discuss ratings BY NAME, because the whole point is to record that
 * an accepted connection unlocks none of them.
 */
function withoutDocs(sql: string): string {
  return executable(sql).replace(/comment on [\s\S]*?';/g, "");
}

/** Everything from `create or replace view <name>` to the terminating `;`. */
function viewBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace view public.${name}`);
  expect(start, `view ${name} is created in this migration`).toBeGreaterThan(-1);
  const end = source.indexOf(";", start);
  return source.slice(start, end);
}

/** The `using (...)` / `with check (...)` text of one named policy. */
function policyBody(name: string): string {
  const start = POLICIES.indexOf(`create policy "${name}"`);
  expect(start, `policy ${name} is created in this migration`).toBeGreaterThan(-1);
  const end = POLICIES.indexOf("\ncomment on policy", start);
  return POLICIES.slice(start, end === -1 ? undefined : end);
}

describe("N2: the masking views read the network tables and NOTHING ELSE", () => {
  // The source-only half of the pg_depend assertion (rls_phase6_network.sql
  // § ND), which runs only on a developer's machine. This one catches the same
  // edit in CI, by the crude method of looking for any other `public.` name in
  // the view body.
  //
  // CORRECTED IN FIX ROUND 1 (review finding I1). This comment used to say the
  // pg_depend assertion "is authoritative -- it reads the planner's own record,
  // so it sees a join however it is written". THAT WAS FALSE WHEN IT WAS
  // WRITTEN: § ND's query filtered `relkind = 'r'`, and pg_depend records a
  // view->VIEW dependency as the referenced VIEW's pg_class row, never
  // transitively as its base tables -- so a join to public.activity_events was
  // invisible to it and visible to THIS file. § ND has since been widened to
  // any relkind in any schema, plus a function census, so the sentence is true
  // now; it is recorded as a correction rather than quietly rewritten, because
  // for one review cycle the CI guard was the STRONGER of the two and the
  // comment claimed the reverse.
  //
  // The division of labour that remains true: § ND reads the deployed catalog
  // and so sees a dependency however the SQL is spelled, including one added by
  // a later migration this file does not read; this file reads only the source
  // of the six Task 1 migrations and so cannot see either.
  const ALLOWED = [
    "public.network_profiles",
    "public.network_connection_requests",
  ];

  for (const view of ["network_directory", "network_connected_profiles"]) {
    it(`${view} names no public table but the network ones`, () => {
      const body = viewBody(VIEWS, view);
      const referenced = [
        ...new Set(Array.from(body.matchAll(/public\.\w+/g), (m) => m[0])),
      ].filter((name) => name !== `public.${view}`);
      for (const name of referenced) {
        expect(
          ALLOWED,
          `${view} references ${name}. Joining a private table into a ` +
            "discovery path is what N2 forbids -- CLAUDE.md § The " +
            "private/network split: 'Do not join private tables into public " +
            "discovery paths without an explicit, tested policy.'",
        ).toContain(name);
      }
      // The denominator: it found something to inspect.
      expect(referenced.length, `${view} references at least one table`).toBeGreaterThan(0);
    });
  }

  it("the directory view names only network_profiles; the connected one names both", () => {
    const directory = viewBody(VIEWS, "network_directory");
    expect(directory).toContain("public.network_profiles");
    expect(directory).not.toContain("public.network_connection_requests");

    const connected = viewBody(VIEWS, "network_connected_profiles");
    expect(connected).toContain("public.network_profiles");
    expect(connected).toContain("public.network_connection_requests");
  });
});

describe("the masking views mask, and do not project a tenant", () => {
  it("every publishable field is behind a `case when` in BOTH views", () => {
    // THE ASSERTION WHOSE FAILURE IS A LEAK. Replacing a `case when … end` with
    // a bare `p.col` publishes a field the publisher marked hidden or
    // connections-only. The psql suite proves it behaviourally (§ NM); this
    // catches the same edit from source, in CI.
    for (const view of ["network_directory", "network_connected_profiles"]) {
      const body = viewBody(VIEWS, view);
      for (const name of PUBLISHABLE_FIELDS) {
        expect(
          body,
          `${view} projects ${name} without a visibility test`,
        ).toContain(`field_visibility->>'${name}'`);
        // ...and the bare form is absent. `p.<name>` appears INSIDE the case
        // expression, so the check is that it never appears immediately
        // followed by ` as ` or `,` at the top level -- i.e. as a bare
        // projection.
        expect(body).not.toMatch(
          new RegExp(`\\n\\s+p\\.${name}\\s*(,|as\\b)`),
        );
      }
    }
  });

  it("neither view projects organisation_id or entity_id", () => {
    for (const view of ["network_directory", "network_connected_profiles"]) {
      const body = viewBody(VIEWS, view);
      expect(body, `${view} projects a tenant identifier`).not.toMatch(
        /\n\s+p\.organisation_id\s*(,|as\b)/,
      );
      expect(body, `${view} projects a private record id`).not.toMatch(
        /\n\s+p\.entity_id\s*(,|as\b)/,
      );
    }
  });

  it("the directory tests `= 'network'` and the connected one `in ('network','connections')`", () => {
    // The two views differ in exactly one way, and it is the whole feature. A
    // connected view that tested `= 'network'` would make an accepted
    // connection unlock nothing; a directory that tested the `in (...)` form
    // would publish connections-only fields to everyone.
    const directory = viewBody(VIEWS, "network_directory");
    expect(directory).toContain("= 'network' then");
    expect(directory).not.toContain("in ('network','connections')");

    const connected = viewBody(VIEWS, "network_connected_profiles");
    expect(connected).toContain("in ('network','connections')");
  });

  it("BOTH views are security_invoker and neither is granted to anon", () => {
    for (const view of ["network_directory", "network_connected_profiles"]) {
      expect(viewBody(VIEWS, view)).toContain("security_invoker = true");
    }
    expect(VIEWS).toContain(
      "grant select on public.network_directory, public.network_connected_profiles to authenticated;",
    );
    // Against the EXECUTABLE text: the header discusses `anon` at length,
    // because the absence of the grant IS the control (N6/Q70).
    expect(executable(VIEWS)).not.toMatch(/grant[^;]*\banon\b/);
  });
});

describe("Constraint 2: every network policy uses the set form", () => {
  // A SHAPE RULE, and no behavioural test can tell the two forms apart -- they
  // return identical rows for every user. The psql § NS carries the
  // authoritative version (read back through pg_get_expr, so quoting and
  // whitespace are normalised); this is its CI-visible twin.
  const POLICY_NAMES = [
    "network_profiles_select_view_network",
    "network_profiles_select_published_directory",
    "network_profiles_insert_manage_profile",
    "network_profiles_update_manage_profile",
    "network_links_select_view_network",
    "network_links_insert_manage_connections",
    "network_links_update_manage_connections",
    "network_connection_requests_select_view_network",
    "network_connection_requests_insert_manage_connections",
    "network_connection_requests_update_recipient_responds",
    "network_connection_requests_update_sender_withdraws",
  ];

  it("all eleven policies are in the migration, and that is the denominator", () => {
    for (const name of POLICY_NAMES) {
      expect(POLICIES, `policy ${name}`).toContain(`create policy "${name}"`);
    }
    expect(POLICY_NAMES.length).toBe(11);
    // ...and there are no OTHERS. A twelfth policy added without a line here is
    // one nothing in CI inspects.
    const created = Array.from(
      POLICIES.matchAll(/create policy "([^"]+)"/g),
      (m) => m[1]!,
    );
    expect(created.sort()).toEqual([...POLICY_NAMES].sort());
  });

  it("none of them uses the per-row has_permission( form", () => {
    for (const name of POLICY_NAMES) {
      expect(policyBody(name), `${name} uses has_permission(`).not.toContain(
        "has_permission(",
      );
    }
  });

  it("none of them is a FOR ALL policy", () => {
    // A `for all` policy silently applies its USING as the WITH CHECK for
    // INSERT, which is how a read predicate ends up governing a write.
    expect(POLICIES).not.toMatch(/for all\b/);
  });

  it("ten use permitted_organisations; the directory policy is the stated exception", () => {
    const withKey = POLICY_NAMES.filter((n) =>
      policyBody(n).includes("permitted_organisations("),
    );
    expect(withKey.length).toBe(10);
    expect(
      POLICY_NAMES.filter((n) => !withKey.includes(n)),
    ).toEqual(["network_profiles_select_published_directory"]);
  });
});

describe("Q82: network_links' SELECT policy has no counterparty path", () => {
  it("its body contains no occurrence of network_profiles at all", () => {
    // THE REPLACEMENT GUARD for the single-column network_profile_id FK -- the
    // one Constraint 4 exemption in this phase. Adding an
    // `or exists (… network_profiles …)` branch reads as a reasonable "let the
    // profile's owner see their own links" and would disclose, to every
    // published organisation, the identity of every organisation that has filed
    // them.
    expect(
      policyBody("network_links_select_view_network"),
      "a counterparty read path has been added to network_links",
    ).not.toContain("network_profiles");
  });

  it("...and the write policies read only id/status/deleted_at from it", () => {
    for (const name of [
      "network_links_insert_manage_connections",
      "network_links_update_manage_connections",
    ]) {
      const body = policyBody(name);
      expect(body, `${name} reads p.status`).toContain("p.status");
      for (const column of [
        "p.organisation_id",
        "p.display_name",
        "p.entity_id",
        "p.field_visibility",
      ]) {
        expect(body, `${name} reads ${column}`).not.toContain(column);
      }
    }
  });

  it("network_links has exactly one SELECT policy", () => {
    const selects = Array.from(
      POLICIES.matchAll(/on public\.network_links for select/g),
    );
    expect(selects.length).toBe(1);
  });
});

describe("the two connection UPDATE policies are two, and each binds its actor", () => {
  it("neither is a single policy with an `or` across the organisation columns", () => {
    // A merged policy would let a SENDER mark its own request accepted, because
    // neither clause would tie the actor to the transition.
    const updates = Array.from(
      POLICIES.matchAll(/on public\.network_connection_requests for update/g),
    );
    expect(updates.length).toBe(2);
  });

  it("the recipient policy pins to_organisation_id and the landing status", () => {
    const body = policyBody("network_connection_requests_update_recipient_responds");
    expect(body).toContain("to_organisation_id in (select private.permitted_organisations('manage_network_connections'))");
    expect(body).toContain("status in ('accepted','declined')");
    expect(body).toContain("network_publish_organisations");
  });

  it("the sender policy pins from_organisation_id IN ITS WITH CHECK, not only its USING", () => {
    // THE DEVIATION FROM THE BRIEF THAT CLOSES A REAL HOLE, guarded here so it
    // cannot be "simplified" back. PostgreSQL ORs PERMISSIVE POLICIES IN BOTH
    // CLAUSES, so a WITH CHECK of `status = 'withdrawn'` alone is satisfied by
    // a RECIPIENT whose USING passed through the other policy -- measured on
    // this stack. Repeating the organisation term is what binds the actor to
    // the transition, which is the entire point of the two-policy split.
    const body = policyBody("network_connection_requests_update_sender_withdraws");
    const withCheck = body.slice(body.indexOf("with check"));
    expect(
      withCheck,
      "the sender policy's WITH CHECK no longer names from_organisation_id -- " +
        "a recipient can now withdraw",
    ).toContain("from_organisation_id");
    expect(withCheck).toContain("status = 'withdrawn'");
    // ...and it deliberately carries NO tier term: a Free organisation must be
    // able to retract a request it can no longer act on.
    expect(withCheck).not.toContain("network_publish_organisations");
  });
});

describe("N3 and the closed vocabulary are enforced in the migration, not only in TypeScript", () => {
  it("every publishable field is governed by the hidden-fields CHECK", () => {
    for (const name of PUBLISHABLE_FIELDS) {
      expect(TABLES).toContain(`coalesce(field_visibility->>'${name}','hidden')`);
    }
  });

  it("the vocabulary function is defined AND wired to a CHECK", () => {
    // A validator nothing calls is the Phase 5 I2 defect (Constraint 19).
    expect(TABLES).toContain(
      "create or replace function private.network_visibility_is_valid",
    );
    expect(TABLES).toContain(
      "check (private.network_visibility_is_valid(field_visibility))",
    );
  });

  it("...and it is granted EXECUTE to authenticated, or every client insert is a 42501", () => {
    // A CHECK expression is evaluated as the INSERTING role. Without the grant
    // the refusal is a privilege error rather than a constraint violation --
    // a refusal nobody can diagnose (the custom_field_options_valid precedent).
    expect(TABLES).toContain(
      "grant execute on function private.network_visibility_is_valid(jsonb) to authenticated;",
    );
  });

  it("display_name and entity_kind are NOT settable visibility keys", () => {
    const start = TABLES.indexOf("kv.key not in (");
    const end = TABLES.indexOf("kv.value not in (", start);
    const keys = TABLES.slice(start, end);
    expect(keys).not.toContain("display_name");
    expect(keys).not.toContain("entity_kind");
    for (const name of PUBLISHABLE_FIELDS) {
      expect(keys, `${name} is a settable key`).toContain(`'${name}'`);
    }
  });
});

describe("N6 and N7: anon holds nothing, and the tier gate is on the writes", () => {
  it("no network object is granted to anon in any of the six migrations", () => {
    for (const [name, source] of [
      ["tables", TABLES],
      ["helper", HELPER],
      ["permissions", PERMISSIONS],
      ["policies", POLICIES],
      ["views", VIEWS],
      ["audit", AUDIT],
    ] as const) {
      const grants = Array.from(source.matchAll(/^grant [^;]+;/gm), (m) => m[0]);
      for (const grant of grants) {
        expect(grant, `${name}: a grant reaches anon`).not.toMatch(/\banon\b/);
      }
    }
  });

  it("there is no DELETE grant on any of the three tables", () => {
    // Executable text again: the header says "NO DELETE" in prose.
    const grants = Array.from(
      executable(TABLES).matchAll(/^grant [^;]+;/gm),
      (m) => m[0],
    );
    expect(grants.length, "grants inspected").toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant, "a DELETE grant exists on a network table").not.toMatch(
        /\bdelete\b/i,
      );
    }
  });

  it("the tier helper is the finance one with exactly one substitution", () => {
    // The transcription, guarded. A divergence here is invisible today (the
    // gate is inert) and would surface only in Phase 7.
    // Against the EXECUTABLE text: the header NAMES the substitution it made
    // ("with `p.finance_module` swapped for `p.network_publish`"), which is
    // exactly the sentence a reader needs and exactly what a raw search trips
    // over.
    // withoutDocs, not executable: the `comment on function` body ALSO names
    // the substitution, for the same reason the header does -- it is the
    // sentence that tells a reader what this helper is a copy of.
    const body = withoutDocs(HELPER);
    expect(body).toContain("p.network_publish");
    expect(body).not.toContain("p.finance_module");
    expect(body).not.toContain("p.crm_writes");
    // The three branches, verbatim from finance_module_organisations().
    expect(body).toContain("s.organisation_id is null");
    expect(body).toContain("private.past_due_grace_days()");
    expect(body).toContain("o.deleted_at is null");
    expect(body).toContain("stable security definer set search_path = ''");
  });

  it("all three permission keys are survives_suspension = false", () => {
    // view_crm stays the only `true` key, so rls_phase2_crm M1f's expected set
    // is unchanged. A reviewer's first question about a new READ key.
    for (const key of [
      "view_network",
      "manage_network_profile",
      "manage_network_connections",
    ]) {
      expect(PERMISSIONS).toMatch(new RegExp(`'${key}',\\s+false,`));
    }
    expect(PERMISSIONS).not.toMatch(/'(view|manage)_network[^']*',\s+true,/);
  });
});

describe("N5: the forward ratings guard, from source", () => {
  it("no network migration mentions a rating in any form", () => {
    // CLAUDE.md: ratings are permanently private in v1 -- "not even as an
    // anonymised aggregate on a network profile". public.ratings does not exist
    // yet, so the standing guard is a FORWARD one: the day a ratings table
    // lands, this is already watching.
    // SCOPED TO EXECUTABLE SQL WITH DOCUMENTATION STRIPPED, which is the same
    // scope psql § NF uses (policy, view and function BODIES). It has to be:
    // the migrations name ratings deliberately, because the whole point is to
    // record that an accepted connection unlocks none of them. A guard that
    // could not tell a promise from a projection would forbid writing the
    // promise down.
    for (const [name, source] of [
      ["tables", TABLES],
      ["helper", HELPER],
      ["permissions", PERMISSIONS],
      ["policies", POLICIES],
      ["views", VIEWS],
      ["audit", AUDIT],
    ] as const) {
      expect(
        withoutDocs(source).toLowerCase(),
        `${name} names a rating in executable SQL`,
      ).not.toContain("rating");
    }
    // The denominator: the stripper left real SQL behind to inspect.
    expect(withoutDocs(VIEWS)).toContain("create or replace view");
    expect(withoutDocs(POLICIES)).toContain("create policy");
  });

  it("...and no app-layer IDENTIFIER names one", () => {
    // The app-layer half, and it is narrower on purpose: lib/network/fields.ts's
    // prose contains "celebrating", and a substring search over comments would
    // fail on the letter sequence inside an ordinary English word. What matters
    // is that no exported name, no column name and no string literal in these
    // modules refers to a rating -- so the search is for the word at a
    // boundary, over the code with its comments stripped.
    for (const file of [
      "lib/network/fields.ts",
      "lib/network/access.ts",
      "lib/network/profiles.ts",
      "lib/network/connections.ts",
      "lib/network/links.ts",
      "lib/network/discovery-list.ts",
    ]) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code.toLowerCase(), `${file} names a rating`).not.toMatch(/\brating/);
    }
  });
});

describe("Q84: the audit payload carries no published value", () => {
  it("the payload names field_visibility and identifiers, and no value column", () => {
    // audit_events is superuser-readable, and CLAUDE.md § Superuser dashboard
    // keeps tenant record content off that surface. field_visibility is a map
    // of field NAMES to LEVELS and carries nothing the publisher wrote.
    expect(AUDIT).toContain("'field_visibility', new.field_visibility");
    for (const column of [
      "new.display_name",
      "new.headline",
      "new.bio",
      "new.city",
      "new.region",
      "new.country",
      "new.website_url",
      "new.contact_email",
    ]) {
      expect(AUDIT, `the audit payload carries ${column}`).not.toContain(column);
    }
  });

  it("it keeps audit_crm_row's two load-bearing properties", () => {
    // The null-actor early return (a migration/seed/cascade is not a client
    // action) and the LIVE LOOKUP of organisation_id (naming NEW directly
    // aborts an organisation cascade with 23503 -- New-1 in 20260828160000).
    expect(AUDIT).toContain("if v_actor is null then");
    expect(AUDIT).toContain("from public.organisations o where o.id = new.organisation_id");
    expect(AUDIT).not.toMatch(/p_organisation_id\s*=>\s*new\.organisation_id/);
  });
});

describe("Constraint 19: the directory list reads the VIEW, never the base table", () => {
  it("NETWORK_DIRECTORY_SELECT names only columns the view projects", () => {
    // The network case of Constraint 19, stated in the plan: shipping the
    // masking view while the discovery page reads network_profiles directly
    // would pass every structural assertion ABOUT the view and leak anyway.
    expect(NETWORK_DIRECTORY_SELECT).not.toContain("organisation_id");
    expect(NETWORK_DIRECTORY_SELECT).not.toContain("entity_id");
    expect(NETWORK_DIRECTORY_SELECT).not.toContain("field_visibility");
    expect(NETWORK_DIRECTORY_SELECT).not.toContain("deleted_at");
    for (const name of PUBLISHABLE_FIELDS) {
      expect(NETWORK_DIRECTORY_SELECT, name).toContain(name);
    }
  });

  it("the sort is NOT NULL, backed by the deviating index, and named", () => {
    // Constraint 9. `notNull` is the literal true and `backedBy` is a real
    // index name -- and THIS index leads with the published-state predicate
    // rather than organisation_id, which is the documented deviation.
    const sort = NETWORK_DIRECTORY_LIST.sort.name;
    expect(sort.notNull).toBe(true);
    expect(sort.backedBy).toBe("network_profiles_directory_idx");
    expect(sort.column).toBe("display_name");
    expect(sort.defaultDirection).toBe("asc");
    // ...and that index really is created, with the deviating leading column.
    expect(TABLES).toContain(
      "create index network_profiles_directory_idx\n  on public.network_profiles (status, display_name, id)",
    );
  });

  it("the spec namespaces its query parameters (Constraint 10)", () => {
    expect(NETWORK_DIRECTORY_LIST.paramPrefix).toBe("net_");
    expect(NETWORK_DIRECTORY_LIST.searchColumn).toBe("display_name");
  });
});
