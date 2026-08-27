import "server-only";

// Reads the request path lib/supabase/middleware.ts stamps onto every
// matched request (fix round 1, Task 7 Minor) as the "x-pathname" header, so
// a Server Component/layout can send a user back to the page they actually
// wanted once an interstitial gate (MFA enrollment/challenge, future
// step-up) is satisfied, instead of always landing them on "/".
//
// The header NAME is duplicated as a literal here rather than imported from
// lib/supabase/middleware.ts: that file imports "next/server", which is
// scoped to the middleware/edge execution context, and importing it into an
// ordinary Server Component's module graph is worth avoiding even though it
// would likely resolve -- keeping the two files decoupled means a change to
// one cannot silently break the runtime bundling of the other.
import { headers } from "next/headers";

const PATHNAME_HEADER = "x-pathname";

/**
 * Falls back to "/" rather than throwing if the header is ever missing --
 * e.g. a route excluded from proxy.ts's matcher, or a future caller from
 * outside a real request (a unit test). "/" is also the app's own signed-in
 * hub, so it is a safe, working destination in every case, not a broken one.
 */
export async function currentPath(): Promise<string> {
  const list = await headers();
  return list.get(PATHNAME_HEADER) ?? "/";
}
