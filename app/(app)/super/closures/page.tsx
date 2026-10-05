import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  buildClosuresNextHref,
  CANDIDATES_PAGE_PARAM,
  encodeCandidatesPage,
  listClosedWorkspaces,
  parseCandidatesPage,
  listReassignCandidates,
  parseClosuresParams,
} from "@/lib/admin/closures-list";
import { daysUntil } from "@/lib/admin/lifecycle-contract";
import { EXPORT_STATUS_LABELS } from "@/lib/export/contract";
import { INVITABLE_ROLES } from "@/lib/org/roles";
import { formatDateTime } from "@/lib/format/date";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { Alert } from "@/components/ui/alert";
import {
  ClosedWorkspaceDecisions,
  type ClosureRowView,
} from "@/components/admin/closed-workspace-decisions";

// PHASE 8 TASK 9c JOB 3a: "Closed workspaces awaiting decision" (founder
// 2026-09-30, Q176/Q178). An Owner who closes their own workspace
// (close_my_workspace) lands it here; the superuser either reassigns it to one
// of its active members as the new Owner -- which reopens it -- or deletes it
// permanently. Both behind step-up, both with a mandatory reason, both audited
// in the database (organisation.closure_reassigned / .closure_deleted), both
// emailing the workspace's remaining Owners and Admins on the next tick.
// The superuser's closure email links here (SUPER_CLOSURES_PATH, Q214).
//
// AGGREGATE METADATA ONLY, plus the one thing the reassign decision cannot be
// made without: the names and roles of the closed workspace's active members
// (closed_workspace_reassign_candidates, Q215). No record content; the backup
// is shown by STATUS only -- there is no superuser download (Q209).
//
// generateMetadata(), NOT a static `export const metadata` -- the enumeration
// oracle every /super page closes the same way (organisations/page.tsx).
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Closed workspaces · Superuser · GetSetPaid" };
}

/** This page's URL with the picker-page key set (or removed), every other key kept. */
function membersHref(
  raw: Record<string, string | string[] | undefined>,
  value: string | null,
): string {
  const qs = new URLSearchParams();
  for (const [key, v] of Object.entries(raw)) {
    if (key === CANDIDATES_PAGE_PARAM || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) qs.append(key, one);
  }
  if (value) qs.set(CANDIDATES_PAGE_PARAM, value);
  const s = qs.toString();
  return s ? `/super/closures?${s}` : "/super/closures";
}

function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  return INVITABLE_ROLES.find((r) => r.key === role)?.label ?? role;
}

export default async function ClosedWorkspacesPage({
  searchParams,
}: PageProps<"/super/closures">) {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header.
  if (!(await isSuperuser())) notFound();

  const raw = await searchParams;
  const params = parseClosuresParams(raw);
  // Q224: one workspace's reassign picker may be on a later page.
  const membersPage = parseCandidatesPage(raw);
  const cursor = params.cursor;
  const result = await listClosedWorkspaces(params);
  const now = new Date();

  const rows: ClosureRowView[] = result.ok
    ? await Promise.all(
        result.rows.map(async (row) => {
          const after =
            membersPage?.organisationId === row.organisationId ? membersPage.afterUserId : null;
          const { candidates, hasMore } = await listReassignCandidates(row.organisationId, after);
          const lastCandidate = candidates.at(-1);
          return {
            organisationId: row.organisationId,
            name: row.name,
            slug: row.slug,
            closedAt: row.closedAt ? formatDateTime(row.closedAt) : null,
            purgeDueAt: row.purgeDueAt ? formatDateTime(row.purgeDueAt) : null,
            purgeDays: daysUntil(row.purgeDueAt, now),
            activeMembers: row.activeMembers,
            backupLabel: row.backupStatus
              ? EXPORT_STATUS_LABELS[row.backupStatus]
              : "No backup recorded",
            candidates: candidates.map((c) => ({
              userId: c.userId,
              label: `${c.displayName ?? "Unnamed member"} — ${roleLabel(c.role)}`,
            })),
            membersNextHref:
              hasMore && lastCandidate
                ? membersHref(
                    raw,
                    encodeCandidatesPage({
                      organisationId: row.organisationId,
                      afterUserId: lastCandidate.userId,
                    }),
                  )
                : null,
            membersFirstHref: after ? membersHref(raw, null) : null,
          };
        }),
      )
    : [];

  const last = result.ok ? result.rows.at(-1) : undefined;
  const nextHref = result.ok && result.hasMore && last ? buildClosuresNextHref(params, last) : null;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Closed workspaces
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Workspaces their own Owner has closed, awaiting your decision, the
          nearest purge first. Each is read-only for its members and was
          backed up when it closed. Reassigning hands it to an active member
          and reopens it; deleting it is permanent. Both need a reason and are
          written to the audit log.
        </p>
      </div>

      <section className="flex flex-col gap-6" aria-labelledby="closures-awaiting">
        <h2 id="closures-awaiting" className="text-xl font-bold text-ink">
          Awaiting decision
        </h2>
        {!result.ok ? (
          <Alert tone="error">
            The list could not be read. Nothing has been decided — reload the
            page, and if it keeps failing, check the server log.
          </Alert>
        ) : (
          // STEP-UP decides what to RENDER; lib/admin/closures.ts re-checks it
          // server-side on both actions, and the RPCs check aal2 themselves.
          <StepUpGate next="/super/closures">
            <ClosedWorkspaceDecisions rows={rows} />
          </StepUpGate>
        )}

        {cursor || nextHref ? (
          <nav aria-label="Pages" className="flex flex-wrap gap-6 border-t border-rule pt-4">
            {cursor ? (
              <Link
                href="/super/closures"
                className="text-sm text-primary underline underline-offset-4 hover:text-ink"
              >
                First page
              </Link>
            ) : null}
            {nextHref ? (
              <Link
                href={nextHref}
                className="text-sm text-primary underline underline-offset-4 hover:text-ink"
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
