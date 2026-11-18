"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { NAV_ICONS } from "@/components/nav/nav-icons";
import type { SidebarNavItem } from "@/components/nav/types";

/**
 * One destination in the rail.
 *
 * COLLAPSED: only the icon renders (aria-hidden -- icons are decorative, the
 * task brief is explicit), and the heading becomes the link's accessible name
 * via `aria-label`. No text node is ever mounted alongside it in this state,
 * which is what keeps this safe from the double-announcement failure mode a
 * visible-but-sr-only label would risk once `aria-label` is added: expanded
 * and collapsed are mutually exclusive renders of the SAME element, driven by
 * one boolean, so AT REST there is never both an aria-label and a labelled
 * child text node: collapsed, the label is `display: none`, which takes it out
 * of the accessibility tree. (The one exception is the ~120ms exit fade on
 * collapse, during which `aria-label` wins the name computation outright, so
 * the guarantee that matters holds throughout.)
 *
 * EXPANDED: the aria-label is dropped and the heading + subheading render as
 * real, visible text -- the link's accessible name is now computed from its
 * content (icon contributes nothing, being aria-hidden), exactly as sighted
 * users read it. A CSS transition gives it the brief fade-and-slide-in reveal
 * DESIGN.md's motion tokens allow (`starting:` is the entry state); globals.css
 * clamps it to an instant under `prefers-reduced-motion`, and
 * `motion-reduce:delay-0` drops the stagger too.
 *
 * ACTIVE: `aria-current="page"` (computed by the parent from `usePathname()`,
 * not here -- one longest-prefix match across every item, so a nested route
 * like /events/abc123 still lights up "Events" and /network/profiles does not
 * also light up "Directory"). DESIGN.md's Active state token: a 3px --accent
 * left border, ink text -- applied at both rail widths, since the border is
 * legible even when the row is icon-only.
 */
export function NavItem({
  item,
  expanded,
  active,
  staggerIndex,
}: {
  item: SidebarNavItem;
  expanded: boolean;
  active: boolean;
  /** Position across the WHOLE rail (not just this group), so the stagger
   *  reads as one continuous reveal down the list rather than resetting at
   *  every group boundary. */
  staggerIndex: number;
}) {
  const Icon = NAV_ICONS[item.path];

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={expanded ? undefined : item.label}
      // The rail's focus ring is INSET, but not by a class here: a
      // `focus-visible:-outline-offset-2` utility sits in @layer utilities
      // and silently LOSES to globals.css's UNLAYERED base ring, whatever
      // the specificity (re-review N1 -- the same cascade fact the
      // border-radius guard documents). The unlayered
      // `nav[aria-label="Primary"] :focus-visible` rule in globals.css is
      // what actually insets it; its comment carries the scroll-container
      // clip that makes the inset necessary at all.
      // pl-[19px] CENTRES THE COLLAPSED ICON (review finding 9, arithmetic
      // corrected): the rail is 64px and the icon 20px, so its left edge
      // belongs at (64-20)/2 = 22px -- of which the always-present 3px
      // border-l supplies 3, leaving 19px of padding. (The review proposed
      // 21px, which double-counts by omitting the border.) h-11 = 44px is the
      // WCAG 2.5.8-plus touch-target height DESIGN.md § Spacing now names.
      className={
        "flex h-11 items-center gap-3 border-l-[3px] pl-[19px] pr-4 no-underline " +
        "transition-colors duration-[var(--dur-fast)] ease-brand " +
        (active
          ? "border-accent bg-surface font-semibold text-ink"
          : "border-transparent text-ink-muted hover:border-rule hover:bg-surface hover:text-ink")
      }
    >
      {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0" /> : null}
      {/* Always mounted so collapse can FADE the label out (--dur-fast)
          instead of snapping it away mid-width-tween (review finding 6):
          `transition-discrete` holds `display` until the fade ends, then the
          label is `hidden` and leaves the accessibility tree. */}
      <span
        style={{ "--stagger": `${Math.min(staggerIndex * 15, 180)}ms` } as CSSProperties}
        className={
          "min-w-0 flex-col overflow-hidden whitespace-nowrap transition-[opacity,translate,display] transition-discrete ease-brand " +
          (expanded
            ? "flex translate-x-0 opacity-100 delay-(--stagger) duration-[180ms] starting:-translate-x-1.5 starting:opacity-0 motion-reduce:delay-0"
            : "hidden opacity-0 duration-[var(--dur-fast)]")
        }
      >
        <span className="text-base leading-tight">{item.label}</span>
        <span className="text-xs leading-tight text-ink-muted">{item.sub}</span>
      </span>
    </Link>
  );
}
