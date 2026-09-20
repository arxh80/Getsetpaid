import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import { getOwnExportJobs } from "@/lib/export/jobs";
import {
  EXPORT_ALREADY_RUNNING,
  EXPORT_LIMITS,
  WORKSPACE_EXPORT_EXCLUDES,
  WORKSPACE_EXPORT_INCLUDES,
  describeArchiveLife,
} from "@/lib/export/contract";
import { Alert } from "@/components/ui/alert";
import { ActionOutcome } from "@/components/ui/action-outcome";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { ExportJobList } from "@/components/account/export-job-list";
import { ExportStartForm } from "@/components/account/export-start-form";

// Settings › Export this workspace (Phase 8 Task 4).
//
// Q132: the CUSTOMER is the controller of its own records and GetSetPaid is
// only the processor, so this is the page a customer uses to answer a data
// subject request routed to them, to leave the product, and to take a copy
// before the 60-day retention window closes on a suspended or closed
// workspace.
//
// ===========================================================================
// WHO SEES IT, AND WHAT THEY SEE
// ===========================================================================
// The page renders for anyone who can reach the workspace, like the
// custom-fields settings screen beside it — a member without
// `export_organisation_data` reads what an export is and who can start one,
// rather than a 404 that would imply the feature does not exist. The CONTROL
// is what the permission gates, and the control is not the enforcement
// either: private.export_jobs_before_insert() refuses the insert, so
// stripping `disabled` in the browser changes nothing.
//
// The list below is the reader's OWN exports of this workspace, because there
// is no cross-member read of export_jobs at all (20260927001000 § 7): an
// archive is a snapshot taken under one person's access rights, so a second
// Admin does not get to download it and does not get to see that it exists.
// The audit log is the surface for that.
//
// A SUSPENDED WORKSPACE CAN STILL BE EXPORTED. `export_organisation_data` is
// survives_suspension = true, deliberately: the 60-day window after a
// suspension or closure is exactly when a customer needs their copy, and
// locking them out of it would make the retention promise unkeepable.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/settings/export">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Export · Settings · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function WorkspaceExportSettingsPage({
  params,
}: PageProps<"/[orgSlug]/settings/export">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const mayExport = await hasPermission(org.id, "export_organisation_data");
  const state = await getOwnExportJobs("workspace", org.id);
  const live = state.jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Export this workspace
        </h1>
        <p className="max-w-prose text-lg text-ink-muted">
          A zip of {org.name}’s records — one machine-readable JSON file per table, plus the
          files themselves. It is prepared in the background and appears here when it is ready.
        </p>
      </div>

      <ActionOutcome testId="export-outcome">
        <section aria-labelledby="whats-in-it" className="flex flex-col gap-3">
          <h2 id="whats-in-it" className="text-xl font-bold text-ink">
            What is in it
          </h2>
          <p className="max-w-prose text-base text-ink-muted">{WORKSPACE_EXPORT_INCLUDES}</p>
          <p className="max-w-prose text-base text-ink-muted">{WORKSPACE_EXPORT_EXCLUDES}</p>
          <p className="max-w-prose text-base text-ink-muted">
            A file that did not pass the malware scan is listed with its scan status and its
            bytes are left out; the archive says so. Only you can download it, from this page,
            and the archive is kept for {describeArchiveLife(EXPORT_LIMITS.archiveDays)}.
          </p>
          <p className="max-w-prose text-base text-ink-muted">
            Your own account data — your profile, your memberships, your requests — is a
            separate export on{" "}
            <Link
              href="/account/exports"
              prefetch={false}
              className="underline underline-offset-4 hover:text-ink"
            >
              your account page
            </Link>
            .
          </p>
        </section>

        <section aria-labelledby="start-export" className="flex flex-col gap-5">
          <h2 id="start-export" className="text-xl font-bold text-ink">
            Start an export
          </h2>
          {mayExport ? (
            <>
              {/* CLAUDE.md § Session security: re-authenticate before a large
                  data export. The gate renders the prompt when the session's
                  last credential use is over five minutes old; the action
                  re-checks it server-side either way. */}
              <StepUpGate next={`/${orgSlug}/settings/export`}>
                {live ? (
                  <Alert tone="info" live={false}>
                    {EXPORT_ALREADY_RUNNING}
                  </Alert>
                ) : null}
                <ExportStartForm
                  kind="workspace"
                  orgSlug={orgSlug}
                  disabled={live}
                  disabledReason={live ? EXPORT_ALREADY_RUNNING : undefined}
                />
              </StepUpGate>
            </>
          ) : (
            <Alert tone="info" live={false}>
              Only an Owner or an Admin of {org.name} can export it. Ask one of them if you need
              a copy.
            </Alert>
          )}
        </section>

        <section aria-labelledby="your-exports" className="flex flex-col gap-5">
          <h2 id="your-exports" className="text-xl font-bold text-ink">
            Your exports of this workspace
          </h2>
          <ExportJobList
            jobs={state.jobs}
            truncated={state.truncated}
            archiveDays={EXPORT_LIMITS.archiveDays}
            emptyText="You have not exported this workspace. When you do, it appears here with its progress and, when it is ready, a download link. Exports other people started are not listed: an archive is built with the access rights of whoever asked for it."
          />
        </section>
      </ActionOutcome>
    </div>
  );
}
