import { formatDateTime } from "@/lib/format/date";

// THE IMPERSONATION BANNER (Phase 7 Task 2).
//
// Task brief: "Every org-scoped page the superuser reaches during
// impersonation must be visibly bannered ('Viewing as… / session ends at…')
// so support access is never mistaken for normal use."
//
// ===========================================================================
// WHO IT IS FOR
// ===========================================================================
// The SUPERUSER, not the customer -- the customer's own members never see it,
// because it renders only when getCurrentOrg() resolved this workspace through
// an impersonation session rather than a membership, which by construction
// only ever happens for the impersonator. Its job is to stop a support session
// being mistaken for the operator's own workspace: every list on the page
// looks exactly like a workspace they belong to, and the one difference that
// matters -- that a customer consented to this for the next N minutes and it
// is all on the record -- is invisible without it.
//
// ===========================================================================
// IT SAYS THE END TIME, NOT A COUNTDOWN
// ===========================================================================
// A live countdown would be a Client Component ticking every second on every
// page of the session, and it would be WRONG the moment the tab is
// backgrounded or the clock skews -- while implying a precision the enforcement
// does not have (the database compares expires_at to ITS now(), on every
// permission check). An absolute time, rendered in UK local time like every
// other timestamp in the product (CLAUDE.md § Non-negotiable rules), is both
// honest and static.
//
// The session does NOT end with a warning or a redirect. At expires_at the
// grant simply stops and the next org route renders the ordinary
// tenant-isolation 404 -- see lib/admin/impersonation-session.ts. That is
// stated in the second line so it does not read as a bug when it happens.
//
// ===========================================================================
// role="status", NOT "alert" -- AND NOT DISMISSIBLE
// ===========================================================================
// Both for the reasons components/org/suspended-banner.tsx gives for the
// identical choices: this is a standing fact about the whole workspace,
// present on first paint of every route, so assertive announcement would
// interrupt a screen-reader user on every navigation; and a banner that can be
// dismissed is a banner that gets dismissed, which is the one outcome this
// banner exists to prevent.
//
// Tone is --danger, a TEXT colour on a --surface panel, and the word
// "Support access" carries the state for anyone who cannot see the colour
// (DESIGN.md: "status must never be colour-only").

export function ImpersonationBanner({
  orgName,
  expiresAt,
}: {
  orgName: string;
  /** ISO instant, from the database's own expires_at. */
  expiresAt: string | null;
}) {
  return (
    <div
      role="status"
      className="border-b border-rule-strong bg-surface"
      data-testid="impersonation-banner"
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-3">
        <p className="text-base text-ink">
          <span className="font-semibold text-danger">Support access.</span>{" "}
          You are viewing{" "}
          <span className="font-semibold break-words">{orgName}</span> as
          GetSetPaid support, read-only, with this workspace’s permission.
          {expiresAt ? (
            <>
              {" "}
              This session ends at{" "}
              <span className="font-semibold tabular-nums">
                {formatDateTime(expiresAt)}
              </span>
              .
            </>
          ) : null}
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Every page you open here is recorded against this session. Nothing can
          be created, edited or deleted. When the time runs out the workspace
          simply stops resolving — that is the session ending, not an error.
        </p>
      </div>
    </div>
  );
}
