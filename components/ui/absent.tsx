/**
 * The em dash a record field shows when it holds nothing.
 *
 * A BLANK CELL IS INDISTINGUISHABLE FROM A RENDERING FAULT, and it is silent
 * to a screen reader -- which is the whole reason this exists rather than
 * `{value ?? ""}`. The dash is `aria-hidden` because "em dash" is not what a
 * screen-reader user needs to hear; the `sr-only` text is.
 *
 * Twelve copies of this lived in twelve route files before it moved here, ten
 * of them byte-identical. The two that differed are both accommodated:
 *
 *   * documents/page.tsx passed a `label`, because "Not scanned" is a more
 *     honest sentence there than "Not recorded" -- hence the optional prop.
 *   * duplicates/[candidateId]/page.tsx omitted `text-ink-muted`, because its
 *     `<td>` already carries it. Re-adding it on the inner span changes no
 *     computed colour, so that copy folds in here without a visual change.
 */
export function Absent({ label = "Not recorded" }: { label?: string }) {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
