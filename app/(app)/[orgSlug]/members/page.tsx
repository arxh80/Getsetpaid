import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser, hasPermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "@/components/org/invite-form";
import { MemberControls } from "@/components/org/member-controls";
import { ActionOutcome } from "@/components/ui/action-outcome";
import { RuledList, RuledRow, StatusChip } from "@/components/ui/ruled-row";
import { formatDate } from "@/lib/format/date";

export const metadata: Metadata = { title: "Members · GetSetPaid" };

interface MemberRow {
  id: string;
  userId: string;
  role: string;
  status: "invited" | "active" | "revoked";
  invitedAt: string;
  joinedAt: string | null;
  name: string | null;
}

/**
 * Three-way, not `MemberRow[]`.
 *
 * REVIEW FINDING (M-2): this page had copied lib/auth/index.ts's
 * `if (error || !data) return []` and collapsed a failed query into an empty
 * list, silently and with nothing in the logs. That pattern is defensible
 * where it originated -- the onboarding path, where "you have no workspaces
 * yet" and "we could not tell" should look the same to a brand-new user -- and
 * indefensible here. A transient PostgREST failure rendered
 * "In this workspace (0)" to a legitimate member of a workspace that
 * demonstrably has an owner in it, which reads as data loss, not as a blip.
 *
 * Same shape lib/entitlements/policy.ts uses for the same reason: the caller
 * is made to name which of the two cases it is handling, so "empty" and
 * "unknown" cannot be confused by omission.
 */
type MemberList =
  | { outcome: "loaded"; members: MemberRow[] }
  | { outcome: "unavailable" };

// The people list, and the invite form.
//
// Every row here comes from a query made as the signed-in user, so
// organisation_memberships_select_same_organisation is what decides which rows
// exist -- this page has no filtering logic of its own beyond ordering. Point
// it at another tenant's org id and it returns nothing, because the policy
// returns nothing.
export default async function MembersPage({
  params,
}: PageProps<"/[orgSlug]/members">) {
  const { orgSlug } = await params;

  // Same 404-for-everything rule as the workspace home: not found, not yours
  // and invited-not-active are indistinguishable from the outside.
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  // Promise.all, not two sequential awaits (Task 10 gate,
  // vercel-react-best-practices `async-parallel`). Both of these depend only
  // on org.id and nothing on each other, so awaiting them in sequence made
  // the page wait for a full permission round trip before it even ASKED for
  // the member list -- a waterfall that cost one extra database round trip on
  // every render of this route for no reason. app/(app)/[orgSlug]/page.tsx
  // already did this correctly; this page had drifted from it.
  //
  // Running them together changes nothing about enforcement: hasPermission()
  // is a `has_permission` RPC and listMembers() is filtered by
  // organisation_memberships_select_same_organisation, so both still answer
  // as the signed-in user. The permission result gates only what is RENDERED
  // (the invite form) -- the INSERT behind it is refused by the policy
  // regardless, per CLAUDE.md's "hiding UI is not enforcement".
  const [canManageMembers, memberList, me] = await Promise.all([
    hasPermission(org.id, "manage_members"),
    listMembers(org.id),
    getCurrentUser(),
  ]);

  const loaded = memberList.outcome === "loaded";
  const members = loaded ? memberList.members : [];
  const active = members.filter((m) => m.status === "active");
  const pending = members.filter((m) => m.status === "invited");

  // Row controls (Phase 10 Task 21). Rendering only: the policies decide. Not
  // on the caller's own row (leaving a workspace is not built), and not on an
  // Owner's row unless the caller is an Owner (Q248: only an Owner manages
  // Owners -- the database refuses it anyway).
  const isOwner = org.role === "owner";
  const controlsFor = (m: MemberRow, subject: string) =>
    canManageMembers && m.userId !== me?.id && (isOwner || m.role !== "owner") ? (
      <MemberControls
        orgSlug={org.slug}
        orgName={org.name}
        membershipId={m.id}
        name={subject}
        role={m.role}
        invited={m.status === "invited"}
        canGrantOwner={isOwner}
        focusAfterRemoveId="members-in-workspace"
      />
    ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          {/* break-words: same user-supplied-name clipping risk as the
              workspace home's <h1> -- a single unbroken organisation name has
              no break opportunity, and `overflow-x: clip` hides the overflow
              rather than letting the user scroll to it. */}
          <Link
            href={`/${org.slug}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {org.name}
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Members
        </h1>
      </div>

      {/* Outcomes of the row controls land here: a removed row takes its
          own controls with it (components/ui/action-outcome.tsx). */}
      <ActionOutcome testId="members-outcome">
        {/* An unreadable member list must not render as an EMPTY one. A count of
            (0) on a workspace that certainly has an owner is a claim about the
            data; "we couldn't load this" is a claim about the request, and only
            the second one is true here. role="status" so a screen reader hears
            it -- it replaces content the user asked for. */}
        {loaded ? (
          <section className="flex flex-col gap-4">
            <h2 id="members-in-workspace" tabIndex={-1} className="text-xl font-bold text-ink">
              In this workspace{" "}
              <span className="tabular-nums font-normal text-ink-muted">
                ({active.length})
              </span>
            </h2>
            <RuledList>
              {active.map((m) => (
                <RuledRow
                  key={m.id}
                  title={m.name ?? "Member"}
                  meta={roleLabel(m.role)}
                  status={<StatusChip tone="active">Active</StatusChip>}
                  action={controlsFor(
                    m,
                    // A null name must not give every such row the same accessible name.
                    m.name ?? `${roleLabel(m.role)}, joined ${formatDate(m.joinedAt ?? m.invitedAt)}`,
                  )}
                />
              ))}
            </RuledList>
          </section>
        ) : (
          <section className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-ink">In this workspace</h2>
            <p role="status" className="border-t border-rule pt-4 text-base text-ink-muted">
              We couldn’t load the member list just now. Refresh the page to try
              again — nobody has been removed.
            </p>
          </section>
        )}

        {pending.length > 0 ? (
          <section className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-ink">
              Invited{" "}
              <span className="tabular-nums font-normal text-ink-muted">
                ({pending.length})
              </span>
            </h2>
            {/* Names are usually null here: an invited user has no profile row
                the current user can read, because profiles_select_shared_
                organisation requires BOTH memberships to be active. Saying
                "invitation sent" is the honest rendering of that, and it is a
                correct expression of the tenancy boundary rather than a gap. */}
            <RuledList>
              {pending.map((m) => (
                <RuledRow
                  key={m.id}
                  title={m.name ?? "Invitation sent"}
                  meta={
                    <>
                      {roleLabel(m.role)} ·{" "}
                      <time dateTime={m.invitedAt} className="tabular-nums">
                        {formatDate(m.invitedAt)}
                      </time>
                    </>
                  }
                  status={<StatusChip tone="pending">Pending</StatusChip>}
                  action={controlsFor(
                    m,
                    `${m.name ?? roleLabel(m.role)}, sent ${formatDate(m.invitedAt)}`,
                  )}
                />
              ))}
            </RuledList>
          </section>
        ) : null}
      </ActionOutcome>

      {canManageMembers ? (
        <section className="flex max-w-md flex-col gap-4 border-t border-rule pt-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-ink">Invite someone</h2>
            <p className="text-base text-ink-muted">
              They’ll only see this workspace once they accept.
            </p>
          </div>
          <InviteForm orgSlug={org.slug} />
        </section>
      ) : (
        <p className="border-t border-rule pt-8 text-base text-ink-muted">
          Only Owners and Admins can invite people to this workspace.
        </p>
      )}
    </div>
  );
}

async function listMembers(organisationId: string): Promise<MemberList> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisation_memberships")
    .select("id, user_id, role, status, invited_at, joined_at")
    .eq("organisation_id", organisationId)
    .neq("status", "revoked")
    // Bounded, per CLAUDE.md § Non-negotiable rules ("no unbounded list
    // endpoint"). A workspace with more members than this needs real
    // pagination, which the members-management task (Phase 10 Task 21) did not
    // add; the limit is here so the ceiling is explicit rather than accidental.
    .order("invited_at", { ascending: true })
    .limit(200);

  // A query error and a genuinely empty result are DIFFERENT ANSWERS and are
  // returned as different values. Logged, so the failure exists somewhere
  // other than the rendered page -- the original silence is half of what made
  // this worth fixing. The error message only (never the row payload): an
  // audit/log line must not become a second copy of tenant data.
  if (error) {
    console.error(
      `[members] organisation_memberships lookup failed for org ${organisationId}; rendering "unavailable" rather than an empty member list:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "unavailable" };

  // TWO QUERIES, NOT A POSTGREST EMBED. There is no foreign key from
  // organisation_memberships.user_id to public.profiles -- that column
  // references auth.users(id), and profiles.id references auth.users(id)
  // separately. PostgREST resolves embeds from declared foreign keys, so
  // `select=...,profiles(full_name)` fails outright with PGRST200
  // ("Could not find a relationship"), not with a null column. Verified
  // against the local stack after this page first rendered an empty member
  // list for a workspace that definitely had an owner in it.
  //
  // Doing it as a second query costs one round trip and keeps the security
  // properties identical: it runs on the SAME user-scoped client, so
  // profiles_select_own + profiles_select_shared_organisation still decide
  // which names come back. A name appears only for the caller themselves and
  // for people ACTIVE alongside them; an invited-but-not-yet-joined person
  // resolves to null, which is correct -- they have not consented to be
  // visible in this organisation yet.
  const userIds = [...new Set(data.map((row) => row.user_id as string))];
  const nameById = new Map<string, string | null>();

  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", userIds);
    for (const p of profiles ?? []) {
      nameById.set(p.id as string, (p.full_name as string | null) ?? null);
    }
  }

  return {
    outcome: "loaded",
    members: data.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      role: row.role as string,
      status: row.status as MemberRow["status"],
      invitedAt: row.invited_at as string,
      joinedAt: (row.joined_at as string | null) ?? null,
      name: nameById.get(row.user_id as string) ?? null,
    })),
  };
}

function roleLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
