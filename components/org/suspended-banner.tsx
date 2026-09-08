import type { CurrentOrg } from "@/lib/auth";
import {
  ORGANISATION_RETENTION_DAYS,
  daysUntil,
} from "@/lib/admin/lifecycle-contract";
import { formatDateTime } from "@/lib/format/date";

// The read-only banner for a wound-down workspace.
//
// DECISIONS-QUEUE Q6 (founder, 2026-08-28) made suspension READ-ONLY. The
// database has done that since 20260828210000 and nothing a customer could see
// reflected it: `getCurrentOrg()` filtered soft-deleted organisations out, so
// the switcher listed the workspace and the workspace 404'd. This is the half
// that was owed.
//
// ===========================================================================
// FOUR THINGS IT HAS TO SAY, AND ONE IT MUST NOT
// ===========================================================================
//   1. The workspace is read-only. Stated first, in the first clause.
//   2. Why: it is suspended (or closed) by the platform.
//   3. That their data is still there and still theirs to read. This is the
//      whole content of Q6 -- the decision the founder made was specifically
//      that a suspended customer keeps sight of their records.
//   4. Who can change it.
//
// AND IT MUST NOT IMPLY THE USER CAN FIX IT. `manage_organisation` is a write
// and does not survive suspension (public.permissions), so an Owner genuinely
// cannot un-suspend their own workspace -- consequence P7, which the Task 3a
// brief forbids designing around, because a self-service undo would make
// suspension meaningless. The copy names support rather than "an Owner".
//
// ===========================================================================
// PHASE 7 TASK 3: IT IS ALSO THE NOTIFICATION
// ===========================================================================
// CLAUDE.md § Superuser dashboard says suspending and deleting "notify the
// org's admin". There is no notification subsystem at MVP (Q45, for the fourth
// time after `reminder_at`, connection requests and impersonation requests),
// so THIS IS THE NOTIFICATION -- which is why it now carries the four facts
// the task brief names rather than one sentence:
//
//   * WHAT happened (suspended, or closed) and WHEN;
//   * how long the data is KEPT (the 60-day retention deadline, Q88);
//   * what the NETWORK can still see, and until when (Q88's period-end rule
//     for a suspension; nothing at all for a closure, Q101);
//   * that it can be REVERSED, and by whom.
//
// It is shown to EVERY member, not only to admins. That is deliberate and it
// is the Q6 argument again: the people who will notice that saving stopped
// working are the people using the workspace, and a read-only product with an
// explanation only its Owner can see is a product that looks broken to
// everybody else.
//
// ===========================================================================
// NOT DISMISSIBLE, AND NOT AN `alert`
// ===========================================================================
// Not dismissible because the condition does not go away while the page is
// open, and a banner that can be dismissed is a banner people dismiss and then
// wonder why nothing saves.
//
// `role="status"`, not `role="alert"`. Assertive is for something that just
// happened in response to something the user did; this is a standing fact
// about the workspace, present on first paint of every route, and announcing
// it assertively would interrupt whatever a screen-reader user is reading on
// every single navigation. The heading and the position (immediately after the
// header, before <main>'s content) carry the prominence instead.
//
// The tone is --warning, which is a TEXT colour here on a --surface panel; the
// word "Read-only" carries the state for anyone who cannot see the colour, per
// DESIGN.md's "status must never be colour-only".

export function SuspendedBanner({
  orgName,
  lifecycle,
}: {
  orgName: string;
  /** null when the caller could not be told which state (see
   *  CurrentOrg.lifecycle) -- the banner then degrades to the sentence it
   *  carried before Phase 7 Task 3, which is still true. */
  lifecycle: CurrentOrg["lifecycle"];
}) {
  const closed = lifecycle?.state === "deleted";
  const retentionDays = daysUntil(lifecycle?.retentionExpiresAt ?? null);

  return (
    <div
      role="status"
      className="border-b border-rule-strong bg-surface"
      data-testid="suspended-banner"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 py-3">
        <p className="text-base text-ink">
          <span className="font-semibold text-warning">Read-only.</span>{" "}
          <span className="font-semibold break-words">{orgName}</span> is{" "}
          {closed ? "closed" : "suspended"}
          {lifecycle?.changedAt ? (
            <>
              {" "}
              as of{" "}
              <span className="tabular-nums">
                {formatDateTime(lifecycle.changedAt)}
              </span>
            </>
          ) : null}
          , so nothing in it can be added, edited or deleted. Everything already
          here is still visible and still yours.
        </p>

        {/* WHAT THE NETWORK SEES. Only for a suspension, and only when we know
            the date: Q88 keeps a suspended workspace in the directory until
            its subscription period ends, and Q101 takes a closed one out at
            once. "about" is honest rather than vague -- for organisations that
            predate 20260908000000 the period end is a backfilled placeholder
            (Phase 7 Task A, ledger note M2), so the day is not guaranteed. */}
        {lifecycle && !closed && lifecycle.networkPresenceUntil ? (
          <p className="text-sm text-ink-muted">
            Other businesses can still find this workspace in the network
            directory until about{" "}
            <span className="tabular-nums">
              {formatDateTime(lifecycle.networkPresenceUntil)}
            </span>
            .
          </p>
        ) : null}
        {closed ? (
          <p className="text-sm text-ink-muted">
            This workspace is no longer listed in the network directory. Nothing
            has been deleted.
          </p>
        ) : null}

        {/* HOW LONG THE DATA IS KEPT. The deadline and the days remaining,
            because "until 7 November" and "in 12 days" do different jobs -- one
            is the fact, the other is the urgency. */}
        {lifecycle?.retentionExpiresAt ? (
          <p className="text-sm text-ink-muted">
            Your data is kept until{" "}
            <span className="tabular-nums">
              {formatDateTime(lifecycle.retentionExpiresAt)}
            </span>
            {retentionDays !== null ? (
              <>
                {" "}
                (<span className="tabular-nums">{retentionDays}</span>{" "}
                {retentionDays === 1 ? "day" : "days"})
              </>
            ) : null}
            , and the workspace can be reopened in full up to then.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">
            Your data is kept for{" "}
            <span className="tabular-nums">{ORGANISATION_RETENTION_DAYS}</span>{" "}
            days, and the workspace can be reopened in full.
          </p>
        )}

        <p className="text-sm text-ink-muted">
          Contact GetSetPaid support to have the workspace reinstated. It can’t
          be reversed from inside the workspace, whatever your role.
        </p>
      </div>
    </div>
  );
}
