import "server-only";

// The signed-in person's OWN erasure jobs, and what would stop them asking.
//
// `erasure_jobs_select_own` admits rows whose subject or requester is the
// caller, plus the aal2 platform operator's oversight read. So this needs no
// user argument and could not read anybody else's if it had one.

import { createClient } from "@/lib/supabase/server";
import type { ErasureBlocker, ErasureKind, ErasureStatus } from "./contract";

export interface OwnErasureJob {
  readonly id: string;
  readonly kind: ErasureKind | string;
  readonly status: ErasureStatus | string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly summary: Record<string, unknown> | null;
}

/** Bounded, like every other list in the product. Three a day, so this is days. */
export const OWN_ERASURE_LIMIT = 10;

const COLUMNS = "id, kind, status, requested_at, completed_at, failure_reason, summary";

/**
 * FAILS LOUDLY on a query error. A page that rendered "you have asked for
 * nothing" during a database blip would tell somebody their deletion request
 * had vanished.
 */
export async function getOwnErasureJobs(): Promise<readonly OwnErasureJob[]> {
  const supabase = await createClient();
  // WHOSE, EXPLICITLY -- fix round 1, review finding M3. `erasure_jobs_select_own`
  // also admits the aal2 operator's oversight read, which is right for
  // /super/data-requests and wrong here: /account/erase is headed "What you
  // have asked for" and its empty state reads "You have not asked us to
  // delete your account", so a signed-in superuser was reading other people's
  // jobs on their own account page. RLS is the boundary; this is the page
  // saying which rows it means.
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  if (userId === null) return [];

  const { data, error } = await supabase
    .from("erasure_jobs")
    .select(COLUMNS)
    .eq("kind", "account")
    .eq("subject_user_id", userId)
    .order("requested_at", { ascending: false })
    .limit(OWN_ERASURE_LIMIT);

  if (error) throw new Error(`erasure jobs could not be read: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    status: r.status as string,
    requestedAt: r.requested_at as string,
    completedAt: (r.completed_at ?? null) as string | null,
    failureReason: (r.failure_reason ?? null) as string | null,
    summary: (r.summary ?? null) as Record<string, unknown> | null,
  }));
}

/**
 * Q131, shown BEFORE anything is asked for.
 *
 * `public.my_erasure_blockers()` takes no argument and reads
 * `auth.uid()`, so it cannot be pointed at anybody else. Seeing the answer
 * early is the difference between "we cannot do this, and here is what to do"
 * and a job that fails a minute later with the same sentence.
 *
 * FAILS LOUDLY for the same reason as above, and in the more dangerous
 * direction: an empty list means "nothing is in the way", and answering that
 * because a query failed would offer somebody a button that is going to
 * refuse.
 */
export async function getOwnErasureBlockers(): Promise<readonly ErasureBlocker[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_erasure_blockers");
  if (error) throw new Error(`erasure blockers could not be read: ${error.message}`);
  return ((data ?? []) as { organisation_name: string; reason: string }[]).map((r) => ({
    organisationName: r.organisation_name,
    reason:
      r.reason === "other_members" || r.reason === "no_owner_to_transfer"
        ? r.reason
        : "workspace_has_data",
  }));
}
