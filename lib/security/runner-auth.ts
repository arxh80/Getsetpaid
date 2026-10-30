import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// THE CREDENTIAL CHECK OF THE FOUR SESSIONLESS RUNNER ROUTES (Phase 10 Task
// 25): /api/exports/run, /api/erasure/run, /api/retention/run and
// /api/incident-alerts/deliver. Their caller is the database: pg_cron, via
// pg_net, with `Authorization: Bearer <secret>` read from Supabase Vault.
//
// lib/supabase/middleware.ts lists those paths as public so the signed-out
// bounce does not redirect a cron to /login; the credential is the bearer
// secret, compared in constant time. With the secret UNSET (or under 32
// characters) the route answers 404 for every caller -- an unconfigured
// deployment has no endpoint at all rather than an open one -- and a wrong
// secret answers the same 404, so a prober cannot tell the two apart.
//
// Each route keeps its OWN secret (its env name is the argument), so leaking
// one never hands over another.

function configuredSecret(envName: string): string | null {
  const value = process.env[envName];
  return value && value.trim().length >= 32 ? value.trim() : null;
}

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The 404 every refusal answers, or `null` when the caller holds the secret. */
export function refuseUnlessRunner(request: Request, envName: string): NextResponse | null {
  const secret = configuredSecret(envName);
  if (!secret || !bearerMatches(request.headers.get("authorization"), secret)) {
    return new NextResponse("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}
