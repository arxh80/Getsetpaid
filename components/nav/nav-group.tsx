"use client";

import { NavItem } from "@/components/nav/nav-item";
import type { SidebarNavGroup } from "@/components/nav/types";

/**
 * One labelled group of rows (CRM / Operations / Network / Admin).
 *
 * THE GROUP LABEL IS A `<span>`, NOT A HEADING. A `<h2>`/`<h3>` here would sit
 * in the SAME document heading outline as the page's own `<h1>` inside
 * `<main>` -- and because the sidebar renders before `<main>` in DOM order,
 * every page would open with a nav-group heading ahead of its real h1. Axe's
 * `heading-order` rule (part of the WCAG tag set tests/e2e/accessibility.spec.ts
 * runs) does not strictly forbid that specific shape, but there is no reason
 * to add headings that describe navigation chrome to a page's content
 * outline. `aria-labelledby` on the `<ul>` gives the group exactly the same
 * accessible structure (a screen reader navigating by list still hears "list,
 * CRM, 6 items") without touching heading semantics at all.
 *
 * VISUALLY, the label is small caps text (DESIGN.md's table-header treatment:
 * 600 weight, uppercase, --text-xs, 0.04em tracking) when the rail is
 * expanded, and `sr-only` when it is not -- there is no room to show group
 * labels on a 64px icon rail, but the grouping is still in the accessible
 * tree for a screen-reader user regardless of the rail's visual width.
 */
export function NavGroup({
  group,
  expanded,
  activeHref,
  reducedMotion,
  indexOffset,
}: {
  group: SidebarNavGroup;
  expanded: boolean;
  activeHref: string | null;
  reducedMotion: boolean;
  /** Where this group's items start in the whole-rail stagger sequence. */
  indexOffset: number;
}) {
  const labelId = `nav-group-${group.id}`;

  return (
    <div className="flex flex-col">
      <span
        id={labelId}
        className={
          expanded
            ? // nowrap + clip so the label never wraps to a second line
              // mid-width-tween (review finding 4's aside) -- the rail's own
              // overflow keeps it from poking out, this keeps it one line.
              "overflow-hidden px-4 pt-5 pb-1 text-xs font-semibold whitespace-nowrap tracking-[0.04em] text-ink-muted uppercase"
            : "sr-only"
        }
      >
        {group.heading}
      </span>
      <ul role="list" aria-labelledby={labelId} className="flex flex-col">
        {group.items.map((item, i) => (
          <li key={item.path}>
            <NavItem
              item={item}
              expanded={expanded}
              active={item.href === activeHref}
              reducedMotion={reducedMotion}
              staggerIndex={indexOffset + i}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
