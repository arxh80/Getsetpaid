import {
  VISIBILITY_LABELS,
  VISIBILITY_TONE,
  type VisibilityLevel,
} from "@/lib/network/fields";

// The hidden / network / connections chip -- THE MOST CONSEQUENCE-BEARING
// STATUS INDICATOR IN THE PRODUCT (the plan's own words). DESIGN.md's status
// rule ("never colour alone") is the floor for every chip in this codebase;
// this one clears a higher bar the plan sets deliberately: "the visibility
// state additionally needs a non-colour cue... a user misreading a coloured
// dot publishes their address."
//
// So there are THREE independent signals, not two:
//   1. THE WORD.  "Hidden" / "Connections only" / "Everyone on the network" --
//      sufficient on its own, and what a screen reader announces.
//   2. THE COLOUR. muted / active / warning, reusing lib/network/fields.ts's
//      VISIBILITY_TONE -- the same three DESIGN.md tokens every other chip in
//      the product draws from, so no row is added to scripts/contrast.py.
//   3. THE SHAPE. Three genuinely different glyphs -- a hollow square, a
//      diamond, a filled circle -- not three shades of one dot. A colour-blind
//      or low-vision reader distinguishes them by OUTLINE, not by how
//      saturated the fill looks, which a shared-shape "dot gets bigger and
//      darker" scheme would not survive. `aria-hidden`: the glyph reinforces
//      the word for a SIGHTED, HURRIED reader scanning a column of chips; it
//      adds no information a screen reader needs beyond the label already in
//      the chip's text.
const GLYPH: Record<VisibilityLevel, string> = {
  hidden: "▢",
  connections: "◆",
  network: "●",
};

const TONE_CLASS: Record<
  (typeof VISIBILITY_TONE)[VisibilityLevel],
  string
> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

const CHIP =
  "inline-flex items-center gap-1.5 border px-2 py-0.5 " +
  "text-xs font-semibold tracking-wide uppercase whitespace-nowrap ";

export function VisibilityChip({ level }: { level: VisibilityLevel }) {
  return (
    <span className={CHIP + TONE_CLASS[VISIBILITY_TONE[level]]}>
      <span aria-hidden="true">{GLYPH[level]}</span>
      {VISIBILITY_LABELS[level]}
    </span>
  );
}
