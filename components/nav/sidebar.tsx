"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
} from "react";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { Pin, PinOff } from "lucide-react";
import { NavGroup } from "@/components/nav/nav-group";
import {
  RAIL_WIDTH_COLLAPSED,
  RAIL_WIDTH_EXPANDED,
  SIDEBAR_EASE,
  SIDEBAR_TRANSITION_SECONDS,
} from "@/components/nav/motion-tokens";
import type { SidebarNavGroup } from "@/components/nav/types";

const PIN_STORAGE_KEY = "gsp:sidebar-pinned";

/**
 * localStorage read/write, wrapped in try/catch -- same pattern as
 * components/auth/idle-timeout.tsx's `store.read()`/`write()`: private
 * browsing, a browser storage quota, or a policy that blocks all Storage
 * access can make either call throw, and none of that should crash the
 * sidebar or take the pin control down with it.
 *
 * `memoryPinned` IS WHAT KEEPS THE PIN WORKING WHEN STORAGE IS BLOCKED
 * (review finding 2). The pin's only state lives in this module-level store
 * -- there is no separate React state; `useSyncExternalStore` reads whatever
 * `readPinned()` returns. Before the fallback, a browser that throws on
 * every Storage access made the pin button a silent no-op: the write was
 * dropped, the read always came back `false`, and `aria-pressed` stuck. Now
 * every write lands in `memoryPinned` FIRST and localStorage second, and a
 * blocked read falls back to it -- so the pin works for the life of the
 * page either way, and the only thing a blocked store costs is persistence
 * across a reload.
 */
let memoryPinned = false;

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === "1";
  } catch {
    return memoryPinned;
  }
}

function writePinned(pinned: boolean): void {
  memoryPinned = pinned;
  try {
    if (pinned) {
      window.localStorage.setItem(PIN_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(PIN_STORAGE_KEY);
    }
  } catch {
    // See the header comment -- memoryPinned already holds the value, so a
    // dropped localStorage write only costs persistence across a reload.
  }
}

/**
 * The pin's persisted value, read through `useSyncExternalStore` rather than
 * `useState` + a mount `useEffect`.
 *
 * THE PROBLEM AN EFFECT CANNOT SOLVE WITHOUT A HYDRATION MISMATCH:
 * `window.localStorage` does not exist during server rendering, so the
 * SERVER-rendered markup can only ever be "collapsed" (pinned=false). If the
 * client's FIRST render read localStorage directly (e.g. `useState(() =>
 * readPinned())`), a user who previously pinned the rail would hydrate
 * straight into "expanded" -- a DOM mismatch against what the server sent,
 * which is exactly the class of bug `useSyncExternalStore`'s
 * `getServerSnapshot` argument exists to prevent: it pins the value used for
 * the server render AND the client's first (pre-hydration-reconciliation)
 * render to the same `false`, and only resolves to the real persisted value
 * in the client update that follows -- no manual effect, no manual setState,
 * and (the reason this replaced a `useEffect(() => setPinned(readPinned()),
 * [])`) nothing for `react-hooks/set-state-in-effect` to flag.
 *
 * `subscribe` listens for the `storage` event so a pin toggled in ANOTHER
 * tab is picked up here too; `notifyPinnedListeners()` is what makes toggling
 * it in THIS tab visible immediately, since a same-tab `localStorage` write
 * never fires that event for the tab that made it.
 */
const pinnedListeners = new Set<() => void>();

function notifyPinnedListeners(): void {
  for (const listener of pinnedListeners) listener();
}

function subscribePinned(listener: () => void): () => void {
  pinnedListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PIN_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    pinnedListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getPinnedServerSnapshot(): boolean {
  return false;
}

/**
 * "Does this input actually hover?" (review finding 5b). A touch screen fires
 * synthetic mouseenter on tap -- without this gate, tapping any rail icon on
 * a hybrid laptop's touchscreen or a tablet would ALSO expand the rail and
 * reflow the page under the finger mid-tap. `(hover: hover) and (pointer:
 * fine)` is the standard capability pair for "a mouse-like primary input";
 * read through `useSyncExternalStore` (same shape as the pin store above) so
 * plugging a mouse into a tablet mid-session updates it live, and so the
 * server render -- which cannot know -- consistently assumes `false`.
 *
 * THE COARSE-POINTER TABLET (>= md, so the rail shows, but no hover -- re-
 * review N3): expansion is a TAP ON THE PIN, which is a real, focusable
 * 32px button that expands AND holds the rail open -- for a touch user that
 * coupling is better than hover-mimicry, not a fallback. Deliberately NOT a
 * tap-anywhere-on-the-rail toggle: the rail's body is nav links, and a tap
 * that toggles width instead of navigating would make every link's primary
 * action ambiguous. The org-home page (every destination, with blurbs)
 * remains the fully-labelled path, same as below md.
 */
const HOVER_CAPABLE_QUERY = "(hover: hover) and (pointer: fine)";

/** ~120ms of dwell before the rail expands (review finding 5b): a pointer
 *  travelling THROUGH the rail on its way to the content should not pay a
 *  whole expand/collapse reflow as a toll. Deliberate hovers never notice a
 *  delay this size; drive-bys stop triggering anything. */
const HOVER_INTENT_MS = 120;

function subscribeHoverCapability(listener: () => void): () => void {
  const mql = window.matchMedia(HOVER_CAPABLE_QUERY);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

function readHoverCapability(): boolean {
  return window.matchMedia(HOVER_CAPABLE_QUERY).matches;
}

function getHoverCapabilityServerSnapshot(): boolean {
  return false;
}

function setPinnedGlobal(next: boolean): void {
  writePinned(next);
  notifyPinnedListeners();
}

/**
 * The persistent left rail. Rendered once by app/(app)/layout.tsx -- as a
 * SIBLING of `<main>`, never inside it (review finding 1: primary navigation
 * inside `main` broke the skip link and the HTML spec's own rule for `main`)
 * -- and reused, not remounted, across client-side navigations between org
 * routes -- that persistence is what makes "hover it once, click three
 * sections in a row without it collapsing between clicks" work, and it comes
 * free from the App Router keeping a layout's component instance mounted
 * while only the child route segment underneath it swaps.
 *
 * ===========================================================================
 * WHY THIS ANIMATES `width` DIRECTLY -- A DELIBERATE, NAMED DEVIATION
 * ===========================================================================
 * DESIGN.md § Motion: "Only opacity, background-color, border-color and
 * transform: translate are animated" -- `width` is not on that list, and this
 * component's rail-expand animation is exactly that: a `width` tween. The
 * brief driving this build asks explicitly for "framer-motion for the
 * expand/collapse WIDTH transition", and the two ways to honour DESIGN.md's
 * restriction to the letter were both judged worse: `transform: scaleX()`
 * would squash every child (icon, heading, subheading) horizontally along
 * with the rail, not just grow the container around them; an absolute-
 * positioned overlay rail animated with `translateX` would avoid a `width`
 * tween but changes the rail from PUSHING the main content (the layout this
 * build settled on, matching a reflowing desktop CRM shell) to OVERLAYING it,
 * which is a bigger, unrequested layout change and introduces its own
 * z-index/scrim questions DESIGN.md does not answer. So: `width`, kept to
 * DESIGN.md's own duration/easing tokens (`--dur-slow` / `--ease-brand`, see
 * components/nav/motion-tokens.ts) and dropped to instant under
 * `prefers-reduced-motion`, flagged here for a design-system owner to weigh
 * in on rather than silently choosing a side.
 */
export function Sidebar({ groups }: { groups: SidebarNavGroup[] }) {
  const pathname = usePathname();

  // null until after mount (framer-motion's own SSR-safety -- it cannot know
  // the OS/browser's reduced-motion preference on the server), so `?? false`
  // is "assume motion is fine" for the one server-rendered frame, corrected
  // on the client's first paint. Never the other way around: assuming
  // reduced motion by default would need its own justification and DESIGN.md
  // does not ask for that.
  const reducedMotion = useReducedMotion() ?? false;

  // See getPinnedServerSnapshot()/subscribePinned()'s header comment: this
  // starts `false` on the server and the client's first render alike (no
  // hydration mismatch), then resolves to the real persisted value on the
  // client update that follows. A user who pinned the rail on a previous
  // visit sees one brief collapsed-then-expanded flash on load -- the same
  // trade-off components/auth/idle-timeout.tsx's own mount-time correction
  // makes for the same reason.
  const pinned = useSyncExternalStore(
    subscribePinned,
    readPinned,
    getPinnedServerSnapshot,
  );
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  const expanded = pinned || hovered || focusWithin;

  const togglePin = useCallback(() => {
    setPinnedGlobal(!readPinned());
  }, []);

  // See HOVER_CAPABLE_QUERY / HOVER_INTENT_MS above (review finding 5b):
  // expansion only arms on a genuinely hovering pointer, and only after a
  // short dwell -- a pointer crossing the rail en route to the content, or a
  // tap's synthetic mouseenter on a touch screen, expands nothing. Collapse
  // stays immediate: leaving the rail is never ambiguous.
  const hoverCapable = useSyncExternalStore(
    subscribeHoverCapability,
    readHoverCapability,
    getHoverCapabilityServerSnapshot,
  );
  const hoverIntentRef = useRef<number | null>(null);

  const cancelHoverIntent = useCallback(() => {
    if (hoverIntentRef.current !== null) {
      window.clearTimeout(hoverIntentRef.current);
      hoverIntentRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!hoverCapable) return;
    cancelHoverIntent();
    hoverIntentRef.current = window.setTimeout(() => {
      hoverIntentRef.current = null;
      setHovered(true);
    }, HOVER_INTENT_MS);
  }, [hoverCapable, cancelHoverIntent]);

  const handleMouseLeave = useCallback(() => {
    cancelHoverIntent();
    setHovered(false);
  }, [cancelHoverIntent]);

  // A timer armed at unmount must not fire into a gone component.
  useEffect(() => cancelHoverIntent, [cancelHoverIntent]);

  // FOCUS-WITHIN, DONE BY HAND. There is a `:focus-within` CSS pseudo-class,
  // but the expand/collapse here is a JS-driven `width` tween (see the header
  // comment), not a CSS transition -- so the expanded/collapsed decision has
  // to live in React state that CSS alone cannot drive. React's onFocus/
  // onBlur already behave like the native `focusin`/`focusout` events (they
  // bubble, unlike native `focus`/`blur`), so one pair of handlers on the
  // <nav> covers every descendant control without attaching a listener per
  // item.
  const handleFocus = useCallback(() => setFocusWithin(true), []);
  const handleBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    // Only collapse once focus has left the RAIL ENTIRELY -- moving focus
    // from one nav item to the next fires a blur on the first before a focus
    // on the second, and collapsing in between would be a visible flicker on
    // every Tab press while tabbing through the rail's own items.
    const goingTo = event.relatedTarget;
    if (!navRef.current || !goingTo || !navRef.current.contains(goingTo)) {
      setFocusWithin(false);
    }
  }, []);

  // LONGEST-PREFIX MATCH ACROSS EVERY ITEM, not "does this one item's href
  // prefix the path". Both /network (Directory) and /network/profiles (Your
  // profiles) are valid prefixes of a pathname like /acme/network/profiles --
  // matching on the FIRST one found would light up "Directory" for a page
  // that is actually "Your profiles". Whichever matching href is longest wins,
  // which handles both the network sub-items and a detail route like
  // /acme/events/abc123 correctly (only "Events" prefixes that).
  const activeHref = useMemo(() => {
    let best: string | null = null;
    for (const group of groups) {
      for (const item of group.items) {
        const isMatch =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        if (isMatch && (best === null || item.href.length > best.length)) {
          best = item.href;
        }
      }
    }
    return best;
  }, [groups, pathname]);

  // groups, annotated with where each one's items start in the whole-rail
  // stagger sequence. Each offset is the sum of every earlier group's item
  // count -- written with `.slice().reduce()` rather than a running counter
  // reassigned across iterations, which the React Compiler's lint rules
  // reject inside a memoised computation (mutating a variable captured
  // across renders is exactly the pattern the compiler cannot safely prove
  // is contained to one call). The group counts here are a handful of small
  // numbers, so the mild O(n^2) of summing a slice per group costs nothing.
  const groupsWithOffsets = useMemo(
    () =>
      groups.map((group, i) => ({
        group,
        indexOffset: groups
          .slice(0, i)
          .reduce((sum, earlier) => sum + earlier.items.length, 0),
      })),
    [groups],
  );

  return (
    <motion.nav
      ref={navRef}
      aria-label="Primary"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      initial={false}
      animate={{ width: expanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED }}
      transition={{
        duration: reducedMotion ? 0 : SIDEBAR_TRANSITION_SECONDS,
        ease: SIDEBAR_EASE,
      }}
      style={{ width: RAIL_WIDTH_COLLAPSED }}
      // STICKY AT THE VIEWPORT'S OWN TOP. The rail is a SIBLING of <main> in
      // app/(app)/layout.tsx's full-width row (it used to sit INSIDE main's
      // padded, centred column, which is what forced the old top-8/sm:top-12
      // offsets -- and the review caught those disagreeing with the max-h
      // calc, leaving the rail overhanging the viewport by 16px at >=640px).
      // From the row's top edge, `top-0` and `max-h-dvh` are exact by
      // construction: the rail sticks flush once the header scrolls away, and
      // `overflow-y-auto` lets the RAIL scroll internally on the rare
      // workspace with enough permitted groups to exceed a short screen,
      // rather than pushing the document's own scroll height taller.
      //
      // KNOWN TRANSIENT (re-review N4, accepted): at scroll-top the rail
      // starts BELOW the header, so a max-h-dvh rail can overhang the
      // viewport bottom by up to the header's height until the page scrolls
      // enough for `sticky top-0` to pin it -- at which point the height is
      // exact. Self-correcting within one header-height of scroll; not worth
      // a scroll-linked measurement to fix.
      //
      // `hidden md:flex` (review finding 5a): below md there is no width to
      // pay -- even the 64px rail eats a sixth of a 375px phone, and the
      // expanded rail would cover most of it. The org-home page already
      // carries every rail destination (the CRM/Operations card grids, the
      // Network section, the admin header links), so nothing becomes
      // unreachable; the rail is the wide-screen accelerator, not the only
      // road.
      className="sticky top-0 hidden max-h-dvh shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-rule bg-shell md:flex"
    >
      {/* pl-4 ANCHORS THE PIN ON THE ICON COLUMN'S 32px MIDLINE IN BOTH
          STATES (review finding 10, taken further than the conditional
          justify it proposed): a 32px button behind 16px of padding centres
          on x=32 exactly like every nav icon below it, expanded or not. Not
          merely cosmetic -- an earlier cut re-justified the button to the
          rail's right edge on expansion, and the ~120ms hover-intent delay
          meant expansion began exactly as an aimed click arrived: the button
          slid out from under the pointer mid-click (caught by the pinned-rail
          e2e test as an aria-pressed that never flipped). A control the rail
          repositions while the user is clicking it is a moving target for
          everyone, Playwright included; anchored, the race cannot exist. */}
      <div className="flex h-11 shrink-0 items-center justify-start pl-4">
        {/* A REAL <button>, aria-pressed rather than a re-worded label on
            toggle. WAI-ARIA's toggle-button pattern: the name stays constant
            ("Pin navigation open") and `aria-pressed` carries the state, so a
            screen reader announces "Pin navigation open, button, pressed"
            once pinned rather than a label that has to be read twice to tell
            whether the action pins or unpins. */}
        <button
          type="button"
          onClick={togglePin}
          aria-pressed={pinned}
          aria-label="Pin navigation open"
          className={
            "flex size-8 shrink-0 items-center justify-center border transition-colors " +
            // The inset focus ring comes from globals.css's unlayered
            // nav[aria-label="Primary"] rule, not a utility class here --
            // a layered utility loses to the unlayered base ring (N1).
            "duration-[var(--dur-fast)] ease-brand " +
            (pinned
              ? "border-accent bg-surface text-ink"
              : "border-transparent text-ink-muted hover:border-rule hover:bg-surface hover:text-ink")
          }
        >
          {pinned ? (
            <PinOff aria-hidden="true" className="size-4" />
          ) : (
            <Pin aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>

      {groupsWithOffsets.map(({ group, indexOffset }) => (
        <NavGroup
          key={group.id}
          group={group}
          expanded={expanded}
          activeHref={activeHref}
          reducedMotion={reducedMotion}
          indexOffset={indexOffset}
        />
      ))}
    </motion.nav>
  );
}
