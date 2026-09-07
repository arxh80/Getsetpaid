import { Bone } from "@/components/skeleton/bone";

// Streaming placeholder for a list, shown while the page query is in flight.
//
// It reserves the table's geometry -- the same header row, the same column
// count, the same 44px-rhythm rows -- so the results do not shove the pager
// down the page when they arrive. `ui-ux-pro-max` § 3 `content-jumping` /
// Core Web Vitals CLS.
//
// SHIMMER, SINCE THE LOADING-SKELETONS PASS. This file originally shipped
// static on the argument that DESIGN.md § Motion's property list has no room
// for a shimmer -- which was true of the gradient sweep the word usually
// means, and remains true: no gradient. What ships instead is a
// background-colour crossfade between two existing surface tokens
// (--color-shell to --color-pink and back; components/skeleton/bone.tsx),
// and background-color IS on § Motion's animatable list. The reversal of the
// earlier "no animation" stance is deliberate and founder-directed (the
// site-wide loading-skeleton pass asked for shimmer explicitly); it is
// logged in the pass's DECISIONS-QUEUE for veto. prefers-reduced-motion
// returns this file to exactly its original behaviour: static bones, rules
// and the status text (globals.css removes the animation outright).
//
// aria-hidden, with the announcement carried by role="status" on the wrapper:
// twelve rows of decorative bars are noise to a screen reader, and "Loading"
// is the entire content of the message.

export function ListSkeleton({
  columns,
  rows = 8,
  announce = true,
}: {
  columns: number;
  rows?: number;
  /**
   * The route-level skeletons (components/skeleton/page-skeletons.tsx) that
   * stack MORE THAN ONE table on a surface pass false on all but the first:
   * one "Loading…" per surface is the message, twice is noise. Every
   * pre-existing in-page Suspense fallback keeps the default.
   */
  announce?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {announce ? (
        <p role="status" className="text-sm text-ink-muted">
          Loading…
        </p>
      ) : null}
      <div aria-hidden="true" className="overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            <tr className="border-b border-rule-strong">
              {Array.from({ length: columns }, (_, i) => (
                <td key={i} className="px-3 py-2 first:pl-0 last:pr-0">
                  <Bone className="h-4 w-24" />
                </td>
              ))}
            </tr>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} className="border-b border-rule">
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c} className="px-3 py-2 first:pl-0 last:pr-0">
                    {/* Uneven widths so the placeholder reads as text rather
                        than as a grid of identical blocks. Deterministic, not
                        random: a random width would differ between the server
                        render and the client, which is a hydration mismatch. */}
                    <Bone
                      className={`h-4 ${["w-[70%]", "w-[55%]", "w-[40%]", "w-[60%]"][c % 4]}`}
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
