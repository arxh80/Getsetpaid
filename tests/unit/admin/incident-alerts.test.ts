import { describe, expect, it } from "vitest";
import {
  INCIDENT_ALERT_FILTER_PARAMS,
  INCIDENT_ALERT_SPEC,
  buildIncidentAlertNextHref,
  buildIncidentAlertSelfHref,
  incidentAlertIsFiltered,
  parseIncidentAlertParams,
} from "@/lib/admin/health";
import type { Cursor } from "@/lib/list/cursor";
import type { RawSearchParams } from "@/lib/list/params";

// The incident-alert list's parse allowlist, written the way
// tests/unit/admin/audit-log.test.ts is written: as attacks on the allowlist
// rather than as examples of it working. It covers only the pure functions --
// `fetchIncidentAlertPage` talks to the database and is covered by
// tests/e2e/platform-health.spec.ts instead, the same split every other list
// module here uses.
//
// WHY IT ARRIVES WITH THE CLEANUP ROUND. Fix round 1's M5 turned a flat
// 50-row read into a keyset pager with two filters and shipped no unit suite
// for the parsing it added. This round adds two more axes to the same parser
// (the attribution filter, N2; the search the spec always declared, N3), so
// the file is written now and covers all four.

function raw(entries: Record<string, string>): RawSearchParams {
  return entries;
}

const CURSOR: Cursor = {
  value: "2026-09-09T10:00:00.000Z",
  id: "d83219aa-c047-4877-962e-0c86e148142a",
  sort: "created_at",
};

describe("parseIncidentAlertParams: the filter allowlist", () => {
  it("parses nothing as the three no-op defaults plus an empty search", () => {
    const params = parseIncidentAlertParams(raw({}));
    expect(params.filters.alertType).toBeNull();
    expect(params.filters.status).toBe("any");
    expect(params.filters.attribution).toBe("any");
    expect(params.list.q).toBe("");
  });

  describe("alertType", () => {
    it("accepts a known type", () => {
      const params = parseIncidentAlertParams(
        raw({ [INCIDENT_ALERT_FILTER_PARAMS.alertType]: "upload_quarantined" }),
      );
      expect(params.filters.alertType).toBe("upload_quarantined");
    });

    it("drops an unknown type to null rather than reaching the query", () => {
      const params = parseIncidentAlertParams(
        raw({ [INCIDENT_ALERT_FILTER_PARAMS.alertType]: "rate_limit" }),
      );
      expect(params.filters.alertType).toBeNull();
    });

    // `isIncidentAlertType` is a `value in LABELS` check, and every object in
    // JavaScript answers `"toString" in obj` with true. A prototype key
    // reaching `.eq("alert_type", …)` would be a filter nobody wrote.
    it("drops an Object.prototype key to null", () => {
      for (const key of ["toString", "constructor", "__proto__"]) {
        const params = parseIncidentAlertParams(
          raw({ [INCIDENT_ALERT_FILTER_PARAMS.alertType]: key }),
        );
        expect(params.filters.alertType, key).toBeNull();
      }
    });

    it("drops a SQL-shaped value to null", () => {
      const params = parseIncidentAlertParams(
        raw({
          [INCIDENT_ALERT_FILTER_PARAMS.alertType]:
            "' OR '1'='1'; drop table incident_alerts;--",
        }),
      );
      expect(params.filters.alertType).toBeNull();
    });
  });

  describe("status", () => {
    it("accepts the two narrowing values", () => {
      for (const value of ["open", "resolved"] as const) {
        const params = parseIncidentAlertParams(
          raw({ [INCIDENT_ALERT_FILTER_PARAMS.status]: value }),
        );
        expect(params.filters.status).toBe(value);
      }
    });

    // The default MUST be the value that hides nothing: a resolved alert is
    // still evidence, and a list whose default state hides rows is a list
    // that lies about how many exist (lib/list/spec.ts's own rule).
    it("degrades anything else to `any`, which filters nothing", () => {
      for (const value of ["", "OPEN", "closed", "null"]) {
        const params = parseIncidentAlertParams(
          raw({ [INCIDENT_ALERT_FILTER_PARAMS.status]: value }),
        );
        expect(params.filters.status, value).toBe("any");
      }
    });
  });

  describe("attribution (cleanup round, N2)", () => {
    it("accepts the two narrowing values", () => {
      for (const value of ["workspace", "unattributed"] as const) {
        const params = parseIncidentAlertParams(
          raw({ [INCIDENT_ALERT_FILTER_PARAMS.attribution]: value }),
        );
        expect(params.filters.attribution).toBe(value);
      }
    });

    it("degrades anything else to `any`, which filters nothing", () => {
      for (const value of ["", "null", "none", "organisation"]) {
        const params = parseIncidentAlertParams(
          raw({ [INCIDENT_ALERT_FILTER_PARAMS.attribution]: value }),
        );
        expect(params.filters.attribution, value).toBe("any");
      }
    });

    it("an array-valued param takes the first, and an empty one is `any`", () => {
      expect(
        parseIncidentAlertParams({
          [INCIDENT_ALERT_FILTER_PARAMS.attribution]: [
            "unattributed",
            "workspace",
          ],
        }).filters.attribution,
      ).toBe("unattributed");
      expect(
        parseIncidentAlertParams({
          [INCIDENT_ALERT_FILTER_PARAMS.attribution]: [],
        }).filters.attribution,
      ).toBe("any");
    });
  });

  describe("q (cleanup round, N3)", () => {
    it("reaches list.q, where fetchIncidentAlertPage now reads it", () => {
      const params = parseIncidentAlertParams(raw({ q: "network_discovery" }));
      expect(params.list.q).toBe("network_discovery");
    });

    it("the spec declares the column the query filters on", () => {
      expect(INCIDENT_ALERT_SPEC.searchColumn).toBe("summary");
    });
  });
});

describe("incidentAlertIsFiltered", () => {
  it("is false for the untouched list", () => {
    expect(incidentAlertIsFiltered(parseIncidentAlertParams(raw({})))).toBe(
      false,
    );
  });

  it("is true for each of the four axes on its own", () => {
    const cases: Record<string, string>[] = [
      { [INCIDENT_ALERT_FILTER_PARAMS.alertType]: "upload_quarantined" },
      { [INCIDENT_ALERT_FILTER_PARAMS.status]: "open" },
      { [INCIDENT_ALERT_FILTER_PARAMS.attribution]: "workspace" },
      { q: "quarantined" },
    ];
    for (const entries of cases) {
      expect(
        incidentAlertIsFiltered(parseIncidentAlertParams(raw(entries))),
        JSON.stringify(entries),
      ).toBe(true);
    }
  });

  // A value the allowlist rejected must not light up "Clear filters" -- the
  // link would claim a narrowing that is not in effect.
  it("is false when every supplied value was rejected", () => {
    expect(
      incidentAlertIsFiltered(
        parseIncidentAlertParams(
          raw({
            [INCIDENT_ALERT_FILTER_PARAMS.alertType]: "nonsense",
            [INCIDENT_ALERT_FILTER_PARAMS.status]: "nonsense",
            [INCIDENT_ALERT_FILTER_PARAMS.attribution]: "nonsense",
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe("the href builders carry the whole view", () => {
  const BASE = "/super/health";

  it("`Next` preserves all three filters and the search alongside the cursor", () => {
    const entries = {
      [INCIDENT_ALERT_FILTER_PARAMS.alertType]: "rate_limit_tripped",
      [INCIDENT_ALERT_FILTER_PARAMS.status]: "open",
      [INCIDENT_ALERT_FILTER_PARAMS.attribution]: "unattributed",
      q: "network_discovery",
    };
    const href = buildIncidentAlertNextHref(
      BASE,
      parseIncidentAlertParams(raw(entries)),
      raw(entries),
      CURSOR,
    );
    const query = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(query.get(INCIDENT_ALERT_FILTER_PARAMS.alertType)).toBe(
      "rate_limit_tripped",
    );
    expect(query.get(INCIDENT_ALERT_FILTER_PARAMS.status)).toBe("open");
    expect(query.get(INCIDENT_ALERT_FILTER_PARAMS.attribution)).toBe(
      "unattributed",
    );
    expect(query.get("q")).toBe("network_discovery");
    expect(query.get("after")).not.toBeNull();
  });

  // The disabled "Next" stays focusable and activatable, so activating it must
  // land on the page the reader is already on rather than an unfiltered page
  // one. It therefore must NOT carry a cursor of its own when there isn't one.
  it("the self href keeps the filters and adds no cursor", () => {
    const entries = {
      [INCIDENT_ALERT_FILTER_PARAMS.attribution]: "workspace",
    };
    const href = buildIncidentAlertSelfHref(
      BASE,
      parseIncidentAlertParams(raw(entries)),
      raw(entries),
    );
    const query = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(query.get(INCIDENT_ALERT_FILTER_PARAMS.attribution)).toBe(
      "workspace",
    );
    expect(query.get("after")).toBeNull();
  });
});
