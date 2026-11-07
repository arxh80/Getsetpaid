"use server";
// Link and disconnect the workspace's own Stripe account (Invoices part 2).
// Gates, in order: the workspace (membership), finance WRITE access
// (manage_finance + Pro + not suspended), that Stripe is configured on this
// server, STEP-UP re-authentication (it changes where card payments go).
// begin_stripe_link / end_stripe_account_link spend the token minted here
// (purpose invoice_settings); the OAuth state is a database row bound to this
// user (plan decision 3), and the ONE fixed callback route (/api/stripe/connect/callback,
// which Stripe's exact-match redirect list requires) finishes the link. Each link
// or end is emailed to the Owners and Admins by the delivery tick.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { checkStepUp, mintStepUpToken } from "@/lib/auth/step-up-gate";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/supabase/env";
import { getStripe } from "@/lib/stripe/client";
import { field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { invoiceRefusal } from "@/lib/invoices/refusals";

const NEEDS_STEP_UP =
  "Confirm it is you before changing the Stripe connection. Use the prompt on this page, then try again.";
const NOT_CONFIGURED = "Card payments aren’t set up on this server yet.";
const DISCONNECTED =
  "Disconnected. Card payment links on this workspace’s invoices now say they can’t be paid online.";
const DISCONNECTED_UNCONFIRMED =
  "Disconnected here, but Stripe didn’t confirm it. Remove GetSetPaid under Settings → Connected accounts in your Stripe dashboard.";

export async function startStripeLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org) return { error: FAILED_MESSAGE };

  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) return { error: access.explanation };
  // Before the step-up, so an unconfigured server never mints a token it cannot use.
  const gateway = getStripe();
  if (!gateway) return { error: NOT_CONFIGURED };
  if (!(await checkStepUp()) || !(await mintStepUpToken("invoice_settings"))) return { error: NEEDS_STEP_UP };

  const supabase = await createClient();
  const { data: state, error } = await supabase.rpc("begin_stripe_link", { p_org: org.id });
  if (error || typeof state !== "string") {
    if (!error?.hint) console.error("[invoices] begin stripe link failed:", error?.message);
    return { error: error ? invoiceRefusal(error) : FAILED_MESSAGE };
  }
  // Outside any try/catch: redirect() is a thrown signal Next must see.
  redirect(gateway.authorizeUrl(state, `${siteUrl()}/api/stripe/connect/callback`));
}

export async function disconnectStripeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orgSlug = field(formData, "orgSlug");
  const org = orgSlug ? await getCurrentOrg(orgSlug) : null;
  if (!org) return { error: FAILED_MESSAGE };

  const access = await getFinanceWriteAccess(org);
  if (!access.canWrite) return { error: access.explanation };
  if (!(await checkStepUp()) || !(await mintStepUpToken("invoice_settings"))) return { error: NEEDS_STEP_UP };

  // The row is ended FIRST: a Stripe outage must never leave a workspace
  // taking card payments it asked to stop.
  const supabase = await createClient();
  const { data: account, error } = await supabase.rpc("end_stripe_account_link", { p_org: org.id });
  if (error) {
    if (!error.hint) console.error("[invoices] end stripe link failed:", error.message);
    return { error: invoiceRefusal(error) };
  }
  revalidatePath(`/${org.slug}/settings/invoicing`);
  if (typeof account !== "string") return { message: "There was no connected Stripe account to disconnect." };

  try {
    const gateway = getStripe();
    if (!gateway) return { message: DISCONNECTED_UNCONFIRMED };
    await gateway.deauthorize(account);
  } catch (e) {
    console.error("[invoices] Stripe deauthorise failed:", e instanceof Error ? e.name : "error");
    return { message: DISCONNECTED_UNCONFIRMED };
  }
  return { message: DISCONNECTED };
}
