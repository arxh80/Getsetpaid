import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import { getLatestClosureBackup, getOwnExportJobs, partsPageFor } from "@/lib/export/jobs";
import {
  EXPORT_ALREADY_RUNNING,
  EXPORT_LIMITS,
  WORKSPACE_EXPORT_EXCLUDES,
  WORKSPACE_EXPORT_INCLUDES,
  describeArchiveLife,
  parsePartsCursor,
  partsCursorParam,
} from "@/lib/export/contract";
import { Alert } from "@/components/ui/alert";
import { ActionOutcome } from "@/components/ui/action-outcome";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { ExportJobList, type JobParts } from "@/components/account/export-job-list";
import { ExportStartForm } from "@/components/account/export-start-form";
import { CloseWorkspaceForm } from "@/components/org/close-workspace-form";
import {
  CLOSE_SECTION_ID,
  CLOSURE_BACKUP_FAILED_LINE,
  closureBackupHelpHref,
} from "@/lib/org/closure-contract";
import { supportContact } from "@/lib/legal/contact";
import { ORGANISATION_RETENTION_DAYS } from "@/lib/admin/lifecycle-contract";

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
  searchParams,
}: PageProps<"/[orgSlug]/settings/export">) {
  const { orgSlug } = await params;
  const { parts: rawParts } = await searchParams;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  // Q228: the parts list is paginated; `?parts=<jobId>:<n>` is the keyset
  // cursor of ONE job's list, so every other backup stays on its first page.
  // A malformed value is page one, not an error.
  const partsCursor = parsePartsCursor(typeof rawParts === "string" ? rawParts : null);

  // PHASE 8 TASK 9c JOB 3b (below) decides who may close; the same facts decide
  // who is offered "Contact us" when the closure backup failed.
  const isOwner = org.role === "owner" && !org.isImpersonated;
  const ownerClosed = org.lifecycle?.state === "owner_closed";

  // One round of reads, no waterfall: the permission, the Owner's own jobs,
  // and (only for the Owner of a workspace they closed) the latest closure
  // backup. Every read is under the caller's own RLS and bounded.
  const [mayExport, state, latestClosure] = await Promise.all([
    hasPermission(org.id, "export_organisation_data"),
    getOwnExportJobs("workspace", org.id),
    isOwner && ownerClosed ? getLatestClosureBackup(org.id) : Promise.resolve(null),
  ]);
  const live = state.jobs.some((j) => j.status === "queued" || j.status === "running");

  // One page of parts for every listed multi-part job (at most
  // OWN_EXPORT_LIMIT jobs, PARTS_PAGE_SIZE parts each): the page the cursor
  // names for its own job, the first for every other, and the first again
  // when the named page is empty (partsPageFor).
  const partsEntries = await Promise.all(
    state.jobs
      .filter((j) => j.partCount > 1)
      .map(async (j): Promise<[string, JobParts]> => {
        const page = await partsPageFor(j.id, partsCursor);
        return [j.id, { ...page, total: j.partCount }];
      }),
  );
  const parts: Record<string, JobParts> = Object.fromEntries(partsEntries);

  // PHASE 8 TASK 9c JOB 3b: "Close this workspace" (founder 2026-09-30,
  // Q176/Q178). OWNER ONLY, and not rendered at all for anyone else -- not a
  // disabled control: closing is not a thing a non-Owner can be granted, so
  // there is nothing to explain. Hiding it is not the enforcement either:
  // lib/org/closure-actions.ts re-checks the Owner, step-up and aal2, and
  // public.close_my_workspace() checks the active `owner` membership row and
  // aal2 in the database. An impersonating superuser's role is the read_only
  // envelope, so they never see it. A workspace the PLATFORM suspended or
  // closed shows nothing (the Owner cannot close what is already read-only);
  // one its Owner closed keeps the section with a statement in place of the
  // form (the confirmation itself is in the ActionOutcome region above).
  const showClose = isOwner && (!org.isSuspended || ownerClosed);

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
            parts={parts}
            partsHref={(jobId, from) =>
              from <= 1
                ? `/${orgSlug}/settings/export`
                : `/${orgSlug}/settings/export?parts=${encodeURIComponent(partsCursorParam(jobId, from))}`
            }
            emptyText="You have not exported this workspace. When you do, it appears here with its progress and, when it is ready, a download link. Exports other people started are not listed: an archive is built with the access rights of whoever asked for it."
          />
        </section>

        {showClose ? (
          <section
            id={CLOSE_SECTION_ID}
            aria-labelledby="close-workspace-heading"
            className="flex flex-col gap-4 border-t border-rule pt-8"
          >
            <h2 id="close-workspace-heading" className="text-xl font-bold text-ink">
              Close this workspace
            </h2>
            <p className="max-w-prose text-base text-ink-muted">
              Only an Owner can do this. It is how you leave GetSetPaid with {org.name}, or delete
              your own account while you are its only Owner. What happens:
            </p>
            <ul className="flex max-w-prose list-disc flex-col gap-2 pl-5 text-base text-ink-muted">
              <li>
                The workspace becomes <span className="font-semibold text-ink">read-only</span>{" "}
                at once for everyone in it. They can still see everything, and a banner tells
                them you closed it and why. It leaves the network directory.
              </li>
              <li>
                A <span className="font-semibold text-ink">full backup</span> of the workspace
                is taken automatically, as you could see it the moment before you closed it (a
                colleague&apos;s private notes are not in it), and kept for as long as the
                workspace is.
              </li>
              <li>
                The backup is <span className="font-semibold text-ink">yours to download</span>,
                from this page, before you delete your account. Nobody else can download it —
                not a new Owner if the workspace is reopened (they can take their own export),
                and not GetSetPaid.
              </li>
              <li>
                GetSetPaid is told, and decides: either the workspace is handed to one of its
                active members as the new Owner, which reopens it, or it is deleted permanently.
                Its remaining Owners and Admins are emailed the decision. If it is deleted, your
                backup stays downloadable from your account&apos;s exports for up to{" "}
                <span className="tabular-nums">30</span> days, and the records are removed once
                you have downloaded it or that time has passed.
              </li>
              <li>
                If nobody decides, it is deleted{" "}
                <span className="tabular-nums">{ORGANISATION_RETENTION_DAYS}</span> days after
                you close it.
              </li>
              <li>You cannot reopen it yourself from inside the workspace.</li>
            </ul>
            {ownerClosed ? (
              <>
                <p className="max-w-prose text-base text-ink" data-testid="close-workspace-done">
                  {org.name} is closed. It is read-only for everyone in it while GetSetPaid decides
                  whether to hand it to a new Owner or delete it.
                </p>
                {latestClosure?.status === "failed" ? (
                  <div
                    className="flex max-w-prose flex-col items-start gap-3"
                    data-testid="closure-backup-failed"
                  >
                    <p className="text-base text-ink">{CLOSURE_BACKUP_FAILED_LINE}</p>
                    {/* The `secondary` button variant, copied class for class from
                        components/ui/button.tsx: it is a link (a mailto or a
                        page), so it cannot be a <Button>. Square, no shadow,
                        tokens only. The subject carries the slug and the job
                        id and nothing else. */}
                    <a
                      href={closureBackupHelpHref(
                        supportContact().address,
                        org.slug,
                        latestClosure.id,
                      )}
                      className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink hover:border-ink hover:bg-shell"
                    >
                      Contact us
                    </a>
                  </div>
                ) : null}
              </>
            ) : (
              // CLAUDE.md § Session security: "deleting organisation data" is
              // a step-up trigger. The action re-checks it server-side either way.
              <StepUpGate next={`/${orgSlug}/settings/export#${CLOSE_SECTION_ID}`}>
                <CloseWorkspaceForm orgSlug={org.slug} />
              </StepUpGate>
            )}
          </section>
        ) : null}
      </ActionOutcome>
    </div>
  );
}
