import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Global middleware placeholder. Filled in by a later Foundation-phase task:
// Supabase session refresh (@supabase/ssr) and org-slug routing checks.
// Currently a pure pass-through so the scaffold builds and runs.
export function middleware(request: NextRequest) {
  void request;
  return NextResponse.next();
}
