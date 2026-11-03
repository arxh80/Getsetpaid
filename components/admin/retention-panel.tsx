"use client";

import { useActionState, useId, useState } from "react";
import {
  previewRetentionRunAction,
  releaseAuditCeilingAction,
  setRetentionEnabledAction,
} from "@/lib/admin/retention-actions";
// THE CONTRACT, NOT THE READ. lib/admin/retention.ts is `server-only`;
// importing so much as a TYPE from it here fails the build with
// "'server-only' cannot be imported from a Client Component module".
import {
  sweptLines,
  type RetentionRun,
  type RetentionSettings,
} from "@/lib/admin/retention-contract";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { formatDateTime } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// THE RETENTION JOB, ON THE OPERATOR'S OWN HEALTH PAGE (Phase 8 Task 6,
// requirement 4: "Surface the last run and its outcome on /super/health
// beside the existing counts").
//
// THREE THINGS, IN THE ORDER SOMEBODY LOOKING FOR TROUBLE NEEDS THEM:
//
//   1. THE SWITCHES, and whether they are on. A job that has been off for a
//      month is the first thing to rule out, and the reason the operator
//      typed when they turned it off is right there beside it.
//   2. THE PREVIEW. What a run WOULD remove, with nothing removed — the half
//      of requirement 4 that makes the switches usable, because "turn it back
//      on and find out" is not a decision anybody should have to make about a
//      job that deletes the audit log.
//   3. THE LAST FIVE RUNS, each with its counts and — the column that matters
//      most — what it REFUSED. A sweep that has been refusing its sanity
//      ceiling every hour for a week is invisible in a count of zero and
//      obvious in a refusal.
//
// ZERO IS RENDERED RATHER THAN HIDDEN, for the reason lib/admin/retention.ts's
// sweptLines() gives: "deleted nothing" and "did not run" are different facts
// and a panel that shows only non-zero counts makes them look the same.
//
// THE OUTCOME OF BOTH FORMS LIVES ABOVE THIS COMPONENT, through
// useReportedAction() — both actions revalidate the page, which re-renders
// this panel with a new run in it, and a message held by this component's own
// useActionState would be thrown away by exactly the re-render it caused.

function StatusChip({ run }: { run: RetentionRun }) {
  // STRUCTURAL, NOT CHROMATIC. DESIGN.md: success is told apart from
  // interactive green by shape — a bordered uppercase chip — never by hue,
  // and the danger tone is the only colour carried here.
  const tone =
    run.status === "failed"
      ? "border-danger text-danger"
      : run.status === "refused"
        ? "border-rule text-ink-muted"
        : "border-rule text-ink";
  return (
    <span
      className={`border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${tone}`}
    >
      {run.status}
      {run.mode === "dry" ? " · preview" : ""}
    </span>
  );
}

function RunCard({ run }: { run: RetentionRun }) {
  const lines = sweptLines(run);
  const refusals = Object.entries(run.refused);
  return (
    <li className="flex flex-col gap-2 border-b border-rule py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-base text-ink">{formatDateTime(run.startedAt)}</span>
        <span className="flex items-center gap-2">
          {run.durationMs !== null ? (
            <span className="text-sm text-ink-muted tabular-nums">{run.durationMs} ms</span>
          ) : null}
          <StatusChip run={run} />
        </span>
      </div>

      {refusals.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {refusals.map(([sweep, why]) => (
            <li key={sweep} className="text-sm text-danger">
              <span className="font-semibold">{sweep === "*" ? "the whole run" : sweep}</span>{" "}
              refused: {why}
            </li>
          ))}
        </ul>
      ) : null}

      {lines.length > 0 ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-sm">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt className="border-b border-rule py-1 text-ink-muted">
                {line.label}
                {line.capped ? " (hit its per-run ceiling — a backlog remains)" : ""}
              </dt>
              <dd className="border-b border-rule py-1 text-right text-ink tabular-nums">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function SwitchForm({ settings }: { settings: RetentionSettings }) {
  const reported = useReportedAction(setRetentionEnabledAction);
  const [state, formAction, pending] = useActionState(reported, EMPTY_FORM_STATE);
  const reasonId = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [auditPurge, setAuditPurge] = useState(settings.auditPurgeEnabled);

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-3">
      {/* BOTH SWITCHES TRAVEL ON EVERY SUBMIT. public.set_retention_enabled()
          requires both named, deliberately: a form that posted only the one
          being changed would re-enable the other by omission, which is the
          exact shape of "we stopped the audit purge and it came back on". */}
      <input type="hidden" name="enabled" value={String(enabled)} />
      <input type="hidden" name="auditPurgeEnabled" value={String(auditPurge)} />

      <label className="flex items-start gap-2 text-base text-ink">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-1"
        />
        <span>
          Run the retention job
          <span className="block text-sm text-ink-muted">
            Off stops every sweep. Each refused run is still recorded below, so
            a stopped job never looks like a quiet one.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-base text-ink">
        <input
          type="checkbox"
          checked={auditPurge}
          onChange={(event) => setAuditPurge(event.target.checked)}
          className="mt-1"
        />
        <span>
          Run the audit purge
          <span className="block text-sm text-ink-muted">
            The one sweep that destroys evidence. Turning this off leaves every
            other sweep running.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-1">
        <label htmlFor={reasonId} className="text-base text-ink">
          Why
        </label>
        <input
          id={reasonId}
          name="reason"
          required
          maxLength={500}
          defaultValue=""
          aria-describedby={`${reasonId}-hint`}
          className="border border-rule bg-surface px-3 py-2 text-base text-ink"
        />
        <p id={`${reasonId}-hint`} className="text-sm text-ink-muted">
          Goes into the audit record. A destructive job that was switched off
          with no recorded reason is a decision nobody can reason about later.
        </p>
        {state.fieldErrors?.reason ? (
          <p className="text-sm text-danger">{state.fieldErrors.reason}</p>
        ) : null}
      </div>

      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

// THE CEILING RELEASE (Phase 8 Task 9a, Q184, founder 2026-09-30). The audit
// purge refuses a backlog bigger than a fifth of the log, and since each run
// deletes at most 500 rows that backlog can never shrink on its own. This
// lifts that one check for exactly 3 days -- the floor and the per-run limit
// stay -- and then lapses by itself. While one is active the form is replaced
// by the release it would duplicate: a release cannot be extended.
function CeilingReleaseForm({ release }: { release: RetentionSettings["ceilingRelease"] }) {
  const reported = useReportedAction(releaseAuditCeilingAction);
  const [state, formAction, pending] = useActionState(reported, EMPTY_FORM_STATE);
  const reasonId = useId();

  if (release?.active) {
    return (
      <p className="max-w-prose text-base text-ink" data-testid="ceiling-release-active">
        The audit purge’s sanity ceiling is released until{" "}
        <span className="font-semibold">{formatDateTime(release.expiresAt)}</span> — “
        {release.reason}”. It lapses by itself; the one-year floor and the
        500-row limit per run still apply.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-3">
      <p className="text-sm text-ink-muted" data-testid="ceiling-release-inactive">
        The sanity ceiling is in force: a run refuses when more than a fifth of
        the audit log is due at once. A backlog that size never clears on its
        own. Releasing the ceiling lets runs drain it for 3 days, at most 500
        rows a run, and only rows already past their year.
        {release ? ` The last release ended ${formatDateTime(release.expiresAt)}.` : ""}
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={reasonId} className="text-base text-ink">
          Why release it
        </label>
        <input
          id={reasonId}
          name="reason"
          required
          maxLength={500}
          defaultValue=""
          aria-describedby={`${reasonId}-hint`}
          className="border border-rule bg-surface px-3 py-2 text-base text-ink"
        />
        <p id={`${reasonId}-hint`} className="text-sm text-ink-muted">
          Goes into the audit record.
        </p>
        {state.fieldErrors?.reason ? (
          <p className="text-sm text-danger">{state.fieldErrors.reason}</p>
        ) : null}
      </div>
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? "Releasing…" : "Release the ceiling for 3 days"}
        </Button>
      </div>
    </form>
  );
}

function PreviewForm() {
  const reported = useReportedAction(previewRetentionRunAction);
  const [, formAction, pending] = useActionState(reported, EMPTY_FORM_STATE);
  return (
    <form action={formAction}>
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? "Previewing…" : "Preview the next run"}
      </Button>
    </form>
  );
}

export function RetentionPanel({
  settings,
  runs,
}: {
  settings: RetentionSettings | null;
  runs: readonly RetentionRun[];
}) {
  return (
    <div className="flex flex-col gap-6">
      {settings !== null ? (
        <>
          <p className="max-w-prose text-sm text-ink-muted">
            Last changed {formatDateTime(settings.updatedAt)}
            {settings.reason ? ` — “${settings.reason}”` : " (never changed)"}.
          </p>
          <SwitchForm settings={settings} />
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-ink">Audit purge ceiling</h3>
            <CeilingReleaseForm release={settings.ceilingRelease} />
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <PreviewForm />
        <p className="max-w-prose text-sm text-ink-muted">
          A preview counts what every sweep would remove and removes nothing —
          no rows, no stored files. It appears below marked{" "}
          <span className="font-semibold">preview</span>.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-ink">Recent runs</h3>
        {runs.length === 0 ? (
          <p className="max-w-prose text-sm text-ink-muted" data-testid="retention-no-runs">
            No run has been recorded yet. The job runs about once an hour on
            the platform clock; a deployment with no runner URL configured will
            never record one.
          </p>
        ) : (
          <ul className="flex max-w-prose flex-col" data-testid="retention-runs">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
