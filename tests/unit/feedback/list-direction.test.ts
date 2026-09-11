import { describe, expect, it } from "vitest";
import {
  FEEDBACK_SPEC,
  keysetClause,
  parseFeedbackParams,
} from "@/lib/feedback/list";

// FEEDBACK_SPEC advertises both directions and the URL accepts `?dir=asc`;
// Task 6 fix round 1 (finding M5) made the query honour it. What can be
// proved without a database is that the keyset predicate's operators FLIP
// WITH the direction -- the bound and the strict half together -- so the
// ORDER BY (which reads the same `dir`) and the predicate can never disagree,
// which is the one way a keyset pager repeats or skips a row.

const cursor = { value: "2026-09-11T10:00:00+00:00", id: "0000-id", sort: "created_at" as const };

describe("keysetClause", () => {
  it("desc (the default): at-or-before, then strictly-before with an id tie-break", () => {
    const clause = keysetClause("desc", cursor);
    expect(clause.bound).toBe("lte");
    expect(clause.or).toMatch(/^created_at\.lt\..+,and\(created_at\.eq\..+,id\.lt\.0000-id\)$/);
  });

  it("asc: at-or-after, then strictly-after with the SAME tie-break flipped", () => {
    const clause = keysetClause("asc", cursor);
    expect(clause.bound).toBe("gte");
    expect(clause.or).toMatch(/^created_at\.gt\..+,and\(created_at\.eq\..+,id\.gt\.0000-id\)$/);
    expect(clause.or).not.toContain(".lt.");
  });
});

describe("the URL's direction reaches the query", () => {
  it("defaults to desc and accepts asc", () => {
    expect(FEEDBACK_SPEC.sort.created_at.defaultDirection).toBe("desc");
    expect(parseFeedbackParams({}).list.dir).toBe("desc");
    expect(parseFeedbackParams({ dir: "asc" }).list.dir).toBe("asc");
  });

  it("an unknown direction falls back to the default rather than throwing", () => {
    expect(parseFeedbackParams({ dir: "sideways" }).list.dir).toBe("desc");
  });
});
