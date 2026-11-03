import "server-only";

// THE ROUTING CONFIRMATION TOKEN (fix round 2, re-review finding R3 / Q163).
//
// Passing a data subject request to a customer workspace is irreversible in
// the way that matters: the requester is told which business was asked, and an
// audited re-route is the only correction. Q160a therefore asked for a
// confirmation step. It shipped as
//
//     confirmedSlug === organisationSlug     // both from the SAME POST
//
// which is a safety interlock against the FORM and not against a submission: a
// single crafted request carrying both fields routed at once, with the
// workspace's NAME never rendered to anybody. And it bound the typed SLUG
// rather than the organisation that slug RESOLVED to, so a slug reassigned
// between the two presses -- the one case where re-asking actually matters --
// would have routed to a workspace whose name was never shown.
//
// So the first press now MINTS a token over (requestId, organisationId) and
// the second is accepted only if that token verifies AND the slug still
// resolves to the same organisation id. Two presses are genuinely two
// requests, and the binding is to the workspace rather than to a string.
//
// THIS IS NOT AN AUTHORISATION BOUNDARY, and the code should not be read as
// one: routeDataSubjectRequestAction checks isSuperuser() first, and the
// database's own deferred constraint trigger requires the handover note
// whatever the app sends. A forged token would buy a platform superuser the
// right to skip their own confirmation dialog. It is a typo interlock that now
// actually interlocks.
//
// THE KEY. Derived from SUPABASE_SERVICE_ROLE_KEY, which is server-only by
// construction (CLAUDE.md § Non-negotiable rules) and is already required for
// the app to run. It is HASHED with a purpose string before use, so the token
// is a digest of a digest and reveals nothing about the key, and the key is
// never sent anywhere. When it is unset -- a misconfigured deployment -- a
// per-process random key is used instead, which is still unforgeable and
// simply means an operator is asked to confirm again after a restart. It NEVER
// falls back to "accept anything".

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a confirmation stays good. Long enough to read the name and press
 *  again, short enough that a token left in a stale tab is not a standing
 *  permission to route. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

const PURPOSE = "getsetpaid:dsr-routing-confirmation:v1";

/** Only ever reached when SUPABASE_SERVICE_ROLE_KEY is unset. Random per
 *  process, so it fails CLOSED (re-ask) rather than open. */
const FALLBACK_KEY = randomBytes(32);

function key(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (secret === "") return FALLBACK_KEY;
  return createHash("sha256").update(`${PURPOSE}:${secret}`).digest();
}

function digest(requestId: string, organisationId: string, issuedAt: number): string {
  return createHmac("sha256", key())
    .update(`${PURPOSE}|${requestId}|${organisationId}|${issuedAt}`)
    .digest("hex");
}

/** Minted on the FIRST press, once the slug has resolved to a real workspace. */
export function mintRoutingConfirmation(
  requestId: string,
  organisationId: string,
  now: number = Date.now(),
): string {
  return `${now}.${digest(requestId, organisationId, now)}`;
}

/**
 * True only for a token this server minted, for THIS request and THIS
 * organisation, within the last fifteen minutes.
 *
 * Every failure is the same answer -- re-ask -- so there is nothing to learn
 * from which one fired.
 */
export function verifyRoutingConfirmation(
  token: string | null | undefined,
  requestId: string,
  organisationId: string,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const issuedAt = Number(token.slice(0, dot));
  if (!Number.isInteger(issuedAt)) return false;
  // A future-dated token would otherwise extend its own life indefinitely --
  // the same class of mistake as R1's forgeable resolution clock.
  if (issuedAt > now + 60_000) return false;
  if (now - issuedAt > TOKEN_TTL_MS) return false;

  const presented = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(digest(requestId, organisationId, issuedAt), "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
