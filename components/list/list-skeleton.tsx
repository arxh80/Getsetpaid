// Streaming placeholder for a list, shown while the page query is in flight.
//
// It reserves the table's geometry -- the same header row, the same column
// count, the same 44px-rhythm rows -- so the results do not shove the pager
// down the page when they arrive. `ui-ux-pro-max` § 3 `content-jumping` /
// Core Web Vitals CLS.
//
// NO ANIMATION. DESIGN.md § Motion animates only opacity, background-colour,
// border-colour and translate, and a shimmer is none of those; a pulsing
// skeleton is also on hallmark's anti-pattern list. The placeholder is a
// static rule per row, which reads as "the table is here, the rows are not
// yet" without pretending to be busy.
//
// aria-hidden, with the announcement carried by role="status" on the wrapper:
// twelve rows of decorative bars are noise to a screen reader, and "Loading"
// is the entire content of the message.

export function ListSkeleton({
  columns,
  rows = 8,
}: {
  columns: number;
  rows?: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm text-ink-muted">
        Loading…
      </p>
      <div aria-hidden="true" className="overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            <tr className="border-b border-rule-strong">
              {Array.from({ length: columns }, (_, i) => (
                <td key={i} className="px-3 py-2 first:pl-0 last:pr-0">
                  <span className="block h-4 w-24 bg-shell" />
                </td>
              ))}
            </tr>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} className="border-b border-rule">
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c} className="px-3 py-2 first:pl-0 last:pr-0">
                    <span
                      className="block h-4 bg-shell"
                      // Uneven widths so the placeholder reads as text rather
                      // than as a grid of identical blocks. Deterministic, not
                      // random: a random width would differ between the server
                      // render and the client, which is a hydration mismatch.
                      style={{ width: `${[70, 55, 40, 60][c % 4]}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
