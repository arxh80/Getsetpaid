// The one skeleton primitive every loading surface is built from.
//
// A bone is a block of --color-rule that breathes to --color-pink and back
// (the `animate-skeleton` utility, defined in app/globals.css @theme). That
// is the whole shimmer: a background-colour crossfade between two tokens
// already in DESIGN.md -- no gradient (forbidden), no new colour, and
// background-color is on § Motion's short list of animatable properties.
// Under prefers-reduced-motion the animation is removed outright (globals.css
// -- see the strobe note there) and the bone rests static at bg-rule.
//
// WHY THE REST IS --rule AND NOT --shell (review finding I1): --shell IS the
// page background, so a shell bone at the loop's rest points -- and, frozen,
// for every reduced-motion user -- was invisible: a blank page where the
// skeleton should be. --rule is the existing hairline token, visible on both
// grounds a bone sits on (the --shell page and a --surface card). Decorative
// fill only; the loading MESSAGE is role="status" text, never the colour.
//
// A bone is DECORATION. It never carries text, never receives focus, and is
// always inside a container the composing component has marked
// aria-hidden="true", with the actual announcement carried by one
// role="status" "Loading…" element per surface (the pattern the original
// list-skeleton established). Bones therefore ship no ARIA of their own.
//
// Shape comes from the caller: width/height via className (h-4 w-24, w-3/4,
// ...). Deterministic widths only -- a random width differs between the
// server render and the client, which is a hydration mismatch.

export function Bone({ className }: { className?: string }) {
  return (
    <span
      className={
        className
          ? `block animate-skeleton bg-rule ${className}`
          : "block animate-skeleton bg-rule"
      }
    />
  );
}
