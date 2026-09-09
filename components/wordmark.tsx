import { WORD_PATH, WORD_VIEWBOX } from "@/components/wordmark.paths";

// The wordmark.
//
// This file used to argue that inventing a mark for a product that had not
// commissioned one would be exactly the kind of invented content the brief
// warns against, and set the name in Source Serif 4 at 800 instead. That was
// right until the founder supplied real artwork; it is not any more.
//
// WHY THE MARK IS NOT HERE. The logo has one, and it is deliberately absent
// from the header. Its strokes are about 1.5% of its height, so anywhere
// below roughly 40px they fall under a single pixel and it renders as a green
// smudge rather than a drawn outline -- checked against the source PNG, which
// degrades identically, so this is the artwork's limit and not a fault in the
// trace. The mark ships in app/icon.svg at 32px and up, where it resolves.
// If a solid-fill variant of the mark is ever commissioned, that is the point
// at which it can join this lockup.
//
// INLINE SVG RATHER THAN A WEBFONT: the wordmark's ultra-condensed grotesque
// is artwork, not a UI typeface. Outlining it means no second font request
// for one word, and no approximation -- nothing freely licensable is that
// compressed.
//
// THIS IS THE ONLY CONDENSED THING IN THE PRODUCT. Source Serif 4 runs every
// heading, every table, every label. Do not "match the brand font" anywhere
// else; DESIGN.md § Type says so too.
//
// fillRule="evenodd" IS LOAD-BEARING: every enclosed counter in G, E, S, P, A,
// D and the full stop is its own contour, and a fill rule that filled them
// would render the word as a row of solid blocks.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span role="img" aria-label="GetSetPaid" className={className}>
      <svg
        viewBox={WORD_VIEWBOX}
        className="h-4 w-auto fill-current text-ink"
        aria-hidden="true"
        focusable="false"
      >
        <path d={WORD_PATH} fillRule="evenodd" />
      </svg>
    </span>
  );
}
