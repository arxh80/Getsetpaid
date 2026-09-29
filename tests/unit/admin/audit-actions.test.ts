import { describe, expect, it } from "vitest";
import {
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

  it("covers exactly the eleven mutable Phase 2 tables -- merges is not one of them", () => {
    const targets = Object.keys(CRM_AUDIT_TARGETS);
    expect(targets).toHaveLength(11);
    expect(targets).not.toContain("merge");
    expect(Object.keys(CRM_AUDIT_TARGET_TABLE).sort()).toEqual(targets.sort());
  });

  it("is 9 soft-deletable x 4 + 2 non-soft-deletable x 2 = 40 names, no duplicates", () => {
    const actions = crmAuditActions();
    expect(actions).toHaveLength(40);
    expect(new Set(actions).size).toBe(40);
  });

  it("uses `soft_deleted`, never `deleted`, so it cannot collide with the two hard-DELETE actions", () => {
    expect(CRM_AUDIT_VERBS).not.toContain("deleted");
    for (const a of crmAuditActions()) expect(a.endsWith(".deleted")).toBe(false);
    expect(CRM_IRREVERSIBLE_AUDIT_ACTIONS).toContain("contact_company.deleted");
    expect(CRM_IRREVERSIBLE_AUDIT_ACTIONS).toContain("custom_field_value.deleted");
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
    expect(all.slice(0, 40)).toEqual([...crmAuditActions()]);
  });
});
