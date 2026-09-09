import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  listActiveBillingOverrides,
  listActiveFeatureOverrides,
  OVERRIDE_LIST_LIMIT,
} from "@/lib/admin/overrides-list";
import {
  FEATURE_FLAG_LABELS,
  isFeatureFlagKey,
  TIER_CHOICE_LABELS,
} from "@/lib/admin/overrides-contract";
import { daysUntil } from "@/lib/admin/lifecycle-contract";
import { formatDateTime } from "@/lib/format/date";
import { StepUpGate } from "@/components/auth/step-up-gate";
import {
  ActiveBillingOverridesList,
  ActiveFeatureOverridesList,
  GrantBillingOverrideForm,
  GrantFeatureOverrideForm,
} from "@/components/admin/override-forms";

// PHASE 7 TASK 4: billing overrides + per-org feature overrides.
//
// CLAUDE.md § Superuser dashboard: "Billing overrides ... require step-up
// re-auth, a mandatory reason field ... and notify the org admin
// automatically. Comps/overrides are time-boxed and auto-revert ... never a
// silent permanent edit." and "Per-org feature overrides ... scoped per org
// per flag, with a mandatory expiry date -- no open-ended overrides." Both
// grant forms are here, both behind <StepUpGate>, both re-check step-up
// server-side (hiding a form is not enforcement), and both auto-revert by
// READ-TIME EXPIRY -- nothing is scheduled, so there is nothing to verify ran.
//
// NO RECORD CONTENT ON THIS PAGE. Workspace names, slugs, tiers, seat counts,
// flag keys, the operator's own reasons and the two clocks -- the same
// "aggregate metadata, never record content" shape every other /super/* page
// in this phase keeps. CLAUDE.md's "no direct tenant-data access outside
// impersonation" is intact.
//
// generateMetadata(), NOT a static `export const metadata` -- the same fix
// every /super/* page in this phase carries, for the identical reason: a
// static export is evaluated regardless of what the body decides, so the tab
// title would carry "Superuser" into the STREAMED refusal a non-superuser
// receives. isSuperuser() is cache()-wrapped, so calling it here AND in the
// body costs one RPC per request.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Billing overrides · Superuser · GetSetPaid" };
}

export default async function BillingOverridesPage() {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for why
  // the gate lives in each page rather than in the layout.
  if (!(await isSuperuser())) notFound();

  const [billingOverrides, featureOverrides] = await Promise.all([
    listActiveBillingOverrides(),
    listActiveFeatureOverrides(),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Billing and feature overrides
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Time-boxed, audited exceptions to a workspace’s own plan. Neither
          kind ever touches the workspace’s real subscription row — both
          auto-revert the instant they expire, with nothing scheduled and
          nothing further to do.
        </p>
      </div>

      <section className="flex flex-col gap-6">
        <StepUpGate next="/super/billing">
          <GrantBillingOverrideForm />
        </StepUpGate>
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Active billing overrides</h2>
        <ActiveBillingOverridesList
          limit={OVERRIDE_LIST_LIMIT}
          rows={billingOverrides.map((row) => ({
            id: row.id,
            organisationName: row.organisationName,
            organisationSlug: row.organisationSlug,
            reason: row.reason,
            expiresAtLabel: formatDateTime(row.expiresAt),
            daysRemaining: daysUntil(row.expiresAt, now),
            overrideTierLabel: row.overrideTier ? TIER_CHOICE_LABELS[row.overrideTier] : null,
            overrideSeats: row.overrideSeats,
          }))}
        />
      </section>

      <section className="flex flex-col gap-6 border-t border-rule pt-8">
        <StepUpGate next="/super/billing">
          <GrantFeatureOverrideForm />
        </StepUpGate>
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Active feature overrides</h2>
        <ActiveFeatureOverridesList
          limit={OVERRIDE_LIST_LIMIT}
          rows={featureOverrides.map((row) => ({
            id: row.id,
            organisationName: row.organisationName,
            organisationSlug: row.organisationSlug,
            reason: row.reason,
            expiresAtLabel: formatDateTime(row.expiresAt),
            daysRemaining: daysUntil(row.expiresAt, now),
            // An unmirrored flag_key (DB allowlist extended before this
            // deploy, or a service-role write) renders RAW rather than being
            // hidden (review M4) -- a live override must stay findable and
            // revocable here.
            flagLabel: isFeatureFlagKey(row.flagKey)
              ? FEATURE_FLAG_LABELS[row.flagKey]
              : row.flagKey,
          }))}
        />
      </section>
    </div>
  );
}
