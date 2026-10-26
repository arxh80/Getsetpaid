import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appSourceFiles, relPath } from "../support/app-source";
import { unboundedReads } from "./unbounded-read-detector";

// ===========================================================================
// PHASE 10 TASK 13 (G7) -- EVERY UNBOUNDED TABLE READ IS NAMED, WITH WHY
// ===========================================================================
// "Paginate everything" is enforced at the list chokepoint (lib/list/query.ts)
// but a `.from(...).select(...)` anywhere else can read a whole table, and past
// `[api] max_rows = 1000` PostgREST then truncates it without an error. This
// walks every app source file with the TypeScript parser (unbounded-read-
// detector.ts). A read is bounded when its chain, or a later chain on the
// variable it is stored in within the same function, calls `.limit` /
// `.range` / `.single` / `.maybeSingle`, filters `.eq("id", …)`, or selects
// `{ head: true }`. `.from(variable)` is read like any other. Everything else
// must be in ALLOWED, keyed `file function from(arg)`, with the reason.
//
// Task 1 read the regex census's 32 candidates and the 15 `.from(variable)`
// sites by hand (.superpowers/sdd/2026-10-16-launch-hardening/task-1-report.md);
// the reasons below are those dispositions. The parser clears the twelve that
// the regex got wrong (a `;` inside a comment, `.maybeSingle<T>(`, a pager's
// `.limit` in a later statement).
//
// shortcut: one key per (file, function, from-argument), so a SECOND unbounded
// read of the same table in the same function is hidden by the first one's
// entry; key on the line too if that ever matters more than churn.

const ALLOWED: Record<string, string> = {
  // --- G5 (Task 14 bounds these and removes them) ---
  'lib/crm/custom-field-queries.ts loadCustomFieldDefinitions from("custom_field_definitions")': "G5: every definition of one entity type; Pro is unlimited",
  'lib/crm/custom-field-queries.ts loadCustomFieldCounts from("custom_field_definitions")': "G5: every live definition, read only to count it",
  'lib/crm/custom-field-queries.ts loadCustomFieldPanel from("custom_field_values")': "G5: one entity's values, times the definition count",
  'lib/crm/custom-field-queries.ts loadCustomFieldCellsForEntities from("custom_field_values")': "G5: a page of entities' values, times the definition count",
  'lib/crm/dedup.ts loadRecordPair from("custom_field_values")': "G5: two entities' values, times the definition count",
  'lib/crm/dedup.ts loadRecordPair from("custom_field_definitions")': "G5: every live definition of one entity type",
  // --- G6 (Task 14 bounds these and removes them) ---
  'lib/network/entities.ts loadPublishedEntityIds from("network_profiles")': "G6: every live profile of one kind in the org",
  'lib/network/entities.ts loadOwnPublishedProfiles from("network_profiles")': "G6: every published profile of the org (Send from)",
  // --- the caller's own memberships ---
  'lib/auth/index.ts getMemberships from("organisation_memberships")': "the signed-in user's own memberships; bounded per person, index-backed",
  'lib/auth/mfa-gate.ts callerHasPrivilegedRole from("organisation_memberships")': "the signed-in user's own active memberships",
  // --- .in("id", …) over one bounded page's ids ---
  'lib/admin/health.ts fetchIncidentAlertPage from("organisations")': "names for one page of incident alerts",
  'lib/admin/overrides-list.ts organisationNames from("organisations")': "names for a list capped at OVERRIDE_LIST_LIMIT (50)",
  'lib/feedback/list.ts fetchFeedbackPage from("organisations")': "names for one page of feedback",
  'lib/crm/queries.ts loadVenueNames from("venues")': "one page's venue ids (at most MAX_PAGE_SIZE 50)",
  'lib/crm/queries.ts loadLineupForEvent from("artists")': "the removed lineup rows (limit 100) plus one page",
  'lib/crm/queries.ts loadUploaderNames from("profiles")': "one page's uploader ids",
  "lib/crm/queries.ts loadLinksFor from(TABLE_FOR_ENTITY[type])": "names for one capped panel of links",
  "lib/crm/queries.ts loadDocumentLinks from(TABLE_FOR_ENTITY[type])": "names for one document's capped links",
  "lib/crm/finance-queries.ts resolveNames from(table)": "names for one event's finance lines",
  "lib/crm/dedup.ts loadRecordPair from(table)": "exactly two ids, the merge pair",
  'lib/network/discovery.ts loadNetworkProfileSummaries from("network_connected_profiles")': "one page's profile ids",
  'lib/network/discovery.ts loadNetworkProfileSummaries from("network_directory")': "one page's profile ids, the second half of the lookup",
  'app/(app)/[orgSlug]/members/page.tsx listMembers from("profiles")': "at most 200 member ids (the membership read's flat cap, G8)",
  // --- the list chokepoint itself: bounded through wrapper helpers ---
  "lib/list/query.ts buildPage from(table)": "the chokepoint's page: .limit(pageSize + 1) on the wrapped query",
  "lib/list/query.ts fetchListPage from(table)": "the two edge probes: applyCursor(...).limit(1)",
};

describe("every unbounded table read is named (G7)", () => {
  const reads = appSourceFiles().flatMap((full) => unboundedReads(relPath(full), readFileSync(full, "utf8")));
  const keys = [...new Set(reads.map((r) => r.key))].sort();

  it("no unbounded read lands without an entry", () => {
    const extra = reads.filter((r) => !(r.key in ALLOWED)).map((r) => `${r.key} (line ${r.line})`);
    expect(
      extra,
      "an unbounded .from().select() read: past max_rows (1000) PostgREST truncates it silently. Bound it " +
        "with .limit()/.range(), or add it to ALLOWED with the reason it cannot grow.",
    ).toEqual([]);
  });

  it("and no entry is stale (non-vacuity: the census still sees every listed read)", () => {
    expect(Object.keys(ALLOWED).filter((k) => !keys.includes(k))).toEqual([]);
  });
});

describe("the unbounded-read detector", () => {
  const keysOf = (text: string) => unboundedReads("lib/x.ts", text).map((r) => r.key);

  it("catches a planted unbounded read, and a .from(variable) one", () => {
    expect(keysOf(`async function f() { return supabase.from("contacts").select("id"); }`)).toEqual([
      'lib/x.ts f from("contacts")',
    ]);
    expect(keysOf(`async function f(t) { return supabase.from(t).select("id").eq("organisation_id", o); }`)).toEqual([
      "lib/x.ts f from(t)",
    ]);
  });

  it("does not flag the bounded shapes the regex census got wrong", () => {
    const bounded = [
      `async function a() { return supabase.from("t").select("id").limit(10); }`,
      `async function b() { return supabase.from("t").select("id").maybeSingle<Row>(); }`,
      `async function c() { return supabase.from("t").select("id") // a comment; with a semicolon\n .limit(5); }`,
      `async function d() { let q = supabase.from("t").select("id"); if (x) q = q.eq("a", 1); return q.order("id").limit(51); }`,
      `async function e() { return supabase.from("t").select("id", { count: "exact", head: true }); }`,
      `async function g() { return supabase.from("t").select("id").eq("id", id); }`,
      `async function h() { return supabase.storage.from("documents").list("x"); }`,
    ];
    for (const text of bounded) expect(keysOf(text), text).toEqual([]);
  });
});
