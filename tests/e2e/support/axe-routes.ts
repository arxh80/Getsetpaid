import type { E2eWorld } from "./fixtures";

// THE ONE DECLARED LIST OF WHAT AXE SCANS (Phase 10 Task 15, G21).
//
// Three lists, and tests/unit/design/axe-route-census.test.ts asserts that
// between them they name every app/**/page.tsx route exactly once:
//
//   AXE_PAGES          scanned by the loop in accessibility.spec.ts, one test
//                      per page (see that file for why one per page)
//   SCANNED_ELSEWHERE  scanned by a dedicated test that first puts the page in
//                      a state the loop cannot (a role, a populated row, an
//                      open dialog); `spec` names the file
//   EXEMPT             not scanned, with the reason
//
// A new page lands as a red census until it is added to one of them.

export type AxeRole = "signed-out" | "manager" | "superuser";

/** The world plus the records fixtures.ts's plantAxeRecords() adds for this spec. */
export type AxeWorld = E2eWorld & {
  readonly companyId: string;
  readonly agencyId: string;
  readonly mergeCandidateId: string;
};

export interface AxePage {
  /** The route as app/ spells it, route groups removed. */
  readonly route: string;
  readonly label: string;
  readonly url: (w: AxeWorld) => string;
  readonly role: AxeRole;
}

export const AXE_PAGES: readonly AxePage[] = [
  { route: "/[orgSlug]/contacts", label: "contacts list", url: (w) => `/${w.orgSlug}/contacts`, role: "manager" },
  { route: "/[orgSlug]/contacts/new", label: "new contact", url: (w) => `/${w.orgSlug}/contacts/new`, role: "manager" },
  {
    route: "/[orgSlug]/contacts/[contactId]",
    label: "contact detail + timeline",
    url: (w) => `/${w.orgSlug}/contacts/${w.managerOwnedContactId}`,
    role: "manager",
  },
  { route: "/[orgSlug]/companies", label: "companies list", url: (w) => `/${w.orgSlug}/companies`, role: "manager" },
  { route: "/[orgSlug]/companies/new", label: "new company", url: (w) => `/${w.orgSlug}/companies/new`, role: "manager" },
  { route: "/[orgSlug]/artists/new", label: "new artist", url: (w) => `/${w.orgSlug}/artists/new`, role: "manager" },
  { route: "/[orgSlug]/venues/new", label: "new venue", url: (w) => `/${w.orgSlug}/venues/new`, role: "manager" },
  // ---- PHASE 3'S FOUR SURFACES (Task 8 brief § 3) --------------------------
  // The list, the create form, a detail page and the deleted list. The DETAIL
  // page carries three lib/list/ surfaces at once (the lineup panel, the
  // custom-fields panel and the activity timeline), plus the status chip, so
  // it is where a duplicate `id`, an orphaned `aria-describedby` or a second
  // `role="list"` with no accessible name would land first.
  { route: "/[orgSlug]/events", label: "events list", url: (w) => `/${w.orgSlug}/events`, role: "manager" },
  { route: "/[orgSlug]/events/new", label: "new event", url: (w) => `/${w.orgSlug}/events/new`, role: "manager" },
  {
    // ALSO THE THREE-LIST RELATED PANEL (Task 8 brief § 3): the operations
    // fixtures link a task and a document to this event, so the panel is
    // POPULATED here rather than rendering three empty states.
    route: "/[orgSlug]/events/[eventId]",
    label: "event detail + lineup + timeline + related panel",
    url: (w) => `/${w.orgSlug}/events/${w.managerOwnedEventId}`,
    role: "manager",
  },
  { route: "/[orgSlug]/events/deleted", label: "deleted events", url: (w) => `/${w.orgSlug}/events/deleted`, role: "manager" },
  // ---- PHASE 4'S OPERATIONS SURFACES (Task 8 brief § 3) --------------------
  // The documents list carries the SCAN CHIP and the inline download/delete
  // controls; the task detail carries the PRIORITY CHIP, the task-status chip
  // and the entity-link picker.
  { route: "/[orgSlug]/tasks", label: "tasks list", url: (w) => `/${w.orgSlug}/tasks`, role: "manager" },
  { route: "/[orgSlug]/tasks/new", label: "new task", url: (w) => `/${w.orgSlug}/tasks/new`, role: "manager" },
  { route: "/[orgSlug]/tasks/[taskId]", label: "task detail + link picker", url: (w) => `/${w.orgSlug}/tasks/${w.taskId}`, role: "manager" },
  { route: "/[orgSlug]/notes", label: "notes list", url: (w) => `/${w.orgSlug}/notes`, role: "manager" },
  { route: "/[orgSlug]/documents", label: "documents list + scan chips", url: (w) => `/${w.orgSlug}/documents`, role: "manager" },
  { route: "/[orgSlug]/documents/deleted", label: "deleted documents", url: (w) => `/${w.orgSlug}/documents/deleted`, role: "manager" },
  // ---- PHASE 6 (NETWORK), TASK 2 -------------------------------------------
  // Empty for the manager's own workspace (nothing published by the
  // fixtures), a real and common state: the "Publish a record" picker, the
  // empty-state copy and the toolbar all render over zero rows. The EDITOR
  // needs a real profile and has its own test in accessibility.spec.ts.
  { route: "/[orgSlug]/network/profiles", label: "network profiles list", url: (w) => `/${w.orgSlug}/network/profiles`, role: "manager" },
  // ---- PHASE 8 TASK 5 (ERASURE) --------------------------------------------
  // As the MANAGER, so the control is REACHABLE: a Manager is the last Owner
  // of nothing, so the typed-confirmation field and its danger button are in
  // the tree. As an Owner it would be prose and a disabled button.
  { route: "/account/erase", label: "delete your account", url: () => "/account/erase", role: "manager" },
  // ---- PHASE 10 TASK 22 ----------------------------------------------------
  // Scanned, never pressed: a global sign-out would end the manager's other
  // sessions mid-run.
  { route: "/account/sessions", label: "sign out everywhere", url: () => "/account/sessions", role: "manager" },
  { route: "/login", label: "/login", url: () => "/login", role: "signed-out" },
  // ---- PHASE 10 TASK 15 (G21): THE 42 PAGES THAT HAD NEVER BEEN SCANNED ----
  // Signed out, and the two signed-in pages before a workspace exists.
  { route: "/signup", label: "/signup", url: () => "/signup", role: "signed-out" },
  { route: "/signup/check-email", label: "/signup/check-email", url: () => "/signup/check-email", role: "signed-out" },
  { route: "/magic-link", label: "/magic-link", url: () => "/magic-link", role: "signed-out" },
  { route: "/magic-link/sent", label: "/magic-link/sent", url: () => "/magic-link/sent", role: "signed-out" },
  { route: "/onboarding", label: "onboarding", url: () => "/onboarding", role: "manager" },
  { route: "/invites", label: "invites", url: () => "/invites", role: "manager" },
  // Workspace-level. The merge screen is a planted agency pair.
  { route: "/[orgSlug]/merges", label: "merge history", url: (w) => `/${w.orgSlug}/merges`, role: "manager" },
  { route: "/[orgSlug]/duplicates", label: "duplicates queue", url: (w) => `/${w.orgSlug}/duplicates`, role: "manager" },
  { route: "/[orgSlug]/duplicates/resolved", label: "resolved duplicates", url: (w) => `/${w.orgSlug}/duplicates/resolved`, role: "manager" },
  {
    route: "/[orgSlug]/duplicates/[candidateId]",
    label: "merge screen",
    url: (w) => `/${w.orgSlug}/duplicates/${w.mergeCandidateId}`,
    role: "manager",
  },
  { route: "/[orgSlug]/network/links", label: "network links", url: (w) => `/${w.orgSlug}/network/links`, role: "manager" },
  // Agencies, every page.
  { route: "/[orgSlug]/agencies", label: "agencies list", url: (w) => `/${w.orgSlug}/agencies`, role: "manager" },
  { route: "/[orgSlug]/agencies/new", label: "new agency", url: (w) => `/${w.orgSlug}/agencies/new`, role: "manager" },
  { route: "/[orgSlug]/agencies/[agencyId]", label: "agency detail", url: (w) => `/${w.orgSlug}/agencies/${w.agencyId}`, role: "manager" },
  { route: "/[orgSlug]/agencies/[agencyId]/edit", label: "edit agency", url: (w) => `/${w.orgSlug}/agencies/${w.agencyId}/edit`, role: "manager" },
  { route: "/[orgSlug]/agencies/deleted", label: "deleted agencies", url: (w) => `/${w.orgSlug}/agencies/deleted`, role: "manager" },
  // Meetings, every page.
  { route: "/[orgSlug]/meetings", label: "meetings list", url: (w) => `/${w.orgSlug}/meetings`, role: "manager" },
  { route: "/[orgSlug]/meetings/new", label: "new meeting", url: (w) => `/${w.orgSlug}/meetings/new`, role: "manager" },
  { route: "/[orgSlug]/meetings/[meetingId]", label: "meeting detail", url: (w) => `/${w.orgSlug}/meetings/${w.meetingId}`, role: "manager" },
  { route: "/[orgSlug]/meetings/[meetingId]/edit", label: "edit meeting", url: (w) => `/${w.orgSlug}/meetings/${w.meetingId}/edit`, role: "manager" },
  { route: "/[orgSlug]/meetings/deleted", label: "deleted meetings", url: (w) => `/${w.orgSlug}/meetings/deleted`, role: "manager" },
  // Artists, venues and companies: the detail pages carry the representations,
  // rooms and linked-contacts panels.
  { route: "/[orgSlug]/artists", label: "artists list", url: (w) => `/${w.orgSlug}/artists`, role: "manager" },
  { route: "/[orgSlug]/artists/[artistId]", label: "artist detail + representations", url: (w) => `/${w.orgSlug}/artists/${w.artistId}`, role: "manager" },
  { route: "/[orgSlug]/artists/[artistId]/edit", label: "edit artist", url: (w) => `/${w.orgSlug}/artists/${w.artistId}/edit`, role: "manager" },
  { route: "/[orgSlug]/artists/deleted", label: "deleted artists", url: (w) => `/${w.orgSlug}/artists/deleted`, role: "manager" },
  { route: "/[orgSlug]/venues", label: "venues list", url: (w) => `/${w.orgSlug}/venues`, role: "manager" },
  { route: "/[orgSlug]/venues/[venueId]", label: "venue detail + rooms", url: (w) => `/${w.orgSlug}/venues/${w.venueId}`, role: "manager" },
  { route: "/[orgSlug]/venues/[venueId]/edit", label: "edit venue", url: (w) => `/${w.orgSlug}/venues/${w.venueId}/edit`, role: "manager" },
  { route: "/[orgSlug]/venues/deleted", label: "deleted venues", url: (w) => `/${w.orgSlug}/venues/deleted`, role: "manager" },
  { route: "/[orgSlug]/companies/[companyId]", label: "company detail + linked contacts", url: (w) => `/${w.orgSlug}/companies/${w.companyId}`, role: "manager" },
  { route: "/[orgSlug]/companies/[companyId]/edit", label: "edit company", url: (w) => `/${w.orgSlug}/companies/${w.companyId}/edit`, role: "manager" },
  { route: "/[orgSlug]/companies/deleted", label: "deleted companies", url: (w) => `/${w.orgSlug}/companies/deleted`, role: "manager" },
  // Notes, contacts, tasks and events: the pages their lists' scans missed.
  { route: "/[orgSlug]/notes/new", label: "new note", url: (w) => `/${w.orgSlug}/notes/new`, role: "manager" },
  { route: "/[orgSlug]/notes/[noteId]", label: "note detail", url: (w) => `/${w.orgSlug}/notes/${w.privateNoteId}`, role: "manager" },
  { route: "/[orgSlug]/notes/[noteId]/edit", label: "edit note", url: (w) => `/${w.orgSlug}/notes/${w.privateNoteId}/edit`, role: "manager" },
  { route: "/[orgSlug]/notes/deleted", label: "deleted notes", url: (w) => `/${w.orgSlug}/notes/deleted`, role: "manager" },
  { route: "/[orgSlug]/contacts/[contactId]/edit", label: "edit contact", url: (w) => `/${w.orgSlug}/contacts/${w.managerOwnedContactId}/edit`, role: "manager" },
  { route: "/[orgSlug]/contacts/deleted", label: "deleted contacts", url: (w) => `/${w.orgSlug}/contacts/deleted`, role: "manager" },
  { route: "/[orgSlug]/tasks/[taskId]/edit", label: "edit task", url: (w) => `/${w.orgSlug}/tasks/${w.taskId}/edit`, role: "manager" },
  { route: "/[orgSlug]/tasks/deleted", label: "deleted tasks", url: (w) => `/${w.orgSlug}/tasks/deleted`, role: "manager" },
  { route: "/[orgSlug]/events/[eventId]/edit", label: "edit event", url: (w) => `/${w.orgSlug}/events/${w.managerOwnedEventId}/edit`, role: "manager" },
  // The operator console's landing page, which no spec scanned either.
  { route: "/super", label: "superuser overview", url: () => "/super", role: "superuser" },
];

export const SCANNED_ELSEWHERE: readonly { route: string; spec: string }[] = [
  { route: "/[orgSlug]", spec: "keyboard.spec.ts" },
  { route: "/[orgSlug]/settings/custom-fields", spec: "accessibility.spec.ts" },
  { route: "/[orgSlug]/settings/export", spec: "workspace-closure.spec.ts" },
  { route: "/[orgSlug]/support-access", spec: "impersonation.spec.ts" },
  { route: "/[orgSlug]/members", spec: "members.spec.ts" },
  { route: "/[orgSlug]/network", spec: "accessibility.spec.ts" },
  { route: "/[orgSlug]/network/[profileId]", spec: "accessibility.spec.ts" },
  { route: "/[orgSlug]/network/profiles/[profileId]", spec: "accessibility.spec.ts" },
  { route: "/[orgSlug]/network/requests", spec: "accessibility.spec.ts" },
  { route: "/account/data-requests", spec: "data-requests.spec.ts" },
  { route: "/account/exports", spec: "exports.spec.ts" },
  { route: "/account/privacy", spec: "consent.spec.ts" },
  { route: "/legal", spec: "legal.spec.ts" },
  { route: "/legal/[slug]", spec: "legal.spec.ts" },
  { route: "/set-password", spec: "first-proof-password.spec.ts" },
  { route: "/super/audit-log", spec: "accessibility.spec.ts" },
  { route: "/super/billing", spec: "overrides.spec.ts" },
  { route: "/super/closures", spec: "super-closures.spec.ts" },
  { route: "/super/data-requests", spec: "data-requests.spec.ts" },
  { route: "/super/feedback", spec: "feedback.spec.ts" },
  { route: "/super/health", spec: "platform-health.spec.ts" },
  { route: "/super/impersonation", spec: "impersonation.spec.ts" },
  { route: "/super/legal", spec: "legal.spec.ts" },
  { route: "/super/organisations", spec: "organisation-lifecycle.spec.ts" },
];

export const EXEMPT: readonly { route: string; reason: string }[] = [
  {
    route: "/",
    reason: "the post-authentication hub renders nothing: it always redirects (sign in, a workspace, invites or onboarding)",
  },
  {
    route: "/super/[...unknown]",
    reason: "always notFound(): it renders the in-app 404, which accessibility.spec.ts scans directly",
  },
];
