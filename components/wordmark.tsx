// The wordmark.
//
// Type only -- no logotype file, no icon. DESIGN.md's direction is "structure
// from hairline rules and typographic weight", and inventing a mark for a
// product that has not commissioned one would be exactly the kind of invented
// content the brief warns against. Source Serif 4 at 800 with a tightened
// tracking is the identity until a real mark exists.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`tracking-display text-xl font-extrabold text-ink ${className}`}
    >
      GetSetPaid
    </span>
  );
}
