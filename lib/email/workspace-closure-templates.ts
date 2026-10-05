// THE WORKSPACE-CLOSURE NOTICES, AS PURE BUILDERS WITH AN ALLOWLIST.
//
// Founder 2026-09-30, Q176/Q178 (changed, reversing Q104); the delivery half is
// lib/email/workspace-closure-notifications.ts, the database half
// 20261022001000 (the two resolvers and the ledger branch).
//
//   * CLOSED -> the superuser (SUPPORT_CONTACT_EMAIL): the workspace's name and
//     slug, the closed-at date, and ONE link, to the /super closed-workspaces
//     page (SUPER_CLOSURES_PATH). Never the Owner's reason, never who closed
//     it, never anything from inside the workspace -- the superuser has no
//     tenant read outside impersonation (CLAUDE.md § Superuser dashboard).
//   * REASSIGNED / DELETED -> the workspace's remaining active Owners and
//     Admins as snapshotted on the decision's audit row: what was decided,
//     when, and ONE link. Reassigned -> the workspace itself. Deleted -> no
//     workspace page exists any more, so the link is the post-sign-in hub
//     (DELETED_DECISION_PATH, "/"), which sends a person to a workspace they
//     still belong to, an invitation, or onboarding -- the one page every
//     account can open. Never the superuser's reason (Q212), never who the
//     superuser is, never the new Owner's name.
//
// Enforced on every render: an input key outside the notice's allowlist, or
// any URL but the one link, throws before anything is sent.
//
// No "server-only" and no I/O: tests/unit/email drives it.

import type { EmailBody } from "@/lib/email/templates";
import { NoticeContentError } from "@/lib/email/requester-templates";
import { assertInputAllowlisted, assertOnlyLink, oneLine, origin, render, slugOrRefuse } from "@/lib/email/notice-render";
import { formatDate } from "@/lib/format/date";

/**
 * The /super page that lists closed workspaces awaiting a decision. Chosen
 * here (Task 9c job 2b) so the closure email has a link the moment it ships;
 * Task 9c job 3 builds the page AT THIS PATH -- until then the link lands on
 * /super's own not-found page, behind the superuser gate.
 */
export const SUPER_CLOSURES_PATH = "/super/closures";

/** A deleted workspace has no page: the decision email links the post-sign-in hub (app/page.tsx). */
export const DELETED_DECISION_PATH = "/";

/** The ONLY keys each notice's input may carry. */
export const WORKSPACE_CLOSURE_NOTICE_ALLOWLIST = {
  workspaceClosed: ["organisationSlug", "organisationName", "closedAt", "siteUrl"],
  workspaceDecision: ["decision", "organisationSlug", "organisationName", "decidedAt", "siteUrl"],
} as const;

export type WorkspaceDecision = "workspace_reassigned" | "workspace_deleted";

/** UK local date through the shared formatter, refusing a non-date rather than rendering "Invalid Date". */
function ukDate(kind: string, iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) throw new NoticeContentError(`${kind} notice refused: not a date`);
  return formatDate(iso);
}

/** The workspace as the email names it: its name (a person's text, neutralised) and its slug. */
function workspaceLabel(name: string, slug: string): string {
  const flat = oneLine(name, 120);
  return flat ? `“${flat}” (${slug})` : slug;
}

export interface WorkspaceClosedInput {
  readonly organisationSlug: string;
  readonly organisationName: string;
  readonly closedAt: string;
  readonly siteUrl: string;
}

export function buildWorkspaceClosedNotice(input: WorkspaceClosedInput): EmailBody {
  assertInputAllowlisted("workspaceClosed", WORKSPACE_CLOSURE_NOTICE_ALLOWLIST.workspaceClosed, input);
  const slug = slugOrRefuse("workspaceClosed", input.organisationSlug);
  const link = `${origin(input.siteUrl)}${SUPER_CLOSURES_PATH}`;
  const label = workspaceLabel(input.organisationName, slug);
  const body = render(
    `[GetSetPaid] A workspace was closed by its Owner: ${slug}`,
    [
      `The workspace ${label} was closed by its Owner on ${ukDate("workspaceClosed", input.closedAt)}.`,
      "It is waiting for your decision: reassign it to one of its members, or delete it. If no decision is made it is purged automatically when its retention period ends. This email carries nothing from inside the workspace, on purpose.",
    ],
    link,
    "Open closed workspaces",
  );
  assertOnlyLink("workspaceClosed", body, link);
  return body;
}

export interface WorkspaceDecisionInput {
  readonly decision: WorkspaceDecision;
  readonly organisationSlug: string;
  readonly organisationName: string;
  readonly decidedAt: string;
  readonly siteUrl: string;
}

export function buildWorkspaceDecisionNotice(input: WorkspaceDecisionInput): EmailBody {
  assertInputAllowlisted("workspaceDecision", WORKSPACE_CLOSURE_NOTICE_ALLOWLIST.workspaceDecision, input);
  const slug = slugOrRefuse("workspaceDecision", input.organisationSlug);
  const label = workspaceLabel(input.organisationName, slug);
  const when = ukDate("workspaceDecision", input.decidedAt);
  const base = origin(input.siteUrl);

  let body: EmailBody;
  let link: string;
  if (input.decision === "workspace_reassigned") {
    link = `${base}/${slug}`;
    body = render(
      `Your closed GetSetPaid workspace ${slug} has been reopened`,
      [
        `GetSetPaid reopened the closed workspace ${label} on ${when} and gave it a new Owner from among its members.`,
        "The workspace is active again, with its records as they were when it closed.",
      ],
      link,
      "Open the workspace",
    );
  } else if (input.decision === "workspace_deleted") {
    link = `${base}${DELETED_DECISION_PATH}`;
    body = render(
      `Your closed GetSetPaid workspace ${slug} is being deleted`,
      [
        `GetSetPaid decided on ${when} to delete the closed workspace ${label}.`,
        "Its records are now being permanently removed, and it can no longer be opened. Your own account is not affected.",
      ],
      link,
      "Open GetSetPaid",
    );
  } else {
    throw new NoticeContentError("workspaceDecision notice refused: unknown decision");
  }
  assertOnlyLink("workspaceDecision", body, link);
  return body;
}
