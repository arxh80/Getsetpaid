import { describe, expect, it } from "vitest";
import { CRM_IRREVERSIBLE_AUDIT_ACTIONS, PLATFORM_AUDIT_ACTIONS } from "@/lib/admin/audit-actions";
import { latestFunctionDefinition } from "../support/sql-definitions";

// THE AUDIT ACTION CATALOGUE IS WRITTEN IN TWO LANGUAGES, AND THIS IS THE
// HALF OF THE BINDING THAT RUNS IN CI (Phase 8 Task 6 fix round 2, re-review
// finding m-N4).
//
// private.platform_audit_actions() (20261005001000) is the database's copy
// of the hand-listed half of lib/admin/audit-actions.ts -- the platform
// actions plus the four irreversible CRM ones. It exists so that the
// retention suite's "the purge exempts no action" is measured over the
// WHOLE catalogue rather than over what a regex could read out of function
// source: eleven catalogue names (the DSR transitions built from a status,
// the impersonation terminals built from a state, the dot-less document_*
// actions passed in from TypeScript) were outside that derivation, and a
// named exemption of any of them reddened nothing.
//
// Two lists that must be the same list drift unless something says so. This
// reads the function's LATEST body from the migrations (the
// sql-definitions.ts walk, so a later re-creation is the one read) and
// asserts equality in ORDER, not just as sets, so a name moved between
// sections is visible too. The live-database half --
// that body IS pg_proc.prosrc, and audit_action_catalogue() equals
// knownAuditActions() including the derived CRM half -- is
// tests/integration/admin/audit-actions-match-db.test.ts and
// tests/integration/legal/catalogue-bindings-match-db.test.ts.

describe("private.platform_audit_actions() is the hand-listed half of the catalogue", () => {
  const { body } = latestFunctionDefinition("private.platform_audit_actions");
  // Comments stripped, so a name mentioned in prose does not count.
  const code = body.replace(/--[^\n]*/g, "");

  it("every VALUES tuple is understood -- a row the pattern skipped would make the equality vacuous", () => {
    const tuples = (code.match(/\(/g) ?? []).length;
    const parsed = [...code.matchAll(/\('([A-Za-z0-9_.]+)'\)/g)].length;
    expect(parsed, "a tuple in the function body is not a bare quoted action name").toBe(tuples);
    expect(parsed).toBeGreaterThan(40);
  });

  it("equals CRM_IRREVERSIBLE_AUDIT_ACTIONS followed by PLATFORM_AUDIT_ACTIONS, in order, with no duplicates", () => {
    const names = [...code.matchAll(/\('([A-Za-z0-9_.]+)'\)/g)].map((m) => m[1]);
    expect(new Set(names).size, "a name is listed twice in the database copy").toBe(names.length);
    expect(names).toEqual([...CRM_IRREVERSIBLE_AUDIT_ACTIONS, ...PLATFORM_AUDIT_ACTIONS]);
  });

  it("carries the eleven names the retention suite's regex derivation could not see", () => {
    const names = new Set([...code.matchAll(/\('([A-Za-z0-9_.]+)'\)/g)].map((m) => m[1]));
    for (const name of [
      "data_subject_request.fulfilment_recorded",
      "data_subject_request.in_progress",
      "data_subject_request.rejected",
      "data_subject_request.routed",
      "data_subject_request.withdrawn",
      "document_deleted",
      "document_downloaded",
      "document_quarantined",
      "document_uploaded",
      "impersonation.ended",
      "impersonation.expired",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
