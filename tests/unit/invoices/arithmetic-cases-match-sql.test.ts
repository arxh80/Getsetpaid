// The SQL arithmetic is tested in supabase/tests/rls_invoices.sql § IA against
// its own copy of the case table. This binds that copy to the TypeScript one,
// row for row, so the two implementations are tested against ONE table.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARITHMETIC_CASES } from "./arithmetic-cases";

const SQL = readFileSync(path.join(process.cwd(), "supabase", "tests", "rls_invoices.sql"), "utf8");

function sqlCases() {
  const block = SQL.split("-- ARITHMETIC CASES BEGIN")[1]?.split("-- ARITHMETIC CASES END")[0] ?? "";
  const row = /\('(\d+\.\d{2})',\s*(\d+),\s*'([a-z_0-9]+)',\s*(\d+),\s*(\d+)\)/g;
  return [...block.matchAll(row)].map((m) => ({
    quantity: m[1],
    unitPriceMinor: Number(m[2]),
    rate: m[3],
    netMinor: Number(m[4]),
    vatMinor: Number(m[5]),
  }));
}

describe("the SQL suite's arithmetic cases are the TypeScript ones", () => {
  it("finds the block at all, so this cannot pass vacuously", () => {
    expect(sqlCases().length).toBeGreaterThan(0);
  });
  it("matches row for row, in order", () => {
    expect(sqlCases()).toEqual(ARITHMETIC_CASES.map((c) => ({ ...c })));
  });
});
