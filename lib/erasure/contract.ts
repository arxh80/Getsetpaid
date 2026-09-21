// Account erasure: the closed vocabularies, the copy and the pure helpers,
// shared by the page, the server action, the runner and the tests.
//
// PURE. No "server-only", no Supabase import — the unit suite drives every
// helper here and the client components read the labels.
//
// IT IS ALSO NOT A "use server" MODULE, and that is load-bearing rather than
// tidy: `lib/erasure/actions.ts` carries "use server", and such a module may
// export nothing but async functions — a single `export const` silently drops
// EVERY export from it for the client and SSR graphs and takes the page down,
// invisibly to lint, tsc and the unit suite (Phase 8 Task 3 shipped exactly
// that). `lib/export/contract.ts` is the precedent this file follows.

/** public.erasure_jobs.kind. */
export const ERASURE_KINDS = ["account", "workspace"] as const;
export type ErasureKind = (typeof ERASURE_KINDS)[number];

/** public.erasure_jobs.status. */
export const ERASURE_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

export const ERASURE_STATUS_LABELS: Record<ErasureStatus, string> = {
  queued: "Waiting to start",
  running: "Being deleted",
  succeeded: "Deleted",
  failed: "Could not be deleted",
};

/** Where a person asks for their account to be deleted. */
export const ACCOUNT_ERASE_PATH = "/account/erase";

/** What `private.account_erasure_blockers()` says is in the way. */
export type ErasureBlockerReason =
  | "other_members"
  | "workspace_has_data"
  /**
   * The subject is NOT an Owner of this workspace -- it has no active Owner
   * at all and they are its last active member. Neither Q131 remedy is
   * theirs: there is nobody to promote, and no member-facing route to close
   * a workspace exists anywhere in this product (fix round 2, N2/Q178).
   */
  | "no_owner_to_transfer";

export interface ErasureBlocker {
  readonly organisationName: string;
  readonly reason: ErasureBlockerReason;
}

/**
 * The sentence a blocked person reads, naming their own workspaces.
 *
 * Q131 says the refusal must say what to do first. A refusal that only says
 * "no" leaves somebody exercising a statutory right with nothing to act on,
 * so the two reasons get two different instructions: a workspace with other
 * people in it needs another owner; an empty one with records in it can
 * simply be closed.
 */
export function describeBlockers(blockers: readonly ErasureBlocker[]): string | null {
  if (blockers.length === 0) return null;
  const owned = blockers.filter((b) => b.reason !== "no_owner_to_transfer");
  const unowned = blockers.filter((b) => b.reason === "no_owner_to_transfer");
  const sentences: string[] = [];

  if (owned.length > 0) {
    const list = nameList(owned);
    const plural = owned.length === 1 ? "this workspace" : "these workspaces";
    sentences.push(
      `You are the only owner of ${list}. Deleting your account would leave ${plural} ` +
        `with nobody able to manage it, so we cannot do it yet. Make somebody else an owner ` +
        `there, or close the workspace, and then come back.`,
    );
  }

  if (unowned.length > 0) {
    // N2/Q178: the other branch used to be told to do two things it cannot
    // do. There is nobody to promote and no member-facing route to close a
    // workspace, so the only door that opens is support's.
    const list = nameList(unowned);
    const plural = unowned.length === 1 ? "it" : "them";
    sentences.push(
      `${list} ${unowned.length === 1 ? "has" : "have"} no owner at all, and you are the last ` +
        `person in ${plural}. Deleting your account would leave ${plural} with nobody able to ` +
        `manage ${plural}, so we cannot do it yet — and you cannot make somebody else an owner ` +
        `or close ${plural} yourself. Contact support and ask them to close ${plural}, and then come back.`,
    );
  }

  return sentences.join(" ");
}

function nameList(blockers: readonly ErasureBlocker[]): string {
  const names = blockers.map((b) => b.organisationName);
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * THE TWO LISTS THE PAGE HAS TO BE HONEST ABOUT, in one place so the page and
 * its e2e assertion cannot drift, and so that what the database actually does
 * and what the person is told are edited in the same commit.
 */
export const ERASURE_DELETES: readonly string[] = [
  "Your sign-in: your email address, your password and any two-factor factors. You will not be able to sign in again, and we cannot undo this.",
  "Your profile — your name and picture — and your membership of every workspace.",
  "Your private notes. A note you marked private is readable only by you, so it goes with you.",
  "Your marketing choices, the feedback you have sent us and any screenshots attached to it, and any copies of your data you have downloaded.",
];

export const ERASURE_KEEPS: readonly string[] = [
  "A workspace's records — its contacts, artists, events, documents and finances — belong to the business that keeps them, not to your account. They stay, and they stop being attributed to you.",
  "Notes you marked as visible to a workspace stay with that workspace, with your name removed.",
  "The security audit log keeps what happened and loses who did it: every row of yours is re-pointed at a single, shared “erased user” identity that nobody can sign in as. We keep it because it is the evidence that this product did what it says.",
  "Financial records are kept for seven years, as the law requires. Your name comes off them.",
  "Your data protection requests, including this one, are kept without your email address or anything you wrote in them. They are the evidence that we answered you inside the legal deadline.",
];

/**
 * The one thing that is NOT on either list, said separately because it is the
 * only irreversible-and-surprising consequence: a workspace you are the last
 * owner of, with nobody else in it and nothing in it, goes with you.
 */
export const ERASURE_EMPTY_WORKSPACE_NOTE =
  "If you are the only person in a workspace and it has nothing in it, that workspace is deleted too — leaving an empty workspace nobody owns would help nobody.";

/** The phrase a person types to confirm. Compared case-insensitively, trimmed. */
export const ERASURE_CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";

export function confirmationMatches(typed: string | null | undefined): boolean {
  if (typeof typed !== "string") return false;
  return typed.trim().toLocaleUpperCase("en-GB") === ERASURE_CONFIRMATION_PHRASE;
}

export const ERASURE_STARTED_MESSAGE =
  "Your account is being deleted. This page shows its progress — when it finishes you will be signed out and this page will no longer exist.";

export const ERASURE_ALREADY_RUNNING =
  "Your account is already being deleted. Wait for that to finish.";

export const ERASURE_NEEDS_CONFIRMATION =
  `Type ${ERASURE_CONFIRMATION_PHRASE} exactly to confirm. Nothing has been deleted.`;

export const ERASURE_NEEDS_STEP_UP =
  "Confirm it is you before deleting your account. Use the prompt on this page, then ask again.";

export const ERASURE_RATE_LIMITED_PREFIX = "Too many attempts to delete this account.";

/**
 * A summary's counts, rendered for the operator and for the person's own last
 * view of the page. It is deliberately not a full table of every key: the
 * summary is a machine record and the page shows the two numbers a human
 * cares about.
 */
export function summaryHeadline(summary: Record<string, unknown> | null): string | null {
  if (summary === null) return null;
  if (summary.already_erased === true) return "This account had already been deleted.";
  const refs = summary.tombstoned_references;
  const notes = summary["notes.private_deleted"];
  if (typeof refs !== "number") return "Deleted.";
  const notePart =
    typeof notes === "number" && notes > 0
      ? `, and ${notes} private ${notes === 1 ? "note was" : "notes were"} deleted`
      : "";
  return `Deleted. ${refs} audit and history ${refs === 1 ? "record was" : "records were"} kept without your name${notePart}.`;
}
