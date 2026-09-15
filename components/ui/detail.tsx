import type { ReactNode } from "react";

/**
 * One labelled field on a record's detail page.
 *
 * RENDERS `<dt>`/`<dd>`, SO IT MUST SIT INSIDE A `<dl>`. That is not
 * decoration: the pairing is what tells a screen reader which label belongs to
 * which value, and a `<dt>` outside a `<dl>` is invalid HTML that the axe scan
 * in tests/e2e/accessibility.spec.ts will flag. Every caller wraps a group of
 * these in a `<dl>` already; a new one must too.
 *
 * Six route files carried a byte-identical copy of this before it moved here.
 */
export function Detail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
        {label}
      </dt>
      <dd className="text-base break-words text-ink">{children}</dd>
    </div>
  );
}
