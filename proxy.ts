import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Formerly middleware.ts. Next 16 deprecated the `middleware` file convention
// in favour of `proxy` -- same signature, same behaviour, a rename only
// (https://nextjs.org/docs/messages/middleware-to-proxy). Keeping the old name
// would have shipped a deprecation warning on every build.
//
// Refreshes the Supabase session on every matched request and does coarse
// signed-in/signed-out routing. The reasoning -- including why the response
// object must be threaded through rather than rebuilt, and why nothing here is
// an authorisation control -- is in lib/supabase/middleware.ts.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. Auth routes ARE matched
     * on purpose: /auth/callback needs the refreshed cookie jar, and /login
     * needs the signed-in bounce.
     *
     * Keep this list tight. A matcher that accidentally excludes an app route
     * means that route renders with a stale session -- and, because the Server
     * Component cookie writer is a no-op (see lib/supabase/server.ts), nothing
     * repairs it.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
