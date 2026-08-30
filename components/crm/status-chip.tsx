import {
  STATUS_LABELS,
  STATUS_TONE,
  type EventStatus,
  type EventStatusTone,
} from "@/lib/crm/event-status";

// The event status chip.
//
// ===========================================================================
// THE LABEL IS THE INFORMATION; THE COLOUR IS REINFORCEMENT
// ===========================================================================
// DESIGN.md § Working palette: "Status must never be colour-only -- always
// pair with a text label or shape. Colour-blind users and greyscale printing
// both need it." So `STATUS_LABELS[status]` is rendered unconditionally and
// there is no icon-only or dot-only variant of this component to reach for.
// Printed in greyscale, or read by somebody who cannot separate the green from
// the red, the chip still says "Cancelled".
//
// ===========================================================================
// A HAIRLINE BOX, NOT A FILLED PILL, AND THAT IS DESIGN.md RATHER THAN TASTE
// ===========================================================================
//   * `--radius: 0`. Square corners everywhere. A "pill" is the shape this
//     component is named after in every other CRM and it is the one shape this
//     product does not have.
//   * No shadow, no gradient. "Structure from hairline rules and typographic
//     weight."
//   * `border-current`, so the border is the same token as the text and one
//     tone decides both. The alternative -- a coloured FILL behind the label --
//     would need a second measured ratio per tone for the label on top of it,
//     and for `--accent` DESIGN.md forbids it outright ("never a fill behind a
//     label").
//
// EVERY TONE IS AN EXISTING TOKEN WITH A MEASURED RATIO, so this component
// adds no colour and `python scripts/contrast.py` is unchanged by it. On the
// shell: ink 17.01:1, ink-muted 6.84:1, success 7.13:1, warning 6.62:1,
// danger 7.41:1 (DESIGN.md § Working palette). The chip renders inside the
// list table, whose ground is `--surface` (#FFFFFF) -- lighter than the shell
// those ratios were measured against, so each is at least as high there.
// Borders need 3:1 and the lowest of the five clears it twice over.
//
// A `<span>`, NOT A `<button>` AND NOT A LINK. Nothing about a status chip is
// interactive; the way to filter by status is the toolbar's Status control,
// which is a real form control with a real label.

/**
 * Tone -> tokens. The one place a tone becomes a colour.
 *
 * A `Record` keyed on the tone union, so a sixth tone added to
 * `EventStatusTone` is a compile error here rather than an undefined class
 * string that renders as unstyled text.
 */
const TONE_CLASS: Record<EventStatusTone, string> = {
  muted: "text-ink-muted",
  ink: "text-ink",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function StatusChip({ status }: { status: EventStatus }) {
  return (
    <span
      className={
        "inline-flex items-center border border-current px-2 py-0.5 " +
        "text-xs font-semibold tracking-wide uppercase whitespace-nowrap " +
        TONE_CLASS[STATUS_TONE[status]]
      }
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
