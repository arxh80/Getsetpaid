// WHAT /account/erase TELLS SOMEBODY WHO CANNOT BE DELETED YET.
//
// Fix round 2, review finding N2 / Q178. `describeBlockers()` said one thing
// to everybody it refused: "You are the only owner of X ... Make somebody
// else an owner there, or close the workspace". For the person the
// re-founded Q131 guard newly blocks -- a NON-OWNER who is the last active
// member of an already-ownerless workspace that still holds records -- both
// halves are false and neither is reachable: there is nobody to promote, and
// no member-facing route to close a workspace exists anywhere in this
// product. The database's refusal branches (20261002001000) and so does
// this, on the third `reason` value that migration added.

import { describe, expect, it } from "vitest";
import { describeBlockers, type ErasureBlocker } from "@/lib/erasure/contract";

const owned: ErasureBlocker = { organisationName: "Alpha Ltd", reason: "other_members" };
const ownedData: ErasureBlocker = { organisationName: "Beta Ltd", reason: "workspace_has_data" };
const unowned: ErasureBlocker = { organisationName: "Gamma Ltd", reason: "no_owner_to_transfer" };

describe("describeBlockers", () => {
  it("says nothing when nothing is in the way", () => {
    expect(describeBlockers([])).toBeNull();
  });

  it("keeps the Q131 remedy for a subject who IS the owner", () => {
    const text = describeBlockers([owned])!;
    expect(text).toContain("Alpha Ltd");
    expect(text).toContain("You are the only owner of");
    expect(text).toContain("Make somebody else an owner");
    expect(text).not.toContain("support");
  });

  it("names support, and not a remedy they cannot perform, for a subject who is NOT", () => {
    const text = describeBlockers([unowned])!;
    expect(text).toContain("Gamma Ltd");
    expect(text).toContain("no owner at all");
    expect(text).toContain("Contact support");
    // The whole finding: this sentence must not tell them to do either of
    // the two things that are not available to them.
    expect(text).not.toContain("You are the only owner of");
    expect(text).not.toContain("Make somebody else an owner there, or close the workspace");
  });

  it("says both when both kinds block at once, and names each workspace under its own remedy", () => {
    const text = describeBlockers([owned, ownedData, unowned])!;
    const ownedAt = text.indexOf("Alpha Ltd");
    const unownedAt = text.indexOf("Gamma Ltd");
    expect(ownedAt).toBeGreaterThanOrEqual(0);
    expect(unownedAt).toBeGreaterThan(ownedAt);
    expect(text).toContain("Beta Ltd");
    expect(text).toContain("Make somebody else an owner");
    expect(text).toContain("Contact support");
    // Gamma is in the support sentence, not the ownership one.
    expect(text.slice(0, unownedAt)).not.toContain("Gamma Ltd");
  });

  it("lists several of one kind in one sentence rather than repeating itself", () => {
    const text = describeBlockers([owned, ownedData])!;
    expect(text).toContain("Alpha Ltd and Beta Ltd");
    expect(text.match(/You are the only owner of/g)).toHaveLength(1);
    expect(text).toContain("these workspaces");
  });
});
