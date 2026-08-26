import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Supabase Auth callback (OAuth + magic-link redirect target). Filled in by a
// later Foundation-phase task: exchange the `code` param for a session via
// @supabase/ssr's server client, then redirect into the app.
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/", request.url));
}
