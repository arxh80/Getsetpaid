import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveMemberships, getCurrentUser } from "@/lib/auth";
import { closeWorkspacePath } from "@/lib/org/closure-contract";
import { getOwnErasureBlockers, getOwnErasureJobs } from "@/lib/erasure/jobs";
import {
  ACCOUNT_ERASE_PATH,
  ERASURE_ALREADY_RUNNING,
  ERASURE_DELETES,
  ERASURE_EMPTY_WORKSPACE_NOTE,
  ERASURE_KEEPS,
  describeBlockers,
} from "@/lib/erasure/contract";
import { Alert } from "@/components/ui/alert";
import { ActionOutcome } from "@/components/ui/action-outcome";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { ErasureForm } from "@/components/account/erasure-form";
import { ErasureJobList } from "@/components/account/erasure-job-list";

export const metadata: Metadata = { title: "Delete your account · GetSetPaid" };

// PHASE 8 TASK 5 -- account erasure (Q130 the tombstone, Q131 the last-owner
// guard, Q158 the register that survives). Account-level, beside
// /account/privacy, /account/data-requests and /account/exports, and for the
// same reason: this is the person's own account, not their employer's.
//
// STEP-UP HERE, where the export next door has none: CLAUDE.md § Session
// security names "deleting organisation data", and this is the one
// irreversible action in the product. An export hands a person a copy of what
// they already have; this takes it away for ever.
//
// WHAT THE PAGE IS FOR, before it is a button: saying plainly and
// specifically what goes, what stays and why. Both lists live in
// lib/erasure/contract.ts so that what the database actually does and what
// the person is told are edited in the same commit, and so the e2e assertion
// and the page cannot drift.
export default async function AccountErasePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // BOTH READS FAIL LOUDLY. An empty blocker list means "nothing is in the
  // way", and answering that because a query failed would offer somebody a
  // button that is going to refuse.
  const [blockers, jobs, memberships] = await Promise.all([
    getOwnErasureBlockers(),
    getOwnErasureJobs(),
    getActiveMemberships(),
  ]);
  const blocked = describeBlockers(blockers);
  // Phase 8 Task 9c job 3b: the Q131 refusal tells an Owner they may close
  // the workspace, so link each blocking workspace they OWN straight to the
  // close section. my_erasure_blockers() returns names only, so the match is
  // by name against the caller's own active Owner memberships -- a link the
  // caller could not use is never rendered (the close action re-checks).
  const ownedBlockerNames = new Set(
    blockers.filter((b) => b.reason !== "no_owner_to_transfer").map((b) => b.organisationName),
  );
  const closable = memberships.filter(
    (m) => m.role === "owner" && ownedBlockerNames.has(m.organisation.name),
  );
  const live = jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Delete your account
        </h1>
        <p className="max-w-prose text-lg text-ink-muted">
          Ask us to delete your GetSetPaid account. This cannot be undone, and we cannot bring
          it back afterwards.
        </p>
      </div>

      <ActionOutcome testId="erasure-outcome">
        <section aria-labelledby="what-goes" className="flex flex-col gap-3">
          <h2 id="what-goes" className="text-xl font-bold text-ink">
            What is deleted
          </h2>
          <ul className="flex max-w-prose list-disc flex-col gap-2 pl-5 text-base text-ink-muted">
            {ERASURE_DELETES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="max-w-prose text-base text-ink-muted">
            {ERASURE_EMPTY_WORKSPACE_NOTE}
          </p>
        </section>

        <section aria-labelledby="what-stays" className="flex flex-col gap-3">
          <h2 id="what-stays" className="text-xl font-bold text-ink">
            What is kept, and why
          </h2>
          <ul className="flex max-w-prose list-disc flex-col gap-2 pl-5 text-base text-ink-muted">
            {ERASURE_KEEPS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="max-w-prose text-base text-ink-muted">
            The{" "}
            <Link
              href="/legal/data-subject-rights"
              prefetch={false}
              className="underline underline-offset-4 hover:text-ink"
            >
              data subject rights
            </Link>{" "}
            page says the same thing in full, and the{" "}
            <Link
              href="/account/exports"
              prefetch={false}
              className="underline underline-offset-4 hover:text-ink"
            >
              copy of your data
            </Link>{" "}
            page is where to take a copy first. Once your account is gone you cannot ask for
            one.
          </p>
        </section>

        <section aria-labelledby="do-it" className="flex flex-col gap-5">
          <h2 id="do-it" className="text-xl font-bold text-ink">
            Delete it
          </h2>
          {blocked ? (
            <Alert tone="info" live={false}>
              {blocked}
            </Alert>
          ) : null}
          {closable.length > 0 ? (
            <ul className="flex max-w-prose flex-col gap-1 text-base" data-testid="erasure-close-links">
              {closable.map((m) => (
                <li key={m.organisation.id}>
                  <Link
                    href={closeWorkspacePath(m.organisation.slug)}
                    prefetch={false}
                    className="underline underline-offset-4 hover:text-ink"
                  >
                    Close {m.organisation.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {live ? (
            <Alert tone="info" live={false}>
              {ERASURE_ALREADY_RUNNING}
            </Alert>
          ) : null}
          {/* The gate is around the FORM, not the page: somebody reading what
              will happen should not be asked to re-authenticate to read it. */}
          <StepUpGate next={ACCOUNT_ERASE_PATH}>
            <ErasureForm
              disabled={live || blocked !== null}
              disabledReason={live ? ERASURE_ALREADY_RUNNING : (blocked ?? undefined)}
            />
          </StepUpGate>
        </section>

        <section aria-labelledby="your-requests" className="flex flex-col gap-5">
          <h2 id="your-requests" className="text-xl font-bold text-ink">
            What you have asked for
          </h2>
          <ErasureJobList
            jobs={jobs}
            emptyText="You have not asked us to delete your account. If you do, its progress appears here — and if anything stops it, this is where the reason is."
          />
        </section>
      </ActionOutcome>
    </div>
  );
}
