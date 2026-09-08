// THE BINDING BETWEEN THE TWO HALVES OF IMPERSONATION.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// Phase 7 Task 2 has a half in SQL (20260908020000: the grant, the time-box,
// the read-only envelope) and a half in TypeScript (lib/admin/
// impersonation-contract.ts: IMPERSONATION_TIME_BOX_MINUTES,
// IMPERSONATION_ROLE_ENVELOPE and auditableRoute, plus the branch
// lib/admin/impersonation-session.ts's resolveImpersonationForOrg() makes
// getCurrentOrg() take on them).
// The two halves describe ONE rule, and the failure modes of their
// disagreement are not symmetric but are both bad:
//
//   TYPESCRIPT SAYS MORE THAN SQL   the UI renders a workspace and a banner
//                                   claiming an hour of access the database
//                                   will not grant -- every list empty, every
//                                   page half-broken, and a support engineer
//                                   who believes they are inside a tenant when
//                                   they are not. A spoofable UI.
//   SQL SAYS MORE THAN TYPESCRIPT   the grant exists and nothing renders it.
//                                   Harmless-looking, and the reason it is
//                                   still a defect: an active, audited,
//                                   consented session that the operator cannot
//                                   use is a customer's consent spent for
//                                   nothing.
//
// The repo's answer to that class of problem is the `*-matches-db.test.ts`
// pattern (crm-write-access, past-due-grace, network-access, field-vocabulary,
// record-scope), and the pattern's rule is the load-bearing part: THE
// EXPECTATION IS READ OUT OF A REAL POSTGRES, never restated as a second
// literal in this file. A test that compared 60 to a hardcoded 60 would stay
// green the day somebody changed private.impersonation_time_box() and forgot
// the constant, which is the entire drift it exists to catch.
//
// LOCAL ONLY, same discipline as every other file in tests/integration:
// getLocalSupabaseStatus() refuses anything that is not the loopback stack.
// Nothing here plants a fixture or writes a row -- every query reads the
// catalog or reference data -- so there is no rollback to do.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "./support/env";
import {
  IMPERSONATION_ROLE_ENVELOPE,
  IMPERSONATION_TIME_BOX_MINUTES,
  auditableRoute,
} from "@/lib/admin/impersonation-contract";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await pool.query<{ v: string }>(sql, params);
  expect(rows.length, `query returned exactly one row: ${sql}`).toBe(1);
  return String(rows[0]!.v);
}

describe("the time-box is one number, and the database owns it", () => {
  it("IMPERSONATION_TIME_BOX_MINUTES equals private.impersonation_time_box()", async () => {
    // Read as SECONDS and divided here, rather than asking Postgres for
    // minutes: `extract(epoch from ...)` is exact for any interval, whereas a
    // `date_part('minute', ...)` would silently report 0 for an interval
    // expressed as '1 hour' -- a green test for a disagreeing pair.
    const seconds = Number(
      await scalar(
        "select extract(epoch from private.impersonation_time_box())::bigint as v",
      ),
    );
    expect(seconds % 60, "the time-box is a whole number of minutes").toBe(0);
    expect(
      seconds / 60,
      "lib/admin/impersonation-contract.ts's IMPERSONATION_TIME_BOX_MINUTES must equal what public.start_impersonation_session() actually stamps onto expires_at",
    ).toBe(IMPERSONATION_TIME_BOX_MINUTES);
  });

  it("the start RPC stamps expires_at from that function, not from a literal", async () => {
    // The constant agreeing with the helper is worth nothing if the RPC that
    // writes expires_at ignores the helper. Read the deployed body.
    const body = await scalar(
      `select pg_get_functiondef(p.oid) as v
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'start_impersonation_session'`,
    );
    expect(
      body,
      "start_impersonation_session must derive expires_at from private.impersonation_time_box()",
    ).toContain("private.impersonation_time_box()");
    // And must not have grown a second, competing number.
    expect(
      body.match(/interval\s+'/gi) ?? [],
      "a literal interval in the start RPC would be a second time-box the constant above cannot see",
    ).toHaveLength(0);
  });
});

describe("the read-only envelope is the read_only role's own key set", () => {
  it("IMPERSONATION_ROLE_ENVELOPE names a role that really exists", async () => {
    const count = await scalar(
      "select count(*)::text as v from public.roles where key = $1",
      [IMPERSONATION_ROLE_ENVELOPE],
    );
    expect(count, `public.roles has a '${IMPERSONATION_ROLE_ENVELOPE}' row`).toBe(
      "1",
    );
  });

  it("the grant function resolves its keys from that role, not from a hardcoded list", async () => {
    const body = await scalar(
      `select pg_get_functiondef(p.oid) as v
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'impersonated_organisations'`,
    );
    expect(body).toContain("public.role_permissions");
    expect(
      body,
      "the envelope must be read out of role_permissions for the role the app names",
    ).toContain(`'${IMPERSONATION_ROLE_ENVELOPE}'`);
    // NO PERMISSION KEY MAY APPEAR AS A LITERAL IN THIS BODY. A key written
    // here is a key the catalogue does not govern -- the same argument
    // 20260828210000's header makes for putting survives_suspension in a table
    // instead of a string literal. `view_crm` in particular would be the
    // tempting one to add, and would silently pin the envelope at one key the
    // day a second read key is introduced.
    for (const key of ["view_crm", "view_network", "manage_"]) {
      expect(
        body.includes(`'${key}'`),
        `private.impersonated_organisations must not name the permission key '${key}' as a literal -- the envelope is whatever role_permissions grants ${IMPERSONATION_ROLE_ENVELOPE}`,
      ).toBe(false);
    }
  });

  // =========================================================================
  // THE ENVELOPE GUARD IS AN ALLOWLIST, NOT A DENYLIST -- FIX ROUND 1,
  // IMPORTANT 3
  // =========================================================================
  // It shipped as a prefix DENYLIST: reject any key matching
  // ^(manage_|merge_|delete_|create_). That guards the four names that
  // happened to exist, and a denylist over a namespace nobody controls is a
  // guard that fails open by construction -- `export_contacts`,
  // `publish_profile`, `send_invite`, `link_records` would all ride into the
  // product's most dangerous grant silently. It is not hypothetical: the fix
  // THIS TASK ITSELF QUEUES for Q98 is a new key named
  // `accept_support_access`, which the denylist would have waved straight
  // through into the impersonation envelope.
  //
  // Flipped to the positive claim the feature actually rests on: the
  // impersonation envelope is READS, so every key granted to the envelope
  // role must be a `view_` key. A key named anything else is either a write
  // (a real widening) or a naming convention change (which deserves a human
  // reading this test, not a silent pass).
  it("every key in the envelope is a `view_` key -- the guard is an allowlist, not a denylist", async () => {
    const keys = (
      await scalar(
        `select coalesce(string_agg(permission_key, ',' order by permission_key), '<none>') as v
           from public.role_permissions where role_key = $1`,
        [IMPERSONATION_ROLE_ENVELOPE],
      )
    ).split(",");

    for (const key of keys) {
      expect(
        /^view_/.test(key),
        `'${key}' is granted to ${IMPERSONATION_ROLE_ENVELOPE}, so an impersonating superuser holds it -- and it is not a \`view_\` key. Either it permits something other than reading (a widening of the product's most dangerous grant, arriving in a migration whose diff need never mention impersonation), or the read-key naming convention has changed and this assertion needs a human. Current envelope: ${keys.join(", ")}`,
      ).toBe(true);
    }
  });

  it("...and the envelope is exactly the set expected today, so any change is a red test", async () => {
    // THE SECOND HALF THE ALLOWLIST STILL DOES NOT COVER. `^view_` would
    // admit a future `view_finance` or `view_audit_log` without comment --
    // both are reads, so the shape assertion above passes, and both would be
    // a real widening of what support can see (finance is the obvious one:
    // Q96 scoped impersonation to what a Read Only member sees, and a Read
    // Only member sees no money). Pinning the exact set makes ANY change to
    // the envelope -- widening or narrowing, write key or read key -- a red
    // test that a human has to re-read and re-record, which is the same
    // discipline rls_phase2_crm.sql § M1d/§ M1g apply to the suspension
    // catalogue.
    const keys = await scalar(
      `select coalesce(string_agg(permission_key, ',' order by permission_key), '<none>') as v
         from public.role_permissions where role_key = $1`,
      [IMPERSONATION_ROLE_ENVELOPE],
    );
    expect(
      keys,
      "the impersonation envelope changed. This is not a test to update casually: whatever was added or removed changes what a platform superuser can see inside a customer's workspace. Re-read DECISIONS-QUEUE Q96, confirm the change is intended, then re-record it here.",
    ).toBe("view_crm,view_network");
  });

  it("the envelope is not empty (an empty set grants nothing and the feature is dead)", async () => {
    const count = await scalar(
      `select count(*)::text as v from public.role_permissions where role_key = $1`,
      [IMPERSONATION_ROLE_ENVELOPE],
    );
    expect(Number(count)).toBeGreaterThan(0);
  });
});

describe("all three permission consumers carry the impersonation branch", () => {
  // THE HALF OF THE BINDING THE APP CANNOT SEE. lib/auth's hasPermission()
  // calls public.has_permission, and every list policy calls
  // private.permitted_organisations / private.full_scope_organisations. If the
  // disjunct is in one and not the others, getCurrentOrg() resolves the
  // workspace and every page in it renders empty -- the "TypeScript says more
  // than SQL" failure at the top of this file, arriving through SQL that
  // disagrees with itself.
  const consumers: readonly [string, string][] = [
    ["public", "has_permission"],
    ["private", "permitted_organisations"],
    ["private", "full_scope_organisations"],
  ];

  it.each(consumers)("%s.%s delegates to private.impersonated_organisations", async (
    schema,
    name,
  ) => {
    const body = await scalar(
      `select pg_get_functiondef(p.oid) as v
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = $2`,
      [schema, name],
    );
    expect(
      body,
      `${schema}.${name} must reach the grant through the single shared helper rather than restating its conditions`,
    ).toContain("private.impersonated_organisations");
  });
});

describe("the table's shape matches what the app reads back", () => {
  // lib/admin/impersonation-list.ts selects these columns by name and
  // lib/admin/impersonation-session.ts filters on three of them. A rename in a
  // later migration is a runtime error in a Server Component -- which is a
  // blank page, not a type error, because PostgREST answers with an error
  // object rather than throwing.
  const columns = [
    "id",
    "superuser_user_id",
    "target_organisation_id",
    "reason",
    "status",
    "requested_at",
    "admin_accepted_by",
    "accepted_at",
    "declined_by",
    "declined_at",
    "started_at",
    "expires_at",
    "ended_at",
  ];

  it.each(columns)("public.impersonation_sessions.%s exists", async (column) => {
    const count = await scalar(
      `select count(*)::text as v from information_schema.columns
        where table_schema = 'public' and table_name = 'impersonation_sessions'
          and column_name = $1`,
      [column],
    );
    expect(count).toBe("1");
  });

  it("the status vocabulary the UI renders is exactly the one the CHECK allows", async () => {
    // components/admin/impersonation-status-chip.tsx has a label and a tone
    // for six statuses. A seventh in the database would render `undefined` in
    // a chip; a status the database rejects would be dead code in the chip.
    const def = await scalar(
      `select pg_get_constraintdef(oid) as v from pg_constraint
        where connamespace = 'public'::regnamespace
          and conname = 'impersonation_sessions_status_vocabulary'`,
    );
    for (const status of [
      "requested",
      "accepted",
      "declined",
      "active",
      "ended",
      "expired",
    ]) {
      expect(def, `the CHECK admits '${status}'`).toContain(`'${status}'`);
    }
    // And nothing else: count the quoted literals in the constraint body.
    expect(
      (def.match(/'[a-z_]+'/g) ?? []).length,
      `the status CHECK admits exactly six values; a seventh has no chip in components/admin/impersonation-status-chip.tsx. Deployed: ${def}`,
    ).toBe(6);
  });

  it("there is NO client write policy on the table -- every transition is an RPC", async () => {
    // The whole design rests on this. A single INSERT/UPDATE policy would let
    // the superuser self-grant, and would do it without the audit write the
    // RPCs perform in the same transaction.
    const writes = await scalar(
      `select coalesce(string_agg(policyname || ':' || cmd, ',' order by policyname), '<none>') as v
         from pg_policies
        where schemaname = 'public' and tablename = 'impersonation_sessions'
          and cmd <> 'SELECT'`,
    );
    expect(
      writes,
      "a write policy on impersonation_sessions would be a path to a session row that bypassed the audit write and the consent check",
    ).toBe("<none>");
  });

  it("authenticated holds SELECT on the table and nothing more", async () => {
    const privs = await scalar(
      `select coalesce(string_agg(privilege_type, ',' order by privilege_type), '<none>') as v
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'impersonation_sessions'
          and grantee = 'authenticated'`,
    );
    expect(privs).toBe("SELECT");
  });
});

describe("auditableRoute strips what the audit contract forbids", () => {
  // Not a database binding -- a pure function -- but it belongs beside them:
  // it is the one place the app decides what reaches
  // public.audit_impersonated_page_view(), whose own contract is "route only,
  // no content". A query string carries `q=` search terms, which are content.
  it("keeps the path", () => {
    expect(auditableRoute("/acme/contacts")).toBe("/acme/contacts");
  });

  it("keeps a record id in a path segment -- knowing WHICH record was opened is the point", () => {
    expect(auditableRoute("/acme/contacts/9f1c8b2e-0000-0000-0000-000000000001")).toBe(
      "/acme/contacts/9f1c8b2e-0000-0000-0000-000000000001",
    );
  });

  it("DROPS the query string, where a search term would be", () => {
    expect(auditableRoute("/acme/contacts?q=jane%20doe&sort=name")).toBe(
      "/acme/contacts",
    );
  });

  it("drops a query string even when it is the only thing after the slash", () => {
    expect(auditableRoute("/?q=secret")).toBe("/");
  });

  it("survives a path with no query string and no leading segment", () => {
    expect(auditableRoute("/")).toBe("/");
  });
});
