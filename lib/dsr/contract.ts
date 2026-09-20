// Data subject requests: the closed vocabularies, the clock and the copy,
// shared by the requester's page, the operator's queue, the server actions
// and the tests.
//
// PURE. No "server-only", no Supabase import — the unit suite drives every
// parser here and the client components read the labels. Everything that also
// lives in the database (20260924000000 / 20260924001000) is mirrored here for
// the pickers and the copy; the database is the enforcement, this is the
// vocabulary, and tests/integration/legal/catalogue-bindings-match-db.test.ts
// asserts the two agree against a real Postgres.

/** PRD §12's Data Subject Rights page, and private.dsr_rights(). */
export const DSR_RIGHTS = [
  "access",
  "rectification",
  "erasure",
  "restriction",
  "objection",
  "portability",
] as const;
export type DsrRight = (typeof DSR_RIGHTS)[number];

export interface DsrRightCopy {
  /** The heading on the picker. */
  readonly label: string;
  /** What choosing it means, in the person's own terms. */
  readonly blurb: string;
  /**
   * Which later task's job must have run before an ACCOUNT-scope request of
   * this right can be marked fulfilled — `private.dsr_rights().fulfilment_kind`.
   * Dormant until Task 4/5 ship (`private.dsr_fulfilment_jobs_ready()`).
   */
  readonly fulfilmentKind: DsrFulfilmentKind | null;
}

export type DsrFulfilmentKind = "export" | "erasure";

export const DSR_RIGHT_COPY: Record<DsrRight, DsrRightCopy> = {
  access: {
    label: "A copy of my data (access)",
    blurb: "We send you what we hold about you and explain what we use it for.",
    fulfilmentKind: "export",
  },
  rectification: {
    label: "Correct something wrong (rectification)",
    blurb: "Tell us what is wrong and what it should say, and we correct it.",
    fulfilmentKind: null,
  },
  erasure: {
    label: "Delete my data (erasure)",
    blurb:
      "We delete what we can and tell you what we must keep, and why — some records, such as the security audit trail, we are required to hold on to.",
    fulfilmentKind: "erasure",
  },
  restriction: {
    label: "Limit how my data is used (restriction)",
    blurb: "We keep your data but stop using it, while something is in dispute.",
    fulfilmentKind: null,
  },
  objection: {
    label: "Object to a use of my data (objection)",
    blurb:
      "You object to something we do on the basis of our legitimate interests. Say which use, and we stop it unless we can show compelling grounds not to.",
    fulfilmentKind: null,
  },
  portability: {
    label: "My data in a portable format (portability)",
    blurb: "We send you the data you gave us, in a machine-readable file.",
    fulfilmentKind: "export",
  },
};

/**
 * Q132, the controller/processor split, as the person making the request
 * experiences it. `account` = GetSetPaid is the controller and answers it;
 * `workspace_records` = a customer workspace is the controller, and the
 * operator routes it there rather than answering on their behalf.
 */
export const DSR_SCOPES = ["account", "workspace_records"] as const;
export type DsrScope = (typeof DSR_SCOPES)[number];

export const DSR_SCOPE_COPY: Record<DsrScope, { label: string; blurb: string }> = {
  account: {
    label: "My GetSetPaid account",
    blurb:
      "Your sign-in, your profile, the workspaces you belong to, feedback you sent and the record of what you did in the product. GetSetPaid decides how this data is used, so we answer this ourselves.",
  },
  workspace_records: {
    label: "Records a business keeps about me in GetSetPaid",
    blurb:
      "For example, you are saved as a contact or an artist in a promoter's workspace. That business decides what it keeps and why — it is the controller and we only hold the data for it — so we pass your request to them and help them answer it. Tell us below which business, as best you can.",
  },
};

export const DSR_STATUSES = [
  "open",
  "in_progress",
  "routed",
  "fulfilled",
  "rejected",
  "withdrawn",
] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];

/** What the REQUESTER reads. */
export const DSR_STATUS_LABELS: Record<DsrStatus, string> = {
  open: "Received",
  in_progress: "Being worked on",
  routed: "Passed to the business",
  fulfilled: "Answered",
  rejected: "Refused",
  withdrawn: "Withdrawn",
};

/** Nothing further happens to a request in one of these states. */
export const DSR_TERMINAL_STATUSES = ["fulfilled", "rejected", "withdrawn"] as const;

export function isDsrTerminal(status: string): boolean {
  return (DSR_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * `private.dsr_transition_allowed()`, mirrored. The database is the
 * enforcement; this is what decides which buttons the operator's page draws,
 * and the integration test asserts the two agree row by row.
 *
 * Terminal states are absent as keys ON PURPOSE rather than mapped to `[]`:
 * a closed request is answered by filing a new one, so nothing rewrites the
 * record of what was answered and when.
 */
export const DSR_TRANSITIONS: Readonly<Record<string, readonly DsrStatus[]>> = {
  open: ["in_progress", "routed", "fulfilled", "rejected", "withdrawn"],
  in_progress: ["routed", "fulfilled", "rejected", "withdrawn"],
  routed: ["fulfilled", "rejected", "withdrawn"],
};

export function dsrTransitionAllowed(from: string, to: string): boolean {
  const next = Object.prototype.hasOwnProperty.call(DSR_TRANSITIONS, from)
    ? DSR_TRANSITIONS[from]
    : undefined;
  return next !== undefined && (next as readonly string[]).includes(to);
}

/**
 * The transitions the OPERATOR may make through
 * `public.transition_data_subject_request`, which refuses two of the table's
 * states BY NAME and so cannot be a button:
 *
 *   * `withdrawn` is the requester's act alone
 *     (`public.withdraw_data_subject_request`);
 *   * `routed` has its own function since fix round 1 (Q160a),
 *     `public.route_data_subject_request`, because a routing must also carry
 *     the workspace and the handover note and a deferred constraint trigger
 *     refuses one without a note. `operatorMayRoute()` below is the control
 *     that draws it.
 */
export function operatorTransitionsFrom(status: string): readonly DsrStatus[] {
  const next = Object.prototype.hasOwnProperty.call(DSR_TRANSITIONS, status)
    ? DSR_TRANSITIONS[status]
    : undefined;
  return (next ?? []).filter((s) => s !== "withdrawn" && s !== "routed");
}

/**
 * Whether the operator may pass this request to a customer workspace -- or
 * CORRECT the workspace a routed one already names (Q160c).
 *
 * SCOPE, NOT ONLY STATUS (review finding M7). `routed` was drawn from the
 * transition table alone, so an ACCOUNT-scope row -- one GetSetPaid itself is
 * the controller of -- offered "Pass to the business", and the only outcome
 * the click could ever have was the trigger's `not_a_processor_request`. A
 * control whose sole result is an error, on a page where the wrong click on
 * the RIGHT kind of row is irreversible.
 *
 * A routed request stays routable so a mistyped slug is correctable: the
 * database treats naming a DIFFERENT workspace as a re-route (audited as
 * `data_subject_request.rerouted`) and naming the same one as
 * `not_a_transition`.
 */
export function operatorMayRoute(status: string, subjectScope: string): boolean {
  if (subjectScope !== "workspace_records") return false;
  return status === "open" || status === "in_progress" || status === "routed";
}

/** The statutory window — `private.dsr_response_days()`. */
export const DSR_RESPONSE_DAYS = 30;

/** How far ahead the early-warning alert fires — `private.dsr_alert_lead_days()`. */
export const DSR_ALERT_LEAD_DAYS = 7;

/** public.data_subject_requests.detail's CHECK. */
export const DSR_DETAIL_MAX = 4000;
/** public.data_subject_requests.rejection_reason's CHECK. */
export const DSR_REJECTION_REASON_MAX = 2000;
/** public.data_subject_request_notes.body's CHECK. */
export const DSR_NOTE_MAX = 4000;

/** Where a signed-in person makes and tracks these requests. */
export const ACCOUNT_DATA_REQUESTS_PATH = "/account/data-requests";
/** Where the operator works them. */
export const SUPER_DATA_REQUESTS_PATH = "/super/data-requests";

/**
 * OWN KEYS ONLY, not `in` — the incident-alert filter's lesson
 * (lib/admin/health.ts): `"toString" in LABELS` is true, and a query-string
 * value that passes an allowlist by way of Object.prototype is a filter
 * nobody wrote.
 */
export function isDsrRight(value: string): value is DsrRight {
  return Object.prototype.hasOwnProperty.call(DSR_RIGHT_COPY, value);
}

export function isDsrScope(value: string): value is DsrScope {
  return Object.prototype.hasOwnProperty.call(DSR_SCOPE_COPY, value);
}

export function isDsrStatus(value: string): value is DsrStatus {
  return Object.prototype.hasOwnProperty.call(DSR_STATUS_LABELS, value);
}

const DAY_MS = 86_400_000;

function instant(dueByIso: string): number {
  const due = Date.parse(dueByIso);
  if (Number.isNaN(due)) {
    throw new Error(`dsr: ${dueByIso} is not a timestamp`);
  }
  return due;
}

/**
 * Whole days from `now` until `dueBy` — 0 on the day it is due, negative once
 * it has passed.
 *
 * READ-TIME, the house pattern: nothing stores "days remaining" and nothing
 * sweeps it. `Math.floor` on the way up and `Math.ceil` on the way down, so
 * the count is "whole days away in the direction it is going" in both
 * directions — plain `Math.floor` calls 25 hours late "2 days overdue", which
 * is the kind of small lie a person notices on the one screen that is telling
 * them their statutory deadline slipped.
 */
export function daysUntil(dueByIso: string, now: Date = new Date()): number {
  const delta = instant(dueByIso) - now.getTime();
  return delta >= 0 ? Math.floor(delta / DAY_MS) : Math.ceil(delta / DAY_MS);
}

export type DsrUrgency = "overdue" | "due_soon" | "on_track" | "closed";

/**
 * How loud the queue should be about one request.
 *
 * OVERDUE IS THE INSTANT COMPARISON, not the day count: an hour past the
 * deadline is past the deadline, and rounding it to "0 days" would render it
 * as on track. `due_soon` uses the same lead time the database's early-warning
 * alert does, so the screen and the email cannot disagree about which requests
 * are urgent.
 */
export function dsrUrgency(
  status: string,
  dueByIso: string,
  now: Date = new Date(),
): DsrUrgency {
  if (isDsrTerminal(status)) return "closed";
  const delta = instant(dueByIso) - now.getTime();
  if (delta <= 0) return "overdue";
  return delta <= DSR_ALERT_LEAD_DAYS * DAY_MS ? "due_soon" : "on_track";
}

/** "3 days left", "Due today", "Overdue today", "2 days overdue" — one
 *  sentence, both pages. */
export function describeDeadline(
  status: string,
  dueByIso: string,
  now: Date = new Date(),
): string {
  if (isDsrTerminal(status)) return "Closed";
  const days = daysUntil(dueByIso, now);
  if (days < 0) {
    const late = Math.abs(days);
    return late === 1 ? "1 day overdue" : `${late} days overdue`;
  }
  if (days === 0) {
    return instant(dueByIso) <= now.getTime() ? "Overdue today" : "Due today";
  }
  return days === 1 ? "1 day left" : `${days} days left`;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The warning beside the operator's rejection-reason field, verbatim and in
 * one place so the form and the e2e assertion cannot drift. The Q103
 * precedent, established for `organisations.lifecycle_reason`: untrusted
 * operator text that another party reads has to say so where it is typed.
 */
export const REJECTION_REASON_WARNING =
  "The person who made the request will read this exactly as you write it. Say why their request is refused and which law allows it.";

/**
 * The sentence the requester's page shows about requests we cannot take here.
 * The Data Subject Rights page carries the same position (version 2).
 */
/**
 * The warning beside the operator's routing form, verbatim and in one place
 * (review finding I7 / founder question Q160a).
 *
 * "Pass it on" used to tell the requester "we passed this to the business
 * ... it is the one that must answer you", and the product passes nothing to
 * anybody: routing is one UPDATE, the routed workspace has no read of the
 * request, no page, no count and no email (Q45). So the form says what is
 * really true -- nothing is sent, and the operator is the one who has to
 * write -- and the handover note below records that they did.
 */
export const ROUTING_SENDS_NOTHING =
  "Nothing is sent. There is no workspace-side inbox and no notification in this product, so recording this does not tell the business anything: you must email the workspace’s Owner yourself, now. The note below is the record that you did.";

/** The hint on the routing form's mandatory handover note (Q160a). */
export const ROUTING_HANDOVER_HINT =
  "Say how and when you told them — the address you wrote to, and when. Kept in the operator notes, which the requester never sees. The database refuses a routing that records no handover.";

/** What the REQUESTER reads once a request has been passed on (Q160b). */
export function routedNoticeFor(organisationName: string | null): string {
  const who = organisationName ?? "the business that holds the records";
  return (
    `We have asked ${who} to answer this. It — not GetSetPaid — decides what it keeps ` +
    "about you and why, so it is the one that has to reply to you. If you do not hear from " +
    "them, tell us and we will chase it."
  );
}

export const NO_ACCOUNT_ROUTE =
  "This form is for people with a GetSetPaid account: being signed in is how we know the request is really yours. If you have no account, or cannot sign in, email us instead and we will verify your identity another way.";

/**
 * The key the routing form reads a resolved workspace name back from, and the
 * key it sends the operator's confirmation on. Shared so the form, the action
 * and the unit suite cannot drift.
 *
 * THESE LIVE HERE AND NOT BESIDE THE ACTION, AND THAT IS NOT A PREFERENCE.
 * `lib/dsr/admin-actions.ts` carries `"use server"`, and a "use server" module
 * may export nothing but async functions. Exporting these two string constants
 * from it did not fail the build or the type check: Next's compiler dropped
 * EVERY export from the module for the client and SSR graphs, so
 * `/super/data-requests` — the whole operator queue — failed to compile at
 * request time with "the module has no exports at all". Nothing caught it
 * because the unit suite imports the module directly (where the constants are
 * ordinary exports) and the gates were not run in the round that added them;
 * the first real browser run found it in seconds.
 */
export const ROUTING_RESOLVED_NAME_KEY = "resolvedOrganisationName";
export const ROUTING_CONFIRMED_SLUG_KEY = "confirmedSlug";
