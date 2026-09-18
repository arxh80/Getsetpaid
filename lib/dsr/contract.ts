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
 * The transitions the OPERATOR may make. `withdrawn` is the requester's act
 * alone (`public.withdraw_data_subject_request`), and
 * `transition_data_subject_request` refuses it by name.
 */
export function operatorTransitionsFrom(status: string): readonly DsrStatus[] {
  const next = Object.prototype.hasOwnProperty.call(DSR_TRANSITIONS, status)
    ? DSR_TRANSITIONS[status]
    : undefined;
  return (next ?? []).filter((s) => s !== "withdrawn");
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

/**
 * Whole days from `now` until `dueBy`, negative once the deadline has passed.
 *
 * READ-TIME, the house pattern: nothing stores "days remaining" and nothing
 * sweeps it. Days are counted in whole UTC days between the two instants,
 * which is the same arithmetic the generated `due_by` column uses (30 ×
 * 86,400 s), so "0 days left" and "due today" mean the same thing on both
 * sides.
 */
export function daysUntil(dueByIso: string, now: Date = new Date()): number {
  const due = Date.parse(dueByIso);
  if (Number.isNaN(due)) {
    throw new Error(`daysUntil: ${dueByIso} is not a timestamp`);
  }
  return Math.floor((due - now.getTime()) / 86_400_000);
}

export type DsrUrgency = "overdue" | "due_soon" | "on_track" | "closed";

/**
 * How loud the queue should be about one request. `due_soon` uses the same
 * lead time the database's early-warning alert does, so the screen and the
 * email cannot disagree about which requests are urgent.
 */
export function dsrUrgency(
  status: string,
  dueByIso: string,
  now: Date = new Date(),
): DsrUrgency {
  if (isDsrTerminal(status)) return "closed";
  const days = daysUntil(dueByIso, now);
  if (days < 0) return "overdue";
  return days <= DSR_ALERT_LEAD_DAYS ? "due_soon" : "on_track";
}

/** "3 days left", "due today", "2 days overdue" — one sentence, both pages. */
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
  if (days === 0) return "Due today";
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
export const NO_ACCOUNT_ROUTE =
  "This form is for people with a GetSetPaid account: being signed in is how we know the request is really yours. If you have no account, or cannot sign in, email us instead and we will verify your identity another way.";
