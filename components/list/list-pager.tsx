import Link from "next/link";
import { buildListHref, type ListParams } from "@/lib/list/params";
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
// updates attributes instead of replacing the element. `aria-disabled` (not
// the `disabled` attribute, which anchors do not have and buttons are not
// focusable under) is what announces the state, and the href points at the
// current view so activating it is a no-op rather than a lie. This is the ARIA
// practice of preferring aria-disabled to removing an element from the tab
// order.
//
// It also means the pager needs no client JavaScript at all.
//
// ===========================================================================
// WHAT THIS DOES *NOT* ACHIEVE TODAY, MEASURED IN TASK 4'S BROWSER PASS
// ===========================================================================
// This comment used to end "...and focus survives", and the Task 3 note on the
// contacts page said focus was verified to stay on Next across a page click.
// BOTH ARE FALSE IN THIS APPLICATION AS IT IS CONFIGURED, and the reason is
// not React:
//
//   EVERY <Link> NAVIGATION IS A FULL DOCUMENT LOAD. Proven three ways on
//   `pnpm dev` against the local stack: a `window` property set before the
//   click is gone after it; a `data-` attribute stamped on the Next anchor is
//   gone from the new one; and the network log shows a document GET for the
//   destination plus a complete re-fetch of every chunk, with NO `?_rsc=`
//   request attempted at all. `document.activeElement` is BODY afterwards,
//   from a real mouse click and from a real Enter press.
//
// It is not this component's doing and it is not Task 4's: the same thing
// happens on the workspace breadcrumb, which is Foundation code. The leading
// hypothesis -- NOT verified, because the experiment that would verify it was
// removing a security header -- is the per-request CSP nonce that
// lib/supabase/middleware.ts sets through
// `NextResponse.next({ request: { headers } })`; a per-request nonce is the
// documented reason Next stops prefetching, and no soft navigation was
// attempted here at all. Recorded in FOLLOW-UPS.md rather than fixed, because
// the fix is a decision about the CSP and belongs to whoever owns that.
//
// The anchor-not-span choice is kept regardless. It costs nothing, it is the
// right ARIA shape on its own merits, and it becomes load-bearing again the
// moment soft navigation works.

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
}: ListPagerProps<TSort, TFilter>) {
  const selfHref = buildListHref(spec, basePath, params, {
    cursor: params.cursor
      ? { direction: params.cursorDirection ?? "after", cursor: params.cursor }
      : null,
  });

  const previousHref =
    hasPrevious && firstCursor
      ? buildListHref(spec, basePath, params, {
          cursor: { direction: "before", cursor: firstCursor },
        })
      : selfHref;

  const nextHref =
    hasNext && lastCursor
      ? buildListHref(spec, basePath, params, {
          cursor: { direction: "after", cursor: lastCursor },
        })
      : selfHref;

  return (
    <nav
      aria-label="Pagination"
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
