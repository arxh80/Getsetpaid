"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { NAV_ICONS } from "@/components/nav/nav-icons";
import {
  SIDEBAR_EASE,
  SIDEBAR_LABEL_EXIT_SECONDS,
  SIDEBAR_TRANSITION_SECONDS,
} from "@/components/nav/motion-tokens";
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
 * child text node. (The one exception is the ~120ms exit fade on collapse --
 * see the AnimatePresence comment below -- during which `aria-label` wins the
 * name computation outright, so the guarantee that matters holds throughout.)
 *
 * EXPANDED: the aria-label is dropped and the heading + subheading render as
 * real, visible text -- the link's accessible name is now computed from its
 * content (icon contributes nothing, being aria-hidden), exactly as sighted
 * users read it. `motion.span` gives it the brief fade-and-slide-in reveal
 * DESIGN.md's motion tokens allow for the "animated reveal" the brief asks
 * for; `reducedMotion` collapses that to an instant, zero-duration state
 * change per `prefers-reduced-motion`.
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
  reducedMotion,
  staggerIndex,
}: {
  item: SidebarNavItem;
  expanded: boolean;
  active: boolean;
  reducedMotion: boolean;
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
      // INSET FOCUS RING (`-outline-offset-2`), A NAMED DEVIATION FROM
      // globals.css's `outline-offset: 2px` (review finding 4). The rail is a
      // scroll container (`overflow-y-auto`, for workspaces whose groups
      // outgrow a short screen), and per the CSS Overflow spec a scroll
      // container clips on BOTH axes -- `overflow-x` cannot stay `visible`
      // once `overflow-y` is `auto` -- so an outward ring on a full-width row
      // loses its left/right segments to the clip no matter what classes the
      // <nav> carries. Pulling the ring 2px INSIDE the row keeps all four
      // segments visible at every scroll position; the rows are 44px tall, so
      // the inset ring never touches the row's own text.
      // pl-[19px] CENTRES THE COLLAPSED ICON (review finding 9, arithmetic
      // corrected): the rail is 64px and the icon 20px, so its left edge
      // belongs at (64-20)/2 = 22px -- of which the always-present 3px
      // border-l supplies 3, leaving 19px of padding. (The review proposed
      // 21px, which double-counts by omitting the border.) h-11 = 44px is the
      // WCAG 2.5.8-plus touch-target height DESIGN.md § Spacing now names.
      className={
        "flex h-11 items-center gap-3 border-l-[3px] pl-[19px] pr-4 no-underline " +
        "focus-visible:-outline-offset-2 " +
        "transition-colors duration-[var(--dur-fast)] ease-brand " +
        (active
          ? "border-accent bg-surface font-semibold text-ink"
          : "border-transparent text-ink-muted hover:border-rule hover:bg-surface hover:text-ink")
      }
    >
      {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0" /> : null}
      {/* AnimatePresence so collapse FADES the label out (--dur-fast) instead
          of snapping it away mid-width-tween (review finding 6). During the
          ~120ms exit the aria-label (already applied, `expanded` having gone
          false) and the departing text node briefly coexist -- harmless for
          the double-announcement risk the header comment describes, because
          `aria-label` wins the link's name computation outright whenever it
          is present; at REST the two remain mutually exclusive exactly as
          before. */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.span
            initial={{ opacity: 0, x: reducedMotion ? 0 : -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{
              opacity: 0,
              transition: {
                duration: reducedMotion ? 0 : SIDEBAR_LABEL_EXIT_SECONDS,
                ease: SIDEBAR_EASE,
              },
            }}
            transition={{
              duration: reducedMotion ? 0 : SIDEBAR_TRANSITION_SECONDS * 0.75,
              delay: reducedMotion ? 0 : Math.min(staggerIndex * 0.015, 0.18),
              ease: SIDEBAR_EASE,
            }}
            className="flex min-w-0 flex-col overflow-hidden whitespace-nowrap"
          >
            <span className="text-base leading-tight">{item.label}</span>
            <span className="text-xs leading-tight text-ink-muted">{item.sub}</span>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </Link>
  );
}
