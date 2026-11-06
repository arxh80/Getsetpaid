import { NextResponse } from "next/server";
import { getCurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/supabase/env";
import { getStripe } from "@/lib/stripe/client";
import { INVOICE_REFUSAL_SENTENCES } from "@/lib/invoices/refusals";

// GET /[orgSlug]/settings/invoicing/stripe/callback: where Stripe sends the
// person back after the OAuth screen. Nothing here is trusted: the `state` is
// checked by complete_stripe_link (a database row bound to THIS signed-in user
// and workspace, single use, ten minutes), and the account id comes from the
// code exchange with Stripe, never from the query. Every exit is a redirect to
// the settings page with a `stripe=` KEY the page maps to a sentence from an
// allowlist; no query value is ever echoed.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ orgSlug: string }> },
): Promise<Response> {
  const { orgSlug } = await ctx.params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return new Response("Not found", { status: 404, headers: NO_STORE });

  // Redirect to the configured origin, never the request's Host header.
  const back = (key: string) =>
    NextResponse.redirect(`${siteUrl()}/${org.slug}/settings/invoicing?stripe=${key}`, { status: 303, headers: NO_STORE });

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (params.has("error") || !code || !state) return back("cancelled");

  const gateway = getStripe();
  if (!gateway) return back("failed");

  let account: string;
  let chargesEnabled: boolean;
  try {
    ({ account } = await gateway.exchangeCode(code));
    chargesEnabled = await gateway.chargesEnabled(account);
  } catch (e) {
    console.error("[invoices] Stripe link exchange failed:", e instanceof Error ? e.name : "error");
    return back("failed");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_stripe_link", {
    p_org: org.id,
    p_state: state,
    p_account: account,
    p_charges_enabled: chargesEnabled,
  });
  if (error) {
    if (error.hint && Object.hasOwn(INVOICE_REFUSAL_SENTENCES, error.hint)) return back(error.hint);
    console.error("[invoices] complete stripe link failed:", error.message);
    return back("failed");
  }
  return back("linked");
}
