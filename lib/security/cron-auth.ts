import { timingSafeEqual } from "node:crypto";

// The credential check shared by the cron routes under app/api (incident
// digest, exports, erasure, retention). Each route has its OWN secret, so
// leaking one never hands over another. A secret that is unset or shorter
// than 32 characters counts as unconfigured: the route then refuses every
// caller, and the caller answers 404 either way so a prober cannot tell
// "unconfigured" from "wrong secret".
export function cronAuthorised(request: Request, secretEnvVar: string): boolean {
  const secret = process.env[secretEnvVar]?.trim();
  if (!secret || secret.length < 32) return false;
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
