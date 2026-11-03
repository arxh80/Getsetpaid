import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getOwnExportJobs } from "@/lib/export/jobs";
import {
  ACCOUNT_EXPORT_EXCLUDES,
  ACCOUNT_EXPORT_INCLUDES,
  EXPORT_ALREADY_RUNNING,
  EXPORT_LIMITS,
  describeArchiveLife,
} from "@/lib/export/contract";
import { Alert } from "@/components/ui/alert";
import { ActionOutcome } from "@/components/ui/action-outcome";
import { ExportJobList } from "@/components/account/export-job-list";
import { ExportStartForm } from "@/components/account/export-start-form";

export const metadata: Metadata = { title: "A copy of your data · GetSetPaid" };

// PHASE 8 TASK 4 -- the account export (Q132: GetSetPaid is the controller of
// account data). Account-level, beside /account/privacy and
// /account/data-requests, and for the same reason: this is the person's own
// data, not their employer's, so the page sits outside [orgSlug] and reads
// nothing tenant-scoped.
//
// NO STEP-UP HERE, deliberately, and the workspace export next door does have
// one. Asking a person to re-authenticate before they may have a copy of
// their own account data would make exercising a statutory right harder than
// filling in the form that asks us to do it by hand — and the archive is
// theirs alone, reachable only from their own session, behind a link that
// lasts a minute. The workspace export hands out somebody else's whole
// business, which is the "large data export" CLAUDE.md § Session security
// names.
export default async function AccountExportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const state = await getOwnExportJobs("account");
  const live = state.jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          A copy of your data
        </h1>
        <p className="max-w-prose text-lg text-ink-muted">
          Ask us for everything GetSetPaid holds about your account, as a zip of one
          machine-readable JSON file per table. It is prepared in the background and appears
          here when it is ready.
        </p>
      </div>

      <ActionOutcome testId="export-outcome">
        <section aria-labelledby="whats-in-it" className="flex flex-col gap-3">
          <h2 id="whats-in-it" className="text-xl font-bold text-ink">
            What is in it
          </h2>
          <p className="max-w-prose text-base text-ink-muted">{ACCOUNT_EXPORT_INCLUDES}</p>
          <p className="max-w-prose text-base text-ink-muted">{ACCOUNT_EXPORT_EXCLUDES}</p>
          <p className="max-w-prose text-base text-ink-muted">
            Only you can download it, from this page. The link is signed and lasts a minute; the
            archive itself is kept for {describeArchiveLife(EXPORT_LIMITS.archiveDays)} and is then
            removed.
          </p>
          <p className="max-w-prose text-base text-ink-muted">
            You do not need to make a formal request to get this. If you would rather, the{" "}
            <Link
              href="/account/data-requests"
              prefetch={false}
              className="underline underline-offset-4 hover:text-ink"
            >
              data protection requests
            </Link>{" "}
            page is the statutory route, and an export you start here is what answers it.
          </p>
        </section>

        <section aria-labelledby="start-export" className="flex flex-col gap-5">
          <h2 id="start-export" className="text-xl font-bold text-ink">
            Start an export
          </h2>
          {live ? (
            <Alert tone="info" live={false}>
              {EXPORT_ALREADY_RUNNING}
            </Alert>
          ) : null}
          <ExportStartForm
            kind="account"
            disabled={live}
            disabledReason={live ? EXPORT_ALREADY_RUNNING : undefined}
          />
        </section>

        <section aria-labelledby="your-exports" className="flex flex-col gap-5">
          <h2 id="your-exports" className="text-xl font-bold text-ink">
            Your exports
          </h2>
          <ExportJobList
            jobs={state.jobs}
            truncated={state.truncated}
            archiveDays={EXPORT_LIMITS.archiveDays}
            emptyText="You have not asked for a copy of your data. When you do, it appears here with its progress and, when it is ready, a download link."
          />
        </section>
      </ActionOutcome>
    </div>
  );
}
