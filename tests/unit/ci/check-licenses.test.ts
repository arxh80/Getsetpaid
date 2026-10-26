import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no type declarations
import { violations } from "../../../scripts/check-licenses.mjs";

// Phase 10 Task 9 (G23): scripts/check-licenses.mjs. The REAL production
// distribution is checked by CI's scan job on every pull request (the script
// reads `pnpm licenses list --prod --json` on stdin); these are its rules.
const pkg = (name: string) => ({ name, versions: ["1.0.0"] });

describe("check-licenses (G23)", () => {
  it("an AGPL-3.0 package fails, by name", () => {
    expect(violations({ MIT: [pkg("ok")], "AGPL-3.0": [pkg("copyleft-lib")] })).toEqual([
      "copyleft-lib (AGPL-3.0)",
    ]);
  });

  it("an unknown licence fails", () => {
    expect(violations({ "SEE LICENSE IN LICENSE.md": [pkg("mystery")] })).toEqual([
      "mystery (SEE LICENSE IN LICENSE.md)",
    ]);
  });

  it("the LGPL is admitted for @img/sharp-* only", () => {
    expect(
      violations({
        "Apache-2.0 AND LGPL-3.0-or-later": [pkg("@img/sharp-win32-x64")],
        "LGPL-3.0-or-later": [pkg("@img/sharp-libvips-linux-x64"), pkg("some-other-lgpl")],
      }),
    ).toEqual(["some-other-lgpl (LGPL-3.0-or-later)"]);
  });
});
