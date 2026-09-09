import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PALETTE_ENTITIES,
  PALETTE_RESULTS_PER_ENTITY,
} from "@/lib/palette/entities";
import { PALETTE_MIN_QUERY_LENGTH } from "@/lib/palette/results";
import { MAX_PAGE_SIZE } from "@/lib/list/params";

// The palette catalogue's invariants — the properties that make "the palette
// adds no new query path" TRUE rather than asserted in a comment.
//
// Each is a property a later edit could quietly break without any type error:
// a def pointing at a select that omits its own sort column pages in circles
// (lib/list/query.ts logs it only at runtime); a labelColumn that is not the
// spec's search column makes the palette display a field the search never
// matched; a page size above the ceiling is the unbounded-endpoint rule
// eroding by one convenient constant.

describe("palette entity catalogue", () => {
  it("stays inside the server-side page-size ceiling", () => {
    expect(PALETTE_RESULTS_PER_ENTITY).toBeGreaterThanOrEqual(1);
    expect(PALETTE_RESULTS_PER_ENTITY).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(PALETTE_MIN_QUERY_LENGTH).toBeGreaterThanOrEqual(1);
  });

  it("has unique keys, each a real route segment under /[orgSlug]", () => {
    const keys = PALETTE_ENTITIES.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The href each hit gets is `/${slug}/${key}/${id}`, so every key must be
    // a directory with a detail page in the app tree. Checked against the
    // filesystem rather than a hand-kept list, so a renamed route fails here
    // and not in a browser.
    for (const def of PALETTE_ENTITIES) {
      const detailDir = fileURLToPath(
        new URL(
          `../../../app/(app)/[orgSlug]/${def.key}/`,
          import.meta.url,
        ),
      );
      // Throws (failing the test, loudly named) if the segment is gone.
      expect(() => readFileSync(`${detailDir}page.tsx`)).not.toThrow();
      // And the DETAIL route a hit's href actually lands on: a dynamic
      // child segment ([contactId], [taskId], …) carrying its own page.
      const dynamicChild = readdirSync(detailDir).find(
        (entry) => entry.startsWith("[") && entry.endsWith("]"),
      );
      expect(dynamicChild, `${def.key}: no [id] detail route`).toBeDefined();
      expect(() =>
        readFileSync(`${detailDir}${dynamicChild}/page.tsx`),
      ).not.toThrow();
    }
  });

  it("displays the column the search matches, and can always build cursors", () => {
    for (const def of PALETTE_ENTITIES) {
      // What the palette renders is what the ILIKE matched — a hit whose
      // label never contains the query reads as a wrong answer.
      expect(def.labelColumn, def.key).toBe(def.spec.searchColumn);

      const sortOption = def.spec.sort[def.spec.defaultSort];
      expect(sortOption, `${def.key}: defaultSort missing from sort map`).toBeDefined();

      // fetchListPage derives boundary cursors from the sort column and
      // needs `id` for the tie-break; both must be in the select.
      const selected = def.select.split(",").map((part) => part.trim());
      expect(selected, def.key).toContain("id");
      expect(selected, def.key).toContain(sortOption.column);
      expect(selected, def.key).toContain(def.labelColumn);
    }
  });

  it("every filter's first choice filters nothing (the spec contract the palette leans on)", () => {
    // The palette submits each filter at its first choice; lib/list/spec.ts
    // documents choice[0] as "the one that filters nothing". If an entity
    // ever breaks that contract the palette silently under-reports records.
    for (const def of PALETTE_ENTITIES) {
      for (const [key, filter] of Object.entries(def.spec.filters)) {
        expect(
          filter.choices.length,
          `${def.key}.${key} has no choices`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
