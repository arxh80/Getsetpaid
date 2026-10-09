import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import { listWoundDownOrganisations, LIFECYCLE_LIST_LIMIT } from "@/lib/admin/lifecycle-list";
import {
  ORGANISATION_RETENTION_DAYS,
  daysUntil,
  lifecycleLabel,
} from "@/lib/admin/lifecycle-contract";
import { formatDateTime } from "@/lib/format/date";
import { StepUpGate } from "@/components/auth/step-up-gate";
import {
  CloseOrganisationForm,
  SuspendOrganisationForm,
  WoundDownOrganisationsList,
} from "@/components/admin/organisation-lifecycle-forms";

// PHASE 7 TASK 3: organisation lifecycle -- the operator's surface for
// suspending, closing and reopening a workspace.
//
// CLAUDE.md § Superuser dashboard: "Suspend/reinstate and delete are
// soft-delete only, require step-up re-auth, and notify the org's admin."
// All three are here, all three are behind <StepUpGate>, all three re-check
// step-up server-side (hiding a form is not enforcement), and the notification
// is in-app: components/org/suspended-banner.tsx, on every route of the
// affected workspace. There is no email at MVP -- Q45 for the fourth time.
//
// NO RECORD CONTENT ON THIS PAGE, AND NONE REACHABLE FROM IT. Names, slugs,
// states, timestamps and the operator's own reasons. CLAUDE.md's "no direct
// tenant-data access outside impersonation" is intact: to see what is IN one
// of these workspaces the operator still has to ask its admin and be told yes
// (/super/impersonation).
//
// generateMetadata(), NOT a static `export const metadata` -- the same fix
// app/(app)/super/audit-log/page.tsx and .../impersonation/page.tsx carry, for
// the identical reason: a static export is evaluated regardless of what the
// body decides, so the tab title would carry "Superuser" into the STREAMED
// refusal a non-superuser receives even though the body correctly does not.
// That is an enumeration oracle. isSuperuser() is cache()-wrapped, so calling
// it here AND in the body costs one RPC per request.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Organisations · Superuser · GetSetPaid" };
}

export default async function OrganisationLifecyclePage() {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for why
  // the gate lives in each page rather than in the layout. This runs below
  // this route's own loading.tsx boundary, so a refusal streams HTTP 200 plus
  // the identical app/(app)/not-found.tsx document.
  if (!(await isSuperuser())) notFound();

  const woundDown = await listWoundDownOrganisations();
  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Organisations
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Suspend, close and reopen a workspace. Every one of these is
          reversible and none of them deletes anything — a wound-down workspace
          is read-only, keeps every record, and is kept for{" "}
          <span className="tabular-nums">{ORGANISATION_RETENTION_DAYS}</span>{" "}
          days before it is considered fully wound down. Each transition needs a
          reason and is written to the audit log.
        </p>
      </div>

      <section className="flex flex-col gap-6">
        <h2 className="text-xl font-bold text-ink">Change a workspace</h2>
        {/* STEP-UP (CLAUDE.md § Session security: required before "deleting
            organisation data" and before "any high-risk admin/superuser
            function"). The gate decides what to RENDER; lib/admin/lifecycle.ts
            re-checks it server-side on all three actions. */}
        <StepUpGate next="/super/organisations">
          <div className="flex flex-col gap-10">
            <SuspendOrganisationForm />
            <div className="border-t border-rule pt-8">
              <CloseOrganisationForm />
            </div>
          </div>
        </StepUpGate>
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">
          Suspended and closed workspaces
        </h2>
        <p className="max-w-prose text-sm text-ink-muted">
          Reopening restores writes and the workspace’s place in the network
          directory. It works after the retention deadline too — that deadline
          is when a workspace stops being visible to the network, not a door
          that locks behind you.
        </p>

        {/* THE LIST IS A CLIENT COMPONENT, AND THE DATES ARE FORMATTED HERE.
            Two reasons, both about correctness rather than taste. The reinstate
            action state has to live ABOVE the rows or its confirmation unmounts
            with the row it just removed (the component's own header has the
            browser finding). And formatDateTime() is a server helper with an
            explicit timezone contract (DESIGN.md: UTC in the database, UK local
            in the UI) -- passing preformatted strings keeps one implementation
            of that rather than a second one in the bundle. */}
        <WoundDownOrganisationsList
          limit={LIFECYCLE_LIST_LIMIT}
          rows={woundDown.map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            stateLabel: lifecycleLabel(org.lifecycleState),
            changedAt: org.lifecycleChangedAt
              ? formatDateTime(org.lifecycleChangedAt)
              : null,
            reason: org.lifecycleReason,
            retentionExpiresAt: org.retentionExpiresAt
              ? formatDateTime(org.retentionExpiresAt)
              : null,
            retentionDays: daysUntil(org.retentionExpiresAt, now),
            ownerClosed: org.lifecycleState === "owner_closed",
          }))}
        />
      </section>
    </div>
  );
}
