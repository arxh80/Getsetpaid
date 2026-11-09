import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/invoices/stripe-webhook";

// POST /api/stripe/webhook -- Stripe Connect events, signed with
// STRIPE_WEBHOOK_SECRET. Public in the middleware (no session) by this EXACT
// path; the credential is the signature over the RAW body. Spec § 3.
export async function POST(request: Request): Promise<NextResponse> {
  const gateway = getStripe();
  if (!gateway) return new NextResponse("Not configured", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new NextResponse("Bad signature", { status: 400 });
  const raw = await request.text();
  let event;
  try {
    event = gateway.constructEvent(raw, signature);
  } catch {
    return new NextResponse("Bad signature", { status: 400 });
  }
  const result = await handleStripeEvent(event);
  return NextResponse.json({ outcome: result.outcome }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
