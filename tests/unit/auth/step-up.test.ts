// Unit tests for the session-freshness gate behind setting a password.
//
// WHY THESE ARE UNIT TESTS AND THE REST OF THIS REPO'S TESTS ARE NOT.
// Every other suite here talks to a real Supabase stack, because the thing
// under test is a database policy and a mocked policy proves nothing. This
// file is the exception on purpose: the property being asserted is "a session
// that authenticated N seconds ago is refused", and N is only reachable in an
// integration test by waiting N seconds. The age arithmetic and the
// method/fail-closed rules are pure functions of the JWT's `amr` claim, so
// they are tested here, deterministically, across every branch -- while the
// SHAPE of that claim (Supabase really does emit timestamped amr, and really
// does preserve the timestamp across a token refresh) was verified empirically
// against the running stack and is recorded in lib/auth/step-up.ts.

import { describe, expect, it } from "vitest";
import {
  LINK_PROOF_MAX_AGE_SECONDS,
  STEP_UP_MAX_AGE_SECONDS,
  isLinkProofFresh,
  isStepUpSatisfied,
  mayChangePassword,
  readAuthFreshness,
} from "@/lib/auth/step-up";

/** Claims whose most recent authentication was `method`, `agoSeconds` ago. */
function claims(method: string, agoSeconds: number) {
  return {
    sub: "00000000-0000-0000-0000-000000000001",
    amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - agoSeconds }],
  };
}

describe("readAuthFreshness", () => {
  it("reads the method and age of a single authentication", () => {
    const f = readAuthFreshness(claims("password", 42));
    expect(f.method).toBe("password");
    // One second of slack for the clock ticking mid-test.
    expect(f.ageSeconds).toBeGreaterThanOrEqual(42);
    expect(f.ageSeconds).toBeLessThanOrEqual(43);
  });

  it("takes the MOST RECENT entry when several are present", () => {
    const now = Math.floor(Date.now() / 1000);
    const f = readAuthFreshness({
      amr: [
        { method: "otp", timestamp: now - 3600 },
        { method: "password", timestamp: now - 10 },
      ],
    });
    expect(f.method).toBe("password");
    expect(f.ageSeconds).toBeLessThanOrEqual(11);
  });

  // Each of the next four is a FAIL-CLOSED case: a null age makes every gate
  // refuse. An auth server that stops emitting timestamped amr must break
  // password changes loudly, not silently downgrade the check to "a session
  // exists" -- which is the bug this whole module replaces.
  it("reports null age when amr is absent", () => {
    expect(readAuthFreshness({ sub: "x" })).toEqual({
      method: null,
      ageSeconds: null,
    });
  });

  it("reports null age when amr is empty", () => {
    expect(readAuthFreshness({ amr: [] }).ageSeconds).toBeNull();
  });

  it("reports null age for the RFC-8176 string form, which has no timestamps", () => {
    expect(readAuthFreshness({ amr: ["password", "otp"] }).ageSeconds).toBeNull();
  });

  it("reports null age for claims that are null or undefined", () => {
    expect(readAuthFreshness(null).ageSeconds).toBeNull();
    expect(readAuthFreshness(undefined).ageSeconds).toBeNull();
  });

  it("refuses a timestamp far in the future rather than reading it as brand new", () => {
    expect(readAuthFreshness(claims("password", -3600)).ageSeconds).toBeNull();
  });

  it("clamps small clock skew to zero instead of going negative", () => {
    expect(readAuthFreshness(claims("password", -5)).ageSeconds).toBe(0);
  });

  it("ignores malformed entries", () => {
    expect(
      readAuthFreshness({ amr: [{ method: "password" }, { timestamp: 1 }] })
        .ageSeconds,
    ).toBeNull();
  });
});

describe("isStepUpSatisfied — a credential was just presented", () => {
  it("allows a password sign-in from moments ago", () => {
    expect(isStepUpSatisfied(readAuthFreshness(claims("password", 5)))).toBe(true);
  });

  it("allows an MFA factor", () => {
    expect(isStepUpSatisfied(readAuthFreshness(claims("mfa/totp", 5)))).toBe(true);
    expect(isStepUpSatisfied(readAuthFreshness(claims("totp", 5)))).toBe(true);
  });

  it("REFUSES a password sign-in older than the step-up window", () => {
    expect(
      isStepUpSatisfied(
        readAuthFreshness(claims("password", STEP_UP_MAX_AGE_SECONDS + 1)),
      ),
    ).toBe(false);
  });

  // A magic link proves control of an inbox, not possession of a credential.
  // It has its own, shorter-leashed path and must never satisfy step-up.
  it("REFUSES a brand-new magic-link session", () => {
    expect(isStepUpSatisfied(readAuthFreshness(claims("otp", 1)))).toBe(false);
  });

  it("REFUSES an unknown method even when it is fresh", () => {
    expect(isStepUpSatisfied(readAuthFreshness(claims("carrier-pigeon", 1)))).toBe(
      false,
    );
  });

  it("REFUSES when amr carries no timestamp at all", () => {
    expect(isStepUpSatisfied({ method: "password", ageSeconds: null })).toBe(false);
  });
});

describe("isLinkProofFresh — a one-time emailed token was just consumed", () => {
  it("allows a just-consumed invite link", () => {
    expect(isLinkProofFresh(readAuthFreshness(claims("otp", 3)))).toBe(true);
  });

  it("allows an invitee who read the page for twenty minutes first", () => {
    expect(isLinkProofFresh(readAuthFreshness(claims("otp", 20 * 60)))).toBe(true);
  });

  it("REFUSES a link-minted session left open past the window", () => {
    expect(
      isLinkProofFresh(
        readAuthFreshness(claims("otp", LINK_PROOF_MAX_AGE_SECONDS + 1)),
      ),
    ).toBe(false);
  });

  it("REFUSES a password session, however fresh — that is step-up's job", () => {
    expect(isLinkProofFresh(readAuthFreshness(claims("password", 1)))).toBe(false);
  });

  it("REFUSES when amr carries no timestamp at all", () => {
    expect(isLinkProofFresh({ method: "otp", ageSeconds: null })).toBe(false);
  });
});

describe("mayChangePassword — the decision the Server Action makes", () => {
  it("accepts either proof", () => {
    expect(mayChangePassword(readAuthFreshness(claims("password", 5)))).toBe(true);
    expect(mayChangePassword(readAuthFreshness(claims("otp", 5)))).toBe(true);
  });

  // THE FINDING, stated as a test. A session well inside its 12-hour lifetime
  // is not proof of anything at the moment a password is set, whichever way it
  // was originally established.
  it("REFUSES an eleven-hour-old session inside the 12h timebox, by any method", () => {
    for (const method of ["password", "otp", "mfa/totp"]) {
      expect(mayChangePassword(readAuthFreshness(claims(method, 11 * 3600)))).toBe(
        false,
      );
    }
  });

  it("REFUSES a session whose only evidence is that it exists", () => {
    expect(mayChangePassword(readAuthFreshness({ sub: "x", iat: Date.now() / 1000 }))).toBe(
      false,
    );
  });

  it("REFUSES an unrecognised method", () => {
    expect(mayChangePassword(readAuthFreshness(claims("carrier-pigeon", 1)))).toBe(
      false,
    );
  });

  it("keeps the link window wider than step-up, and both bounded", () => {
    expect(LINK_PROOF_MAX_AGE_SECONDS).toBeGreaterThan(STEP_UP_MAX_AGE_SECONDS);
    expect(LINK_PROOF_MAX_AGE_SECONDS).toBeLessThanOrEqual(30 * 60);
  });
});
