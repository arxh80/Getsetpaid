import "server-only";
// /pay/<invoiceId>.<sig>: sig = base64url HMAC-SHA256("invoice-pay-link:v1:<id>").
// Nothing stored; rotating INVOICE_PAY_LINK_SECRET kills every link (spec § 2).
import { createHmac, timingSafeEqual } from "node:crypto";
import { siteUrl } from "@/lib/supabase/env";
import { payLinkSecret } from "@/lib/stripe/env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(secret: Buffer, invoiceId: string): Buffer {
  return createHmac("sha256", secret).update(`invoice-pay-link:v1:${invoiceId}`).digest();
}

export function payLinkToken(invoiceId: string): string | null {
  const secret = payLinkSecret();
  if (!secret || !UUID.test(invoiceId)) return null;
  return `${invoiceId}.${sign(secret, invoiceId).toString("base64url")}`;
}

export function verifyPayLinkToken(token: string): string | null {
  const secret = payLinkSecret();
  const parts = token.split(".");
  if (!secret || parts.length !== 2 || !UUID.test(parts[0]) || !parts[1]) return null;
  // Compare the canonical STRINGS, not decoded bytes: the decoder skips characters
  // outside the alphabet, so a decoded compare would accept `sig + "!"`.
  const presented = Buffer.from(parts[1]);
  const expected = Buffer.from(sign(secret, parts[0]).toString("base64url"));
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? parts[0] : null;
}

export function payLinkUrl(invoiceId: string): string | null {
  const token = payLinkToken(invoiceId);
  return token ? `${siteUrl()}/pay/${token}` : null;
}
