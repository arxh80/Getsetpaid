import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUB_PROCESSORS } from "@/lib/legal/sub-processors";

// THE TWO SUB-PROCESSOR LISTS CANNOT DRIFT, because this compares them.
//
// docs/sub-processors.md is the engineering register (CLAUDE.md § Sub-
// processor / DPA register); lib/legal/sub-processors.ts is what the public
// Subprocessors page renders. The same vendors, in the same order, in the
// same place, with the same DPA status -- or this is red, in CI (tests/unit is
// the directory CI runs), naming the side that moved.

const REGISTER = fileURLToPath(new URL("../../../docs/sub-processors.md", import.meta.url));

interface RegisterRow {
  name: string;
  location: string;
  dpaSigned: boolean;
}

function readRegister(): RegisterRow[] {
  const md = readFileSync(REGISTER, "utf8");
  const rows: RegisterRow[] = [];
  const lines = md.split(/\r?\n/).filter((line) => line.startsWith("|"));
  // Header, separator, then data rows.
  const header = lines[0]?.split("|").map((c) => c.trim()) ?? [];
  const col = (label: string) => header.findIndex((c) => c.toLowerCase().startsWith(label));
  const nameCol = col("sub-processor");
  const locationCol = col("location");
  const dpaCol = col("dpa");
  if (nameCol < 0 || locationCol < 0 || dpaCol < 0) {
    throw new Error("docs/sub-processors.md: the register table's header changed shape");
  }
  for (const line of lines.slice(2)) {
    const cells = line.split("|").map((c) => c.trim());
    const name = /\*\*(.+?)\*\*/.exec(cells[nameCol] ?? "")?.[1];
    if (!name) throw new Error(`docs/sub-processors.md: no bold vendor name in row: ${line.slice(0, 60)}`);
    rows.push({
      name,
      // A trailing parenthetical that is a cross-reference (it holds a
      // backticked path) is register commentary, not part of the location.
      location: (cells[locationCol] ?? "").replace(/\s*\([^)]*`[^)]*\)\s*$/, "").trim(),
      dpaSigned: !/not yet signed/i.test(cells[dpaCol] ?? ""),
    });
  }
  return rows;
}

describe("the public Subprocessors list matches docs/sub-processors.md", () => {
  it("reads a non-empty register, so the comparison below means something", () => {
    expect(readRegister().length).toBeGreaterThan(0);
  });

  it("names the same vendors, in the same order", () => {
    expect(SUB_PROCESSORS.map((v) => v.name)).toEqual(readRegister().map((r) => r.name));
  });

  it("gives each the same location", () => {
    const register = new Map(readRegister().map((r) => [r.name, r.location]));
    for (const vendor of SUB_PROCESSORS) {
      expect(vendor.location, vendor.name).toBe(register.get(vendor.name));
    }
  });

  it("gives each the same DPA status -- the page must not claim an agreement the register says is missing", () => {
    const register = new Map(readRegister().map((r) => [r.name, r.dpaSigned]));
    for (const vendor of SUB_PROCESSORS) {
      expect(vendor.dpaSigned, vendor.name).toBe(register.get(vendor.name));
    }
  });
});
