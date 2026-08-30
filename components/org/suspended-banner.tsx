// The read-only banner for a suspended workspace.
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
//   2. Why: it is suspended by the platform.
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

export function SuspendedBanner({ orgName }: { orgName: string }) {
  return (
    <div
      role="status"
      className="border-b border-rule-strong bg-surface"
      data-testid="suspended-banner"
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-3">
        <p className="text-base text-ink">
          <span className="font-semibold text-warning">Read-only.</span>{" "}
          <span className="font-semibold break-words">{orgName}</span> is
          suspended, so nothing in it can be added, edited or deleted. Everything
          already here is still visible and still yours.
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Contact GetSetPaid support to have the workspace reinstated. It can’t
          be reversed from inside the workspace, whatever your role.
        </p>
      </div>
    </div>
  );
}
