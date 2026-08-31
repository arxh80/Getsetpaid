import Link from "next/link";
import {
  buildListHref,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import type { Cursor } from "@/lib/list/cursor";
import type { ListSpec } from "@/lib/list/spec";

// Keyset pager. Two links, no page numbers.
//
// There are no page numbers because there are no pages -- a keyset cursor
// names a ROW, not an offset, which is the whole reason it does not degrade
// with depth (lib/list/query.ts has the measurements). "Page 7 of 43" would
// have to be reconstructed from an offset the query deliberately does not
// have. The honest surface is a total and two directions, and the total is
// already on the count line above the table.
//
// ===========================================================================
// WHY THE UNAVAILABLE DIRECTION IS STILL AN <a>, AND STILL FOCUSABLE
// ===========================================================================
// The obvious rendering -- a <Link> when the direction exists and a <span>
// when it does not -- loses keyboard focus at exactly the moment a keyboard
// user is most likely to be holding it. Tab to "Next", press it repeatedly,
// and on the last page the element under focus changes type; React unmounts
// the anchor, mounts a span, and focus falls back to <body>. The user is
// returned to the top of the document with a table between them and the
// control they were using.
//
// Keeping it an anchor at the same position keeps the DOM node, so React
// updates attributes instead of replacing the element and focus survives.
// `aria-disabled` (not the `disabled` attribute, which anchors do not have
// and buttons are not focusable under) is what announces the state, and the
// href points at the current view so activating it is a no-op rather than a
// lie. This is the ARIA practice of preferring aria-disabled to removing an
// element from the tab order, applied for the specific reason that focus
// continuity is the whole point of a pager for keyboard users.
//
// It also means the pager needs no client JavaScript at all, which the
// alternative fix -- restoring focus in an effect after navigation -- would
// have.
//
// ===========================================================================
// A CORRECTION THAT WAS ITSELF WRONG, AND HOW IT GOT HERE
// ===========================================================================
// Task 4's browser pass replaced the paragraph above with "EVERY <Link>
// NAVIGATION IS A FULL DOCUMENT LOAD ... no `?_rsc=` request attempted at
// all ... document.activeElement is BODY", named the per-request CSP nonce as
// the cause, and routed it to FOLLOW-UPS.md. It does not reproduce. The
// measurement was taken against a dev server that had crashed
// (`Failed to generate static paths`, `Jest worker ... exceeding retry
// limit`, `write EPIPE`) and was still holding port 3000; Next falls back to a
// hard navigation when the RSC fetch fails.
//
// Re-measured twice on a clean `pnpm dev` against the local stack -- once by
// the Task 4 review, once by the fix round, both as `pmanager`:
//
//   sort link, focused then activated
//     window property set before the click   SURVIVED
//     performance navigation entries         1  (still the original load)
//     ?_rsc= issued for the destination      yes
//     document.activeElement after           A "Updated" -- the same anchor
//
//   pager "Next" at ?size=10, focused then activated
//     window property                        SURVIVED
//     navigation entries                     1
//     document.activeElement === the node it started on   true
//
// The nonce is REFUTED rather than merely unverified: it is present on the
// wire (`script-src 'self' 'nonce-...' 'strict-dynamic'`) and navigation is
// soft anyway. Task 3's Suspense-key fix is intact and this paragraph exists
// so nobody re-litigates it. Focus DOES fall to <body> after a programmatic or
// pointer click, which never focuses the anchor in the first place -- that is
// the browser's normal behaviour, not a defect, and it is what the crashed-
// server reading was measuring.

interface ListPagerProps<TSort extends string, TFilter extends string> {
  spec: ListSpec<TSort, TFilter>;
  params: ListParams<TSort, TFilter>;
  basePath: string;
  hasPrevious: boolean;
  hasNext: boolean;
  firstCursor: Cursor | null;
  lastCursor: Cursor | null;
  /** Rows on this page, for the "showing n" label. */
  shown: number;
  noun: { one: string; many: string };
  /**
   * The page's whole `searchParams`, on a page that carries a SECOND list.
   * See HrefOverrides.preserve; absent, nothing changes.
   */
  preserve?: RawSearchParams;
}

export function ListPager<TSort extends string, TFilter extends string>({
  spec,
  params,
  basePath,
  hasPrevious,
  hasNext,
  firstCursor,
  lastCursor,
  shown,
  noun,
  preserve,
}: ListPagerProps<TSort, TFilter>) {
  const selfHref = buildListHref(spec, basePath, params, {
    preserve,
    cursor: params.cursor
      ? { direction: params.cursorDirection ?? "after", cursor: params.cursor }
      : null,
  });

  const previousHref =
    hasPrevious && firstCursor
      ? buildListHref(spec, basePath, params, {
          preserve,
          cursor: { direction: "before", cursor: firstCursor },
        })
      : selfHref;

  const nextHref =
    hasNext && lastCursor
      ? buildListHref(spec, basePath, params, {
          preserve,
          cursor: { direction: "after", cursor: lastCursor },
        })
      : selfHref;

  return (
    <nav
      // ===================================================================
      // NAMED AFTER WHAT IT PAGES, NOT "Pagination" -- AND A SCANNER FOUND
      // WHY (Phase 3 Task 8)
      // ===================================================================
      // This used to be the literal string "Pagination", which was unique for
      // as long as no page carried two pagers. The event detail page is the
      // first that does -- the lineup panel and the activity timeline are both
      // lib/list/ surfaces on one record -- and axe reported
      // `landmark-unique` on `section[aria-labelledby="lineup-heading"] > nav`:
      // two `navigation` landmarks with the identical accessible name
      // "Pagination", which a screen-reader user meets as two entries in the
      // landmark list that cannot be told apart. The artist detail page has
      // THREE and the venue detail page two, so this was not a corner case; it
      // was simply invisible until Phase 3 Task 8 pointed the scan at the
      // pages that have them.
      //
      // Caught only because `tests/e2e/accessibility.spec.ts` runs axe with
      // `best-practice` as well as the five WCAG tags -- axe classifies every
      // `landmark-*` rule as best-practice, so the mandated tag set reports
      // ZERO violations on this page. That is the same blind spot the nested
      // `<main>` fell into in Phase 2, found the same way.
      //
      // `noun.many` is the spec's own plural, so the label is unique wherever
      // two pagers share a page today (lineup entries / entries; fees / events
      // / entries; events / entries) and it reads as a sentence rather than as
      // an id. A page that ever renders two pagers over the SAME spec would
      // collide again -- nothing does, and the scan is what would say so.
      aria-label={`Pagination for ${noun.many}`}
      className="flex flex-wrap items-center justify-between gap-3 pt-4"
    >
      <p className="text-sm text-ink-muted">
        Showing <span className="tabular-nums">{shown}</span>{" "}
        {shown === 1 ? noun.one : noun.many}
      </p>
      <div className="flex items-center gap-2">
        <PagerLink
          href={previousHref}
          enabled={hasPrevious && firstCursor !== null}
        >
          Previous
        </PagerLink>
        <PagerLink href={nextHref} enabled={hasNext && lastCursor !== null}>
          Next
        </PagerLink>
      </div>
    </nav>
  );
}

function PagerLink({
  href,
  enabled,
  children,
}: {
  href: string;
  enabled: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-disabled={enabled ? undefined : true}
      // Not prefetched when unavailable: there is nothing to fetch, and
      // prefetching the page you are already on is wasted work on every list
      // in the product.
      prefetch={enabled ? undefined : false}
      className={
        // 44px tall, matching every other control (DESIGN.md's touch floor and
        // hallmark's input/button height rule), 1px border in every state so
        // nothing shifts.
        "inline-flex h-11 items-center border px-4 text-base font-semibold " +
        "whitespace-nowrap transition-colors duration-[var(--dur-fast)] ease-brand " +
        (enabled
          ? "border-rule bg-surface text-ink hover:border-ink hover:bg-shell"
          : // Disabled: muted text, --rule border, no fill change, plus
            // `cursor-not-allowed` and `aria-disabled`, so three channels
            // carry the state and not one.
            //
            // NO `opacity-55`, and that is a deliberate departure from
            // DESIGN.md § Interaction states' disabled row. Review finding
            // M-4 measured what it produced here: --ink-muted at 55% over
            // --surface computes to #A2A2A7, which is 2.54:1 — under the 4.5:1
            // this text needs.
            //
            // WCAG 1.4.3 exempts "inactive user interface components", and for
            // every other disabled control in this product that exemption
            // applies. It does not apply to THIS one, because this control is
            // deliberately not inactive: list-pager.tsx keeps it an <a href> in
            // the tab order precisely so focus is not lost when a direction
            // becomes unavailable (see the header). A control that is
            // focusable, reachable and activatable is an active control that
            // happens to look disabled, and it has to meet the contrast that
            // active controls meet.
            //
            // Without the opacity, --ink-muted on --surface is 6.4:1 and the
            // three signals all survive. Routed to DESIGN.md rather than
            // decided here: the 55% rule needs a sentence saying it applies
            // only to genuinely inert controls, and Task 4 ships five more of
            // these.
            "cursor-not-allowed border-rule bg-surface text-ink-muted")
      }
    >
      {children}
    </Link>
  );
}
