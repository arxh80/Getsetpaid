import { publishSummary, type FieldVisibility } from "@/lib/network/fields";

// The standing, always-visible summary at the top of the editor: "3 of 9
// fields are visible to the whole network; 1 more to accepted connections;
// 5 are hidden." NOT DECORATION -- the brief's own words: "it is the
// affordance that makes an accidental publish visible without reading nine
// rows." A user who has just ticked one radio button nine times over cannot
// tell from the form alone what the CUMULATIVE result is; this sentence is
// the one place that cumulative result is stated outright, in words, every
// time the editor renders -- including immediately after a save, so a
// mistaken "network" click shows up here rather than staying buried in row
// six.
//
// tabular-nums ON THE COUNTS (DESIGN.md § Numerals, and the plan's own [P6]
// note names this exact sentence). A `<p>` rather than a table: three numbers
// in a sentence, not a data table, but the digits still align when the count
// changes from a save -- 3 and 13 should not visually jump width against
// their neighbours, and the rule applies to "every number", not only to
// numbers in a `<table>`.
//
// ALWAYS RENDERED, EVEN WHEN EVERYTHING IS HIDDEN ("0 of 9... 9 are hidden"
// reads as a plain fact, not as an empty state to special-case away) and
// EVEN WHEN THE EDITOR IS READ-ONLY (a Free-tier viewer or a Booker still
// needs to know what THIS profile currently publishes -- the summary is a
// statement about the record, not about the caller's ability to change it).

export function PublishSummary({ visibility }: { visibility: FieldVisibility }) {
  const summary = publishSummary(visibility);
  return (
    <p
      role="status"
      className="max-w-prose border border-rule-strong bg-surface px-4 py-3 text-base text-ink"
    >
      <span className="tabular-nums font-semibold">{summary.network}</span>
      {" of "}
      <span className="tabular-nums font-semibold">{summary.total}</span>
      {" fields are visible to the whole network; "}
      <span className="tabular-nums font-semibold">{summary.connections}</span>
      {" more to accepted connections; "}
      <span className="tabular-nums font-semibold">{summary.hidden}</span>
      {summary.hidden === 1 ? " is" : " are"} hidden.
    </p>
  );
}
