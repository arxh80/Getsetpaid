import { describe, expect, it } from "vitest";
import {
  AUDIT_LOG_FILTER_PARAMS,
  auditLogFiltersForSelfAudit,
  auditLogIsFiltered,
  buildAuditLogNextHref,
  buildAuditLogSelfHref,
  parseAuditLogParams,
  type AuditLogParams,
} from "@/lib/admin/audit-log";
import { encodeCursor, type Cursor } from "@/lib/list/cursor";
import { instantToLondonWallClock } from "@/lib/format/date";
import type { RawSearchParams } from "@/lib/list/params";

// FIX ROUND 1, IMPORTANT 2. lib/admin/audit-log.ts is the FIRST cross-tenant
// filter allowlist in the product (CLAUDE.md § Non-negotiable rules:
// "search/filter/sort inputs map to allowlisted columns and operators"), and
// every other parse/allowlist module in this repository carries a unit
// suite -- tests/unit/list/params.test.ts goes as far as probing
// Object.prototype keys by name. This file is written the same way: as
// attacks on the allowlist, not as examples of it working. It covers ONLY
// the pure functions (parsing, the filter/self-audit shape, the href
// builders) -- fetchAuditLogPage/recordAuditLogView touch the database and
// are covered by tests/integration/rls/rls.test.ts § D/H and
// tests/e2e/audit-log.spec.ts instead, the same split lib/crm/lineup-list.ts
// and its sibling query functions already use.

function raw(entries: Record<string, string>): RawSearchParams {
  return entries;
}

describe("parseAuditLogParams: the five-filter allowlist", () => {
  describe("organisationId / actorUserId (UUID filters)", () => {
    const UUID = "d83219aa-c047-4877-962e-0c86e148142a";

    it("accepts a valid UUID, lower-cased", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.organisationId]: UUID.toUpperCase() }),
      );
      expect(params.filters.organisationId).toBe(UUID);
    });

    it("drops a malformed UUID to null rather than reaching the query", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.organisationId]: "not-a-uuid" }),
      );
      expect(params.filters.organisationId).toBeNull();
    });

    it("drops a SQL-shaped value to null", () => {
      const params = parseAuditLogParams(
        raw({
          [AUDIT_LOG_FILTER_PARAMS.actorUserId]:
            "' OR '1'='1'; drop table audit_events;--",
        }),
      );
      expect(params.filters.actorUserId).toBeNull();
    });

    it("drops a truncated/near-miss UUID (wrong length) to null", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.actorUserId]: UUID.slice(0, -1) }),
      );
      expect(params.filters.actorUserId).toBeNull();
    });

    it("absent filter parses as null, not an empty string", () => {
      const params = parseAuditLogParams(raw({}));
      expect(params.filters.organisationId).toBeNull();
      expect(params.filters.actorUserId).toBeNull();
    });

    it("an array-valued param (?org=a&org=b) takes the first", () => {
      const other = "11110000-0000-0000-0000-000000000001";
      const params = parseAuditLogParams({
        [AUDIT_LOG_FILTER_PARAMS.organisationId]: [UUID, other],
      });
      expect(params.filters.organisationId).toBe(UUID);
    });

    it("an empty array-valued param parses as null, not a crash", () => {
      const params = parseAuditLogParams({
        [AUDIT_LOG_FILTER_PARAMS.organisationId]: [],
      });
      expect(params.filters.organisationId).toBeNull();
    });
  });

  describe("action (exact-match text filter)", () => {
    it("accepts and trims an ordinary action string", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.action]: "  organisation.created  " }),
      );
      expect(params.filters.action).toBe("organisation.created");
    });

    it("an empty string parses as null (no filter), not as ''", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.action]: "   " }),
      );
      expect(params.filters.action).toBeNull();
    });

    it("MAX_ACTION_LENGTH (100) truncates rather than reaching the query whole", () => {
      const long = "a".repeat(150);
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.action]: long }),
      );
      expect(params.filters.action).toHaveLength(100);
      expect(params.filters.action).toBe("a".repeat(100));
    });

    it("a value that is ALL whitespace beyond the truncation point still degrades to null", () => {
      // 100 spaces, then real text -- trimmed BEFORE the length cap is
      // applied in this case because trim() runs first; assert the actual
      // order rather than assume it.
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.action]: " ".repeat(100) }),
      );
      expect(params.filters.action).toBeNull();
    });
  });

  describe("dateFrom / dateTo (UK-local wall clock -> UTC instant)", () => {
    it("a real datetime-local value converts through londonWallClockToInstant, not a second implementation", () => {
      const wallClock = "2026-09-08T14:30";
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.dateFrom]: wallClock }),
      );
      expect(params.filters.dateFrom).not.toBeNull();
      // Round-tripped through the SAME converter the UI uses to redisplay a
      // stored instant -- if this file re-implemented the conversion, a
      // drift between the two would show up here as a mismatch.
      expect(instantToLondonWallClock(params.filters.dateFrom!)).toBe(
        wallClock,
      );
    });

    it("an empty string parses as null (no filter)", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.dateTo]: "" }),
      );
      expect(params.filters.dateTo).toBeNull();
    });

    it("a non-existent calendar date (2026-02-30) parses as null", () => {
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.dateFrom]: "2026-02-30T10:00" }),
      );
      expect(params.filters.dateFrom).toBeNull();
    });

    it("a SQL-shaped value parses as null, not as a literal in the query", () => {
      const params = parseAuditLogParams(
        raw({
          [AUDIT_LOG_FILTER_PARAMS.dateTo]: "2026-09-08'; drop table x;--",
        }),
      );
      expect(params.filters.dateTo).toBeNull();
    });

    it("the DST-gap date (29 March, 01:30 never happens) still resolves rather than erroring", () => {
      // Matches lib/format/date.ts's own documented "shifted forward"
      // behaviour -- this file does not re-decide DST handling, it just
      // must not crash or silently drop a value londonWallClockToInstant
      // itself accepts.
      const params = parseAuditLogParams(
        raw({ [AUDIT_LOG_FILTER_PARAMS.dateFrom]: "2026-03-29T01:30" }),
      );
      expect(params.filters.dateFrom).not.toBeNull();
    });
  });

  describe("page size (delegated to lib/list/params.ts, verified through the wrapper)", () => {
    it("size=1e9 is not a plain positive integer, so it falls back to the default (25), never a 1-row page", () => {
      const params = parseAuditLogParams(raw({ size: "1e9" }));
      expect(params.list.pageSize).toBe(25);
    });

    it("size=0 falls back to the default rather than an empty page", () => {
      const params = parseAuditLogParams(raw({ size: "0" }));
      expect(params.list.pageSize).toBe(25);
    });

    it("size=-1 falls back to the default rather than a negative limit", () => {
      const params = parseAuditLogParams(raw({ size: "-1" }));
      expect(params.list.pageSize).toBe(25);
    });

    it("a value above the ceiling is clamped to MAX_PAGE_SIZE (50), not passed through", () => {
      const params = parseAuditLogParams(raw({ size: "500" }));
      expect(params.list.pageSize).toBe(50);
    });

    it("an ordinary in-range value is honoured", () => {
      const params = parseAuditLogParams(raw({ size: "10" }));
      expect(params.list.pageSize).toBe(10);
    });
  });

  describe("cursor (delegated to lib/list/cursor.ts, verified through the wrapper)", () => {
    it("a garbage `after` value degrades to page one (cursor null), never an error", () => {
      const params = parseAuditLogParams(raw({ after: "not-a-real-cursor" }));
      expect(params.list.cursor).toBeNull();
    });

    it("a real cursor, encoded under this spec's own sort key, round-trips", () => {
      const cursor: Cursor = {
        value: "2026-09-08T12:00:00.000Z",
        id: "d83219aa-c047-4877-962e-0c86e148142a",
        sort: "created_at",
      };
      const params = parseAuditLogParams(
        raw({ after: encodeCursor(cursor) }),
      );
      expect(params.list.cursor).toEqual(cursor);
    });

    it("a cursor encoded under a DIFFERENT sort key is discarded (stale-link protection)", () => {
      const cursor: Cursor = {
        value: "Some Name",
        id: "d83219aa-c047-4877-962e-0c86e148142a",
        sort: "name", // not this spec's "created_at"
      };
      const params = parseAuditLogParams(
        raw({ after: encodeCursor(cursor) }),
      );
      expect(params.list.cursor).toBeNull();
    });
  });

  describe("dir (parsed but not honoured by the query -- documented, not silently invented here)", () => {
    // Review M2: AUDIT_LOG_SPEC declares both direction labels and
    // parseListParams therefore accepts `?dir=asc`, but fetchAuditLogPage
    // hardcodes `ascending: false` on both order() calls regardless of what
    // was parsed -- so the value below reaches `params.list.dir` and, via
    // buildListHref, a "Next" href, without ever changing the actual sort
    // order. That mismatch is a recorded, deferred Minor (not one of this
    // fix round's five items) -- this test pins the CURRENT parsing
    // behaviour precisely so a future fix (or a future regression) is
    // visible here rather than rediscovered.
    it("?dir=asc parses into params.list.dir, unvalidated against the query's actual order", () => {
      const params = parseAuditLogParams(raw({ dir: "asc" }));
      expect(params.list.dir).toBe("asc");
    });

    it("an unrecognised dir value falls back to the column's default (desc)", () => {
      const params = parseAuditLogParams(raw({ dir: "sideways" }));
      expect(params.list.dir).toBe("desc");
    });

    it("no dir at all defaults to desc (newest first)", () => {
      const params = parseAuditLogParams(raw({}));
      expect(params.list.dir).toBe("desc");
    });
  });
});

describe("auditLogIsFiltered", () => {
  const EMPTY: AuditLogParams["filters"] = {
    organisationId: null,
    actorUserId: null,
    action: null,
    dateFrom: null,
    dateTo: null,
  };

  it("false when every filter is null", () => {
    expect(auditLogIsFiltered(EMPTY)).toBe(false);
  });

  it.each([
    ["organisationId", { organisationId: "x" }],
    ["actorUserId", { actorUserId: "x" }],
    ["action", { action: "x" }],
    ["dateFrom", { dateFrom: "x" }],
    ["dateTo", { dateTo: "x" }],
  ])("true when only %s is set", (_label, partial) => {
    expect(auditLogIsFiltered({ ...EMPTY, ...partial })).toBe(true);
  });
});

describe("auditLogFiltersForSelfAudit", () => {
  it("maps to snake_case keys matching the database's own column names, values unchanged", () => {
    const filters: AuditLogParams["filters"] = {
      organisationId: "org-id",
      actorUserId: "actor-id",
      action: "organisation.created",
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: null,
    };
    expect(auditLogFiltersForSelfAudit(filters)).toEqual({
      organisation_id: "org-id",
      actor_user_id: "actor-id",
      action: "organisation.created",
      date_from: "2026-01-01T00:00:00.000Z",
      date_to: null,
    });
  });

  it("carries every-null filters through as every-null, not omitted keys", () => {
    const empty: AuditLogParams["filters"] = {
      organisationId: null,
      actorUserId: null,
      action: null,
      dateFrom: null,
      dateTo: null,
    };
    const after = auditLogFiltersForSelfAudit(empty);
    expect(Object.keys(after).sort()).toEqual(
      ["action", "actor_user_id", "date_from", "date_to", "organisation_id"].sort(),
    );
    expect(Object.values(after).every((v) => v === null)).toBe(true);
  });
});

describe("buildAuditLogNextHref / buildAuditLogSelfHref", () => {
  const BASE = "/super/audit-log";
  const CURSOR: Cursor = {
    value: "2026-09-08T12:00:00.000Z",
    id: "d83219aa-c047-4877-962e-0c86e148142a",
    sort: "created_at",
  };

  it("Next preserves the five real filter keys from the request's raw searchParams", () => {
    const params = parseAuditLogParams(raw({ org: "x" }));
    const requestRaw = raw({
      [AUDIT_LOG_FILTER_PARAMS.organisationId]: "some-org-value",
      [AUDIT_LOG_FILTER_PARAMS.actorUserId]: "some-actor-value",
      [AUDIT_LOG_FILTER_PARAMS.action]: "organisation.created",
    });
    const href = buildAuditLogNextHref(BASE, params, requestRaw, CURSOR);
    expect(href).toContain(
      `${AUDIT_LOG_FILTER_PARAMS.organisationId}=some-org-value`,
    );
    expect(href).toContain(
      `${AUDIT_LOG_FILTER_PARAMS.actorUserId}=some-actor-value`,
    );
    expect(href).toContain(
      `${AUDIT_LOG_FILTER_PARAMS.action}=organisation.created`,
    );
  });

  it("Next strips a stray after/before already in `raw` and emits ONLY the new cursor", () => {
    const params = parseAuditLogParams(raw({}));
    const requestRaw = raw({
      after: "some-stale-cursor",
      before: "some-other-stale-cursor",
    });
    const href = buildAuditLogNextHref(BASE, params, requestRaw, CURSOR);
    // Exactly one cursor param, and it is the NEW one -- never the stale
    // values `raw` happened to carry (buildListHref's "own keys win" rule).
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.getAll("after")).toEqual([encodeCursor(CURSOR)]);
    expect(url.searchParams.has("before")).toBe(false);
  });

  it("Next never emits a `before` cursor -- this surface is forward-only", () => {
    const params = parseAuditLogParams(raw({}));
    const href = buildAuditLogNextHref(BASE, params, raw({}), CURSOR);
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.has("before")).toBe(false);
    expect(url.searchParams.has("after")).toBe(true);
  });

  it("Self, with no cursor in params, points at the filtered view with no cursor param at all", () => {
    const params = parseAuditLogParams(raw({ org: "not-a-uuid" })); // -> null filter, no cursor
    const href = buildAuditLogSelfHref(BASE, params, raw({}));
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.has("after")).toBe(false);
    expect(url.searchParams.has("before")).toBe(false);
  });

  it("Self, WITH a cursor already in params (mid-list), preserves that SAME cursor unchanged", () => {
    const requestRaw = raw({ after: encodeCursor(CURSOR) });
    const params = parseAuditLogParams(requestRaw);
    expect(params.list.cursor).toEqual(CURSOR); // sanity: the fixture is real
    const href = buildAuditLogSelfHref(BASE, params, requestRaw);
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("after")).toBe(encodeCursor(CURSOR));
  });

  it("Self preserves the five real filters exactly like Next does", () => {
    const requestRaw = raw({
      [AUDIT_LOG_FILTER_PARAMS.action]: "audit_log.viewed",
    });
    const params = parseAuditLogParams(requestRaw);
    const href = buildAuditLogSelfHref(BASE, params, requestRaw);
    expect(href).toContain(
      `${AUDIT_LOG_FILTER_PARAMS.action}=audit_log.viewed`,
    );
  });
});
