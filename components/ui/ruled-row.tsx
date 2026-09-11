import type { ReactNode } from "react";

// ===========================================================================
// The ruled row -- this product's one structural signature.
//
// A door list. An advance sheet. A run of show. Every operational document in
// live events is a ruled list where a name on the left is joined by a rule to
// a status on the right, and that is the shape reused here: for members, for
// pending invitations, for the workspace list. It is not decoration -- the
// rule is what makes a long list scannable, and it is the only structural
// device DESIGN.md allows ("structure from hairline rules and typographic
// weight", no shadows, no cards-within-cards).
//
// It also answers the brief's "one consistent timeline/activity component
// reused across every entity" requirement early: this is that primitive, and
// later entity lists should extend it rather than inventing a second one.
//
// RESPONSIVE: the connecting rule is a flex spacer, so it collapses to nothing
// on a narrow screen and the row stacks. `min-w-0` on the label column is what
// lets a long email truncate instead of forcing the page horizontally.
// ===========================================================================

export function RuledList({ children }: { children: ReactNode }) {
  // border-t on the list plus border-b on each row gives hairlines between
  // rows AND at both ends, with no doubled 2px seam.
  return <ul className="border-t border-rule">{children}</ul>;
}

export function RuledRow({
  title,
  meta,
  status,
  action,
}: {
  /** The primary identifier -- a name, an email, a workspace. */
  title: ReactNode;
  /** Secondary detail under the title. */
  meta?: ReactNode;
  /** Right-aligned status, always a text label (never colour alone). */
  status?: ReactNode;
  /** Right-aligned control. */
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-rule py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-base font-semibold text-ink">{title}</span>
        {meta ? <span className="text-sm text-ink-muted">{meta}</span> : null}
      </div>

      {/* The rule that joins name to status. Purely presentational, so it is
          hidden from assistive tech -- announcing a decorative line between
          every pair of cells would make the list unlistenable. */}
      <span
        aria-hidden="true"
        className="hidden h-px min-w-6 flex-1 self-center bg-rule sm:block"
      />

      {status ? <span className="text-sm text-ink-muted">{status}</span> : null}
      {action ? <div className="ml-auto sm:ml-0">{action}</div> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Status chip.
//
// Text first, colour second. The label is the signal; the colour is a
// reinforcement that a colour-blind user or a greyscale printout can lose
// without losing the meaning. The SHAPE matters too: --success shares its
// value with --primary, so a bordered, labelled box is what tells a status
// chip from an interactive control -- never the hue (DESIGN.md § Palette).
// ---------------------------------------------------------------------------
type ChipTone = "active" | "pending" | "revoked";

const CHIPS: Record<ChipTone, string> = {
  active: "border-success text-success",
  pending: "border-warning text-warning",
  revoked: "border-rule text-ink-muted",
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-block border px-2 py-1 text-xs font-semibold uppercase tracking-[0.04em] ${CHIPS[tone]}`}
    >
      {children}
    </span>
  );
}
