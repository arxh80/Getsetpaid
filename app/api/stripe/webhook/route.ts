import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/invoices/stripe-webhook";

// POST /api/stripe/webhook -- Stripe Connect events, signed with
// STRIPE_WEBHOOK_SECRET. Public in the middleware (no session) by this EXACT
// path; the credential is the signature over the RAW body. Spec § 3.
// The body has to be read before its signature can be checked, so its SIZE is
// checked first: without this an unsigned multi-gigabyte POST is buffered whole
// (F13). Stripe's events are a few kilobytes; 1 MiB leaves ample room.
const MAX_BODY_BYTES = 1024 * 1024;

/** The body as UTF-8, or null once it passes `max` bytes (reading stops there). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request): Promise<NextResponse> {
  const gateway = getStripe();
  if (!gateway) return new NextResponse("Not configured", { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new NextResponse("Bad signature", { status: 400 });
  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return new NextResponse("Too large", { status: 413 });
  let event;
  try {
    event = gateway.constructEvent(raw, signature);
  } catch {
    return new NextResponse("Bad signature", { status: 400 });
  }
  const result = await handleStripeEvent(event);
  return NextResponse.json({ outcome: result.outcome }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
