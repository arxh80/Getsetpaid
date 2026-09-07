/**
 * The single source of truth for "what areas does this workspace have, and
 * what does each one do" -- consumed by two very different renderers:
 *
 *   - app/(app)/[orgSlug]/page.tsx's card grids (CRM_AREAS, OPERATIONS_AREAS),
 *     which want the long `blurb` sentence.
 *   - components/nav/sidebar.tsx (via app/(app)/[orgSlug]/layout.tsx), which
 *     wants the short `sub` subheading instead -- a sidebar row has room for a
 *     heading and one short line under it, not a sentence.
 *
 * THIS FILE USED TO BE TWO PRIVATE CONST ARRAYS INSIDE page.tsx. Moved here
 * (Sidebar nav build) so the layout does not import from a page module --
 * page.tsx is a leaf, and a parent layout depending on a child page's exports
 * would be the dependency arrow pointing the wrong way, and would drag
 * page.tsx's own imports (query loaders, notFound, generateMetadata) into
 * every route's layout evaluation for no reason. `page.tsx` now imports
 * CRM_AREAS/OPERATIONS_AREAS from here instead of defining them, so there is
 * still exactly one array per group, not two that can drift.
 *
 * NETWORK_ITEMS and ADMIN_ITEMS have no `blurb` twin on the org-home page --
 * Network is four lines of hand-written JSX there (Task 4's directory/
 * profiles/requests/links section) and Admin (Members, Settings) was never a
 * card grid at all, just two conditional links in the header. They exist here
 * only for the sidebar, and their `sub` text is drawn from the same
 * sentences page.tsx already uses to describe each destination.
 */

export interface NavArea {
  /** Path segment(s) under `/${orgSlug}/`, e.g. "contacts" or
   *  "network/profiles". No leading or trailing slash. */
  path: string;
  /** The heading -- what a page card and a sidebar row both show as the
   *  primary label. */
  label: string;
  /** Short subheading for the sidebar (2-5 words) -- NOT the same copy as
   *  `blurb`. A sidebar row that is 44-64px tall cannot carry a sentence;
   *  the sentence stays on the org-home card as `blurb`. */
  sub: string;
}

export interface NavAreaWithBlurb extends NavArea {
  /** The longer sentence app/(app)/[orgSlug]/page.tsx's card grid renders
   *  under the heading. */
  blurb: string;
}

/**
 * The six CRM areas, in the order the workflow uses them.
 *
 * NOT FILTERED BY PERMISSION, deliberately -- carried over unchanged from
 * page.tsx's own comment: every role that reaches an org-scoped route holds
 * `view_crm`, so all six lists are READABLE by all of them, and each list's
 * own empty state explains why a record-scoped user sees fewer rows than
 * their colleagues. Hiding a link because the viewer cannot WRITE there would
 * be the "hidden loses the explanation" mistake components/crm/write-gate.tsx
 * exists to avoid, applied to a read. The sidebar renders this group
 * unconditionally for the same reason.
 */
export const CRM_AREAS: readonly NavAreaWithBlurb[] = [
  {
    path: "contacts",
    label: "Contacts",
    sub: "People you work with",
    blurb:
      "The people this workspace works with — agents, promoters, venue managers, drivers.",
  },
  {
    path: "companies",
    label: "Companies",
    sub: "The businesses behind them",
    blurb:
      "The businesses behind them. A contact can belong to several, and one of them is their main one.",
  },
  {
    path: "artists",
    label: "Artists",
    sub: "Who you book",
    blurb:
      "Who you book. Their representation and their fee history hang off one record.",
  },
  {
    path: "agencies",
    label: "Agencies",
    sub: "Who represents them",
    blurb:
      "Who represents them, in what territory, and from when.",
  },
  {
    path: "venues",
    label: "Venues",
    sub: "Where it happens",
    blurb:
      "Where the events happen, and the rooms inside them events can be assigned to.",
  },
  // LAST, because the workflow arrives here: CLAUDE.md's core sequence is
  // `relationship -> enquiry/hold -> booking/event -> delivery -> settlement`,
  // and an event is the thing the five above get attached to.
  {
    path: "events",
    label: "Events",
    sub: "Shows and their lineups",
    blurb:
      "The nights you are putting on. A date, a venue and a lineup, with everything above it hanging off one record.",
  },
] as const;

/**
 * The four operational areas (Phase 4), in the order they are used: a task is
 * planned, a meeting is held, a note is kept, a file is filed. Not filtered by
 * permission -- same argument as CRM_AREAS.
 */
export const OPERATIONS_AREAS: readonly NavAreaWithBlurb[] = [
  {
    path: "tasks",
    label: "Tasks",
    sub: "What needs doing",
    blurb:
      "What needs doing — chase a contract, confirm a rider, call the venue. With a due date, a priority and the record it is about.",
  },
  {
    path: "meetings",
    label: "Meetings",
    sub: "Calls and catch-ups",
    blurb:
      "Calls and get-togethers, with a time, who came and what was agreed.",
  },
  {
    path: "notes",
    label: "Notes",
    sub: "Kept with a record",
    blurb:
      "Free-form text kept with a record. Private to you, or shared with the workspace.",
  },
  {
    path: "documents",
    label: "Documents",
    sub: "Contracts and riders",
    blurb:
      "Contracts, riders and artwork. Scanned before they can be opened, and attached to the records they are about.",
  },
] as const;

/**
 * The network group's four destinations (Phase 6), in the order the org-home
 * page's own "Network" section already lists them: discover first (the point
 * of an industry network), then your own published identities, then the
 * requests inbox/outbox, then the private-record links. The SIDEBAR gates the
 * whole group on `view_network` (app/(app)/[orgSlug]/layout.tsx) -- once that
 * passes, all four sub-destinations render, same as the org-home section.
 */
export const NETWORK_ITEMS: readonly NavArea[] = [
  {
    path: "network",
    label: "Directory",
    sub: "Discover and connect",
  },
  {
    path: "network/profiles",
    label: "Your profiles",
    sub: "Your published identities",
  },
  {
    path: "network/requests",
    label: "Requests",
    sub: "Sent and received",
  },
  {
    path: "network/links",
    label: "Linked records",
    sub: "Match to your own records",
  },
] as const;

/**
 * The admin group. Unlike CRM_AREAS/OPERATIONS_AREAS/NETWORK_ITEMS, each of
 * these two is gated INDIVIDUALLY (app/(app)/[orgSlug]/layout.tsx), matching
 * the org-home page's own header links -- `manage_members` and
 * `manage_custom_fields` are two different permissions Owner and Admin both
 * hold and nobody else does, so a Manager who can invite people but not
 * define fields sees "Members" without "Settings", not both or neither.
 * "Settings" routes to /settings/custom-fields, the only settings route that
 * exists -- there is no bare /settings page to link to instead.
 */
export const ADMIN_ITEMS: readonly NavArea[] = [
  {
    path: "members",
    label: "Members",
    sub: "Who's in this workspace",
  },
  {
    path: "settings/custom-fields",
    label: "Settings",
    sub: "Custom fields and config",
  },
] as const;
