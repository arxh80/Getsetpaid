import { NextResponse } from "next/server";
import { startCardPayment } from "@/lib/invoices/pay";
import { siteUrl } from "@/lib/supabase/env";

// POST /pay/[token]/start (invoices part 2 Task 5). The page's button, and the
// only thing that creates a Checkout Session: a mail scanner that GETs the link
// spends nothing. No session and no CSRF token on purpose -- the signed token
// is the credential and the action it authorises is "show me Stripe's page".
// No GET export, so a GET is a framework 405.
//
// The origin handed to Stripe is siteUrl(), never the request's Host.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// A RELATIVE Location, resolved by the browser against the origin it used (the
// auth callback's rule): request.url carries the server's own hostname.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: path } });
}

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  // The token may have failed verification, so the sender chose it: encode it before it
  // reaches a Location header (a char above U+00FF or a CR/LF would throw; `..//x` would
  // resolve to `//x`).
  const segment = encodeURIComponent(token);
  const outcome = await startCardPayment(token, siteUrl());
  switch (outcome.kind) {
    case "redirect":
      return NextResponse.redirect(outcome.url, { status: 303, headers: NO_STORE });
    case "refused":
      return seeOther(`/pay/${segment}`);
    case "unavailable":
      return seeOther(`/pay/${segment}?unavailable=1`);
  }
}
