import "server-only";

// The reusable step-up gate CLAUDE.md § Session security asks for: "Step-up
// re-authentication ... is required before: changing security settings (MFA,
// password, email), large data exports, deleting organisation data, and any
// high-risk admin/superuser function." lib/auth/step-up.ts already built the
// hard part -- reading session freshness from the JWT's `amr` claim and
// deciding whether a credential was presented within the last five minutes.
// This file does NOT reimplement that; it is the thin, request-bound wiring
// that a UI gate (components/auth/step-up-gate.tsx) and its future callers
// (Admin/Security phase: MFA changes, exports, org deletion, impersonation)
// actually call.
//
// SPLIT ON PURPOSE, mirroring lib/auth/idle-timeout.ts's split from its
// component: `checkStepUp` takes claims as an OPTIONAL parameter rather than
// always reaching for cookies() itself. Passed explicitly (as the wiring test
// in tests/unit/auth/step-up-gate.test.ts does), it is a pure decision over
// data the test controls -- exactly like the exhaustive isStepUpSatisfied
// cases in step-up.test.ts, just exercised through the function real callers
// use rather than re-deriving amr arithmetic a second time. Left undefined
// (every real call site), it reads the CURRENT request's own verified claims
// via getClaims() -- never a hand-decoded cookie, for the same reason
// step-up.ts insists on it: only getClaims() revalidates the JWT with the
// auth server rather than trusting whatever the cookie claims.
import { createClient } from "@/lib/supabase/server";
import { isStepUpSatisfied, readAuthFreshness } from "./step-up";

export async function checkStepUp(
  claims?: Record<string, unknown> | null,
): Promise<boolean> {
  let resolvedClaims = claims;
  if (resolvedClaims === undefined) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    resolvedClaims = data?.claims;
  }
  return isStepUpSatisfied(readAuthFreshness(resolvedClaims));
}
