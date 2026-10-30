import "server-only";

import { createClient } from "@/lib/supabase/server";

// The members page's read (moved here from app/(app)/[orgSlug]/members/page.tsx
// in Phase 10 Task 14 so a test can reach it).

/** How many memberships the members page lists (G8). */
export const MEMBERS_LIMIT = 200;

export interface MemberRow {
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
export type MemberList =
  | { outcome: "loaded"; members: MemberRow[]; more: boolean }
  | { outcome: "unavailable" };

export async function listMembers(organisationId: string): Promise<MemberList> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisation_memberships")
    .select("id, user_id, role, status, invited_at, joined_at")
    .eq("organisation_id", organisationId)
    .neq("status", "revoked")
    // Bounded, per CLAUDE.md § Non-negotiable rules ("no unbounded list
    // endpoint"). One row past the limit is read so the page can SAY it shows
    // only the first MEMBERS_LIMIT (G8) rather than stop silently; a keyset
    // pager is the full answer.
    .order("invited_at", { ascending: true })
    .limit(MEMBERS_LIMIT + 1);

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
  const more = data.length > MEMBERS_LIMIT;
  const rows = data.slice(0, MEMBERS_LIMIT);
  const userIds = [...new Set(rows.map((row) => row.user_id as string))];
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
    more,
    members: rows.map((row) => ({
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
