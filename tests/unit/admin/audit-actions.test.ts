import { describe, expect, it } from "vitest";
import {
  AUDIT_COVERAGE_EXCUSALS,
  CRM_AUDIT_TARGETS,
  CRM_AUDIT_TARGET_TABLE,
  CRM_AUDIT_VERBS,
  CRM_IRREVERSIBLE_AUDIT_ACTIONS,
  PLATFORM_AUDIT_ACTIONS,
  crmAuditActions,
  knownAuditActions,
} from "@/lib/admin/audit-actions";
import { parseAuditLogParams, AUDIT_LOG_FILTER_PARAMS } from "@/lib/admin/audit-log";

// PHASE 7 TASK 6b. The catalogue's SHAPE, pure. Its CONTENT against the live
// database (trigger arguments, deleted_at columns, every literal action any
// function passes to log_audit_event) is
// tests/integration/admin/audit-actions-match-db.test.ts -- the same
// unit/integration split lib/admin/audit-log.ts already uses.

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

describe("crmAuditActions: derived from the target list and the verb set", () => {
  it("emits four verbs for a soft-deletable target and two for one without deleted_at", () => {
    const actions = crmAuditActions();
    expect(actions).toEqual(expect.arrayContaining([
      "contact.created", "contact.updated", "contact.soft_deleted", "contact.restored",
      "contact_company.created", "contact_company.updated",
    ]));
    expect(actions).not.toContain("contact_company.soft_deleted");
    expect(actions).not.toContain("contact_company.restored");
    expect(actions).not.toContain("custom_field_value.soft_deleted");
    expect(actions).not.toContain("custom_field_value.restored");
  });

  // MOVED in Phase 8 Task 7: 11 -> 27 targets and 40 -> 100 names. The
  // eleven Phase 2 tables (Task 6b), the thirteen Phase 3-6 tables Q122
  // named, and three the derived coverage census found outside that list
  // (membership, subscription, merge_candidate). `organisations` is
  // deliberately NOT here -- see AUDIT_COVERAGE_EXCUSALS.
  it("covers exactly the twenty-seven tables that carry the generic pair -- merges and organisations are not among them", () => {
    const targets = Object.keys(CRM_AUDIT_TARGETS);
    expect(targets).toHaveLength(27);
    expect(targets).not.toContain("merge");
    expect(targets).not.toContain("organisation");
    expect(Object.keys(CRM_AUDIT_TARGET_TABLE).sort()).toEqual(targets.sort());
    expect(Object.keys(AUDIT_COVERAGE_EXCUSALS)).toContain("organisations");
    for (const table of Object.keys(AUDIT_COVERAGE_EXCUSALS)) {
      expect(Object.values(CRM_AUDIT_TARGET_TABLE), `${table} is excused AND a target`).not.toContain(table);
    }
  });

  it("is 23 soft-deletable x 4 + 4 non-soft-deletable x 2 = 100 names, no duplicates", () => {
    const actions = crmAuditActions();
    const soft = Object.values(CRM_AUDIT_TARGETS).filter((t) => t.softDeletable).length;
    expect(soft).toBe(23);
    expect(actions).toHaveLength(soft * 4 + (27 - soft) * 2);
    expect(actions).toHaveLength(100);
    expect(new Set(actions).size).toBe(100);
  });

  it("uses `soft_deleted`, never `deleted`, so it cannot collide with the two hard-DELETE actions", () => {
    expect(CRM_AUDIT_VERBS).not.toContain("deleted");
    for (const a of crmAuditActions()) expect(a.endsWith(".deleted")).toBe(false);
    expect(CRM_IRREVERSIBLE_AUDIT_ACTIONS).toContain("contact_company.deleted");
    expect(CRM_IRREVERSIBLE_AUDIT_ACTIONS).toContain("custom_field_value.deleted");
    expect(CRM_IRREVERSIBLE_AUDIT_ACTIONS).toContain("membership.deleted");
  });
});

describe("knownAuditActions: the whole catalogue", () => {
  it("contains every CRM, irreversible and platform action exactly once", () => {
    const all = knownAuditActions();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(
      crmAuditActions().length +
        CRM_IRREVERSIBLE_AUDIT_ACTIONS.length +
        PLATFORM_AUDIT_ACTIONS.length,
    );
  });

  it("every name is a dot-namespaced identifier the filter parser accepts unchanged", () => {
    for (const a of knownAuditActions()) {
      expect(a, a).toMatch(ACTION_RE);
      expect(a.length).toBeLessThanOrEqual(100);
      const parsed = parseAuditLogParams({ [AUDIT_LOG_FILTER_PARAMS.action]: a });
      expect(parsed.filters.action).toBe(a);
    }
  });

  it("lists the CRM writes first, because they are the bulk of the table", () => {
    const all = knownAuditActions();
    expect(all.slice(0, 100)).toEqual([...crmAuditActions()]);
  });
});
