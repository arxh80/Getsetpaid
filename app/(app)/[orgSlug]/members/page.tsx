import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "@/components/org/invite-form";
import { RuledList, RuledRow, StatusChip } from "@/components/ui/ruled-row";

export const metadata: Metadata = { title: "Members · GetSetPaid" };

interface MemberRow {
  id: string;
  role: string;
  status: "invited" | "active" | "revoked";
  invitedAt: string;
  joinedAt: string | null;
  name: string | null;
}

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

  const canManageMembers = await hasPermission(org.id, "manage_members");
  const members = await listMembers(org.id);

  const active = members.filter((m) => m.status === "active");
  const pending = members.filter((m) => m.status === "invited");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}`}
            className="text-primary underline underline-offset-4"
          >
            {org.name}
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Members
        </h1>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">
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
            />
          ))}
        </RuledList>
      </section>

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
              />
            ))}
          </RuledList>
        </section>
      ) : null}

      {canManageMembers ? (
        <section className="flex max-w-md flex-col gap-4 border-t border-rule pt-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-ink">Invite someone</h2>
            <p className="text-base text-ink-muted">
              They&apos;ll only see this workspace once they accept.
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

async function listMembers(organisationId: string): Promise<MemberRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisation_memberships")
    .select("id, user_id, role, status, invited_at, joined_at")
    .eq("organisation_id", organisationId)
    .neq("status", "revoked")
    // Bounded, per CLAUDE.md § Non-negotiable rules ("no unbounded list
    // endpoint"). A workspace with more members than this needs real
    // pagination, which arrives with the members-management task; the limit is
    // here so the ceiling is explicit rather than accidental.
    .order("invited_at", { ascending: true })
    .limit(200);

  if (error || !data) return [];

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

  return data.map((row) => ({
    id: row.id as string,
    role: row.role as string,
    status: row.status as MemberRow["status"],
    invitedAt: row.invited_at as string,
    joinedAt: (row.joined_at as string | null) ?? null,
    name: nameById.get(row.user_id as string) ?? null,
  }));
}

function roleLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** en-GB and Europe/London explicitly -- see the note in the invites page. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
