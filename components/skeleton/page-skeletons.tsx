import { Bone } from "@/components/skeleton/bone";
import { ListSkeleton } from "@/components/list/list-skeleton";

// ============================================================================
// THE ROUTE-LEVEL SKELETON VOCABULARY (loading-skeletons pass).
//
// Every app/**/loading.tsx composes these. The rule they all follow: mirror
// the REAL page's frame -- same wrappers, same gap rhythm, same hairline
// rules, same type-scale heights -- so the streamed content lands where the
// bones were instead of shoving the layout around (CLS), and a table page
// looks like a table coming, a form like a form. The class strings are
// copied from the pages they stand in for, not invented; if a page frame
// changes shape, its loading.tsx is part of the diff.
//
// BONE HEIGHTS FOLLOW THE TYPE SCALE'S LINE-HEIGHTS, one step down so the
// bone reads as text-with-breathing-room rather than a filled cell:
//   text-3xl line (h1, 38px line)   -> h-8 bone
//   text-xl line (h2, 28px line)    -> h-6 bone
//   text-base line (24px line)      -> h-5 bone
//   text-sm/xs line (20/16px line)  -> h-4 / h-3 bone
//   controls (inputs, buttons)      -> h-11, the real 44px control height
//
// ACCESSIBILITY: one `role="status"` announcement per surface, everything
// else aria-hidden (the pattern components/list/list-skeleton.tsx set).
// ListSkeleton brings its own VISIBLE "Loading…" line, positioned where the
// real list's count line sits; surfaces without a list carry an sr-only one
// via <LoadingStatus /> instead, because there is no natural text slot in a
// detail or form frame and a visible line at the top would shove the whole
// frame down when content arrives.
//
// SKELETONS ARE DUMB ON PURPOSE: no data fetching, no client JS, no
// permission checks -- so a bone can stand for a control the viewer's role
// will not actually receive (a Read Only user's "New contact" slot, say).
// That is fine: the skeleton is a sketch of the page class, visible for the
// stream's duration, not a render of the caller's entitlements.
// ============================================================================

/** The screen-reader announcement for surfaces that don't embed ListSkeleton. */
export function LoadingStatus() {
  return (
    <p role="status" className="sr-only">
      Loading…
    </p>
  );
}

/**
 * The hand-rolled header block every org page opens with: eyebrow link line,
 * h1, optionally a chips row, an intro paragraph, a trailing small-link line
 * (the "Deleted contacts" slot) and a top-right action button slot.
 */
export function PageHeaderSkeleton({
  eyebrow = true,
  action = false,
  chips = false,
  intro = false,
  smallLink = false,
}: {
  eyebrow?: boolean;
  action?: boolean;
  chips?: boolean;
  intro?: boolean;
  smallLink?: boolean;
}) {
  const heading = <Bone className="h-8 w-64 max-w-full" />;
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      {eyebrow ? <Bone className="h-4 w-28" /> : null}
      {action ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          {heading}
          <Bone className="h-11 w-36" />
        </div>
      ) : (
        heading
      )}
      {chips ? (
        <div className="flex flex-wrap items-center gap-3">
          <Bone className="h-5 w-20" />
          <Bone className="h-5 w-16" />
        </div>
      ) : null}
      {intro ? <Bone className="h-5 w-full max-w-prose" /> : null}
      {smallLink ? <Bone className="h-4 w-32" /> : null}
    </div>
  );
}

/**
 * components/list/list-toolbar.tsx's geometry: a bordered band holding a
 * labelled search field, optional labelled select filters and the Search
 * button, all on the 44px control height.
 */
export function ToolbarSkeleton({ filters = 0 }: { filters?: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-rule py-4"
    >
      <div className="flex flex-1 basis-64 flex-col gap-2">
        <Bone className="h-3 w-16" />
        <Bone className="h-11 w-full" />
      </div>
      {Array.from({ length: filters }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Bone className="h-3 w-14" />
          <Bone className="h-11 w-32" />
        </div>
      ))}
      <Bone className="h-11 w-24" />
    </div>
  );
}

/**
 * A whole list route: header (with the action-button slot the entity lists
 * carry), the toolbar band, then the table bones at the route's real column
 * count. ListSkeleton supplies the visible role="status" line in the same
 * spot the results count occupies, so nothing extra is announced.
 */
export function ListPageSkeleton({
  columns,
  filters = 0,
  action = true,
  intro = false,
  eyebrow = true,
  smallLink = true,
}: {
  columns: number;
  filters?: number;
  action?: boolean;
  intro?: boolean;
  eyebrow?: boolean;
  /** The "Deleted …" link line under the heading. Off for the network
   *  surfaces, which have no deleted view (review finding I2). */
  smallLink?: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton
        eyebrow={eyebrow}
        action={action}
        intro={intro}
        smallLink={smallLink}
      />
      <ToolbarSkeleton filters={filters} />
      <ListSkeleton columns={columns} />
    </div>
  );
}

/**
 * The two-column definition list detail pages open with:
 * dt (uppercase xs label) over dd (base value), on a ruled top border.
 */
export function DlSkeleton({ items = 8 }: { items?: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2"
    >
      {Array.from({ length: items }, (_, i) => (
        <div key={i} className="flex flex-col gap-1">
          <Bone className="h-3 w-20" />
          <Bone className={`h-5 ${["w-40", "w-28", "w-48", "w-32"][i % 4]}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * One ruled section: h2 bone, then rows on hairline rules (the RuledList /
 * linked-records / panel-list shape detail pages stack).
 */
export function SectionSkeleton({
  rows = 3,
  divider = true,
}: {
  rows?: number;
  /** The top rule. Off when this stands where the real page's FIRST section
   *  does, which follows the header with no rule (review finding I2). */
  divider?: boolean;
}) {
  return (
    <section
      aria-hidden="true"
      className={
        divider
          ? "flex flex-col gap-4 border-t border-rule pt-6"
          : "flex flex-col gap-4"
      }
    >
      <Bone className="h-6 w-44" />
      <div className="flex flex-col border-t border-rule">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-3"
          >
            <Bone className={`h-5 ${["w-48", "w-40", "w-56"][i % 3]}`} />
            <Bone className="h-4 w-24" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * components/crm/activity-timeline.tsx's bones: h2 "Activity", the count
 * line's slot, then rows of time-column + ruled body column.
 */
export function TimelineSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <section
      aria-hidden="true"
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <Bone className="h-6 w-28" />
      <Bone className="h-4 w-40" />
      <ol className="border-t border-rule">
        {Array.from({ length: rows }, (_, i) => (
          <li
            key={i}
            className="grid gap-x-3 gap-y-1 border-b border-rule py-3 sm:grid-cols-[8.5rem_1fr]"
          >
            <Bone className="h-4 w-24" />
            <div className="flex flex-col gap-2 sm:border-l sm:border-rule sm:pl-3">
              <Bone className="h-3 w-24" />
              <Bone className={`h-5 ${["w-3/4", "w-1/2", "w-2/3"][i % 3]}`} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A record detail route: header (eyebrow, name, optional chips), the
 * definition list, a run of ruled panel sections, and the activity timeline.
 * `sections` approximates the page's panel count -- companies/contacts stack
 * more than a task does; the exact interior of each panel is not guessed at.
 */
export function DetailPageSkeleton({
  dlItems = 8,
  sections = 2,
  chips = false,
  timeline = true,
}: {
  dlItems?: number;
  sections?: number;
  chips?: boolean;
  timeline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <PageHeaderSkeleton chips={chips} />
      {dlItems > 0 ? <DlSkeleton items={dlItems} /> : null}
      {Array.from({ length: sections }, (_, i) => (
        <SectionSkeleton key={i} rows={i === 0 ? 3 : 2} />
      ))}
      {timeline ? <TimelineSkeleton /> : null}
    </div>
  );
}

/** One label-over-control form field on the 44px control height. */
export function FieldSkeleton({ textarea = false }: { textarea?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Bone className="h-4 w-24" />
      <Bone className={textarea ? "h-28 w-full" : "h-11 w-full"} />
    </div>
  );
}

/**
 * The bordered "Social" fieldset the contact, artist and venue forms all end
 * with (components/crm/*-form.tsx): legend, one explanatory line, six
 * label+input rows for SOCIAL_PLATFORMS. Review finding I2 -- the first cut
 * flattened these into the plain stack, which undercounted every form that
 * carries them.
 */
export function SocialFieldsetSkeleton() {
  return (
    <div className="flex flex-col gap-5 border border-rule p-5">
      <Bone className="h-4 w-16" />
      <Bone className="h-4 w-3/4 max-w-prose" />
      {Array.from({ length: 6 }, (_, i) => (
        <FieldSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * A create/edit route: header (eyebrow, h1, the intro slot new-record pages
 * carry), then the field stack and the submit row. `textareaAt` marks the
 * zero-based field(s) that render tall (event notes, meeting attendees AND
 * notes -- hence the array form); `social` appends the bordered Social
 * fieldset after the plain stack.
 */
export function FormPageSkeleton({
  fields,
  textareaAt,
  intro = true,
  social = false,
}: {
  fields: number;
  textareaAt?: number | readonly number[];
  intro?: boolean;
  social?: boolean;
}) {
  const tall = Array.isArray(textareaAt)
    ? (textareaAt as readonly number[])
    : textareaAt === undefined
      ? []
      : [textareaAt as number];
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro={intro} />
      <div aria-hidden="true" className="flex flex-col gap-5">
        {Array.from({ length: fields }, (_, i) => (
          <FieldSkeleton key={i} textarea={tall.includes(i)} />
        ))}
        {social ? <SocialFieldsetSkeleton /> : null}
        <div className="flex flex-wrap items-center gap-4">
          <Bone className="h-11 w-32" />
          <Bone className="h-5 w-16" />
        </div>
      </div>
    </div>
  );
}

/**
 * The workspace hub: name + role line with the admin-links slot, then the
 * stacked bordered cards (upcoming events, open tasks, the navigation
 * sections) each holding an h2 bone and ruled rows.
 */
export function HubSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <div
        aria-hidden="true"
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <Bone className="h-8 w-72 max-w-full" />
          <Bone className="h-5 w-48" />
        </div>
        <Bone className="h-5 w-40" />
      </div>
      {[4, 3, 4].map((rows, i) => (
        <section
          key={i}
          aria-hidden="true"
          className="flex flex-col gap-4 border border-rule bg-surface p-5"
        >
          <Bone className="h-6 w-48" />
          <Bone className="h-5 w-full max-w-prose" />
          <div className="flex flex-col border-t border-rule">
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="flex flex-col gap-2 border-b border-rule py-3">
                <Bone className={`h-5 ${["w-40", "w-56", "w-48"][r % 3]}`} />
                <Bone className="h-4 w-3/4 max-w-prose" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
