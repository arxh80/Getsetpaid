// The one skeleton primitive every loading surface is built from.
//
// A bone is a block of --color-shell that breathes to --color-pink and back
// (the `animate-skeleton` utility, defined in app/globals.css @theme). That
// is the whole shimmer: a background-colour crossfade between two surface
// tokens already in DESIGN.md -- no gradient (forbidden), no new colour, and
// background-color is on § Motion's short list of animatable properties.
// Under prefers-reduced-motion the animation is removed outright (globals.css
// -- see the strobe note there) and the bone rests static at bg-shell.
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
          ? `block animate-skeleton bg-shell ${className}`
          : "block animate-skeleton bg-shell"
      }
    />
  );
}
