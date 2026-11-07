import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/supabase/env";
import { getStripe } from "@/lib/stripe/client";
import { INVOICE_REFUSAL_SENTENCES } from "@/lib/invoices/refusals";

// GET /api/stripe/connect/callback: where Stripe sends the person back after
// the OAuth screen. ONE fixed path, because Stripe matches redirect_uri
// EXACTLY against a registered list, so the workspace cannot be in it: the
// `state` row says which workspace this is for.
//
// SIGN-IN IS REQUIRED (middleware; this path is NOT public and must never be
// reached through a widened `/api/stripe` prefix in PUBLIC_PATHS -- only the
// webhook's exact path is public). Nothing in the query is trusted:
//   1. claim_stripe_link_state() FIRST: once, for the signed-in user who began
//      it, unexpired, with manage_finance and Pro re-checked on the state's
//      workspace. Stripe's token endpoint is not idempotent (a code used twice
//      REVOKES the connection), so a replay, a reload or a forged GET must be
//      refused here and never reach Stripe. The workspace comes ONLY from this
//      row, never from the query.
//   2. the code exchange; the account id comes from Stripe, never the query.
//   3. complete_stripe_link() on the claimed state.
// Every exit is a redirect carrying a `stripe=` KEY the settings page maps to
// a sentence from an allowlist; no query value is ever echoed. A refused claim
// has no workspace to go back to, so it lands on `/` with no key. A Stripe
// failure after a claim leaves the state spent: the person starts again.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  const redirectTo = (path: string) => NextResponse.redirect(`${siteUrl()}${path}`, { status: 303, headers: NO_STORE });

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!state) return redirectTo("/");

  const supabase = await createClient();
  const { data: claimed, error: claimError } = await supabase.rpc("claim_stripe_link_state", { p_state: state });
  const row = Array.isArray(claimed) ? (claimed[0] as { organisation_id?: string; slug?: string } | undefined) : undefined;
  if (claimError || !row?.organisation_id || !row.slug) {
    if (claimError && !claimError.hint) console.error("[invoices] claim stripe link state failed:", claimError.message);
    return redirectTo("/");
  }
  const back = (key: string) => redirectTo(`/${encodeURIComponent(row.slug!)}/settings/invoicing?stripe=${key}`);

  if (params.has("error") || !code) return back("cancelled");

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

  const { error } = await supabase.rpc("complete_stripe_link", {
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
