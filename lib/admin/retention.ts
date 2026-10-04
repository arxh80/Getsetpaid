import "server-only";

// The operator's read of the retention job: the last few runs and the two
// kill switches. Rendered on /super/health beside the existing counts
// (Phase 8 Task 6, requirement 4).
//
// THROUGH THE EXISTING RLS POLICIES, not a service client. Both tables carry
// a SELECT policy for `view_platform_health` at aal2 and no other read, so
// this file adds no read surface: a caller who is not the superuser gets zero
// rows, which is what every other /super read in this repository does.
//
// COUNTS ONLY, BY CONSTRUCTION. public.retention_runs.swept is CHECK-bound to
// numbers and booleans (private.jsonb_is_retention_summary()), so nothing
// this page can render is a filename, a search term or a database message --
// the rule CLAUDE.md § Superuser dashboard's "aggregate metadata, never
// record content" asks of every surface here, enforced in the schema rather
// than by this file remembering.

import { createClient } from "@/lib/supabase/server";
import type { RetentionRun, RetentionSettings } from "@/lib/admin/retention-contract";

// THE SHAPE LIVES IN lib/admin/retention-contract.ts, NOT HERE, and the
// reason is written down there at length: this file is `server-only`, the
// panel that renders what it returns is a Client Component, and a Client
// Component importing a type from a `server-only` module fails the BUILD --
// which neither lint nor tsc can see and which `pnpm test:e2e` found, on the
// run that was meant to be the last one. The lifecycle/overrides/impersonation
// `-contract.ts` split, for the fourth time and the same reason.
export type { RetentionRun, RetentionSettings } from "@/lib/admin/retention-contract";

export type RetentionView =
  | {
      readonly outcome: "loaded";
      readonly settings: RetentionSettings | null;
      readonly runs: readonly RetentionRun[];
    }
  | { readonly outcome: "unavailable" };

/** How many runs the panel shows. Small on purpose: the run log is evidence
 *  and the audit log is where it is searched; this is a health surface, and
 *  the question it answers is "is the job running and is it refusing". */
const RUNS_SHOWN = 5;

/** READ-TIME, like the purge: active while released_at <= now < expires_at.
 *  The page is a dynamic render, so `now` is the request's. */
function ceilingReleaseOf(row: {
  audit_ceiling_released_at: string | null;
  audit_ceiling_release_expires_at: string | null;
  audit_ceiling_release_reason: string | null;
}): RetentionSettings["ceilingRelease"] {
  if (
    row.audit_ceiling_released_at === null ||
    row.audit_ceiling_release_expires_at === null ||
    row.audit_ceiling_release_reason === null
  ) {
    return null;
  }
  const now = Date.now();
  return {
    releasedAt: row.audit_ceiling_released_at,
    expiresAt: row.audit_ceiling_release_expires_at,
    reason: row.audit_ceiling_release_reason,
    active:
      Date.parse(row.audit_ceiling_released_at) <= now &&
      now < Date.parse(row.audit_ceiling_release_expires_at),
  };
}

export async function loadRetentionView(): Promise<RetentionView> {
  const supabase = await createClient();

  const [settings, runs] = await Promise.all([
    supabase
      .from("retention_settings")
      .select(
        "enabled, audit_purge_enabled, reason, updated_at, audit_ceiling_released_at, audit_ceiling_release_expires_at, audit_ceiling_release_reason",
      )
      .maybeSingle(),
    supabase
      .from("retention_runs")
      .select("id, mode, status, started_at, finished_at, duration_ms, swept, refused")
      .order("started_at", { ascending: false })
      .limit(RUNS_SHOWN),
  ]);

  if (settings.error || runs.error) {
    console.error(
      "[admin] the retention view could not be read:",
      settings.error?.message ?? runs.error?.message,
    );
    return { outcome: "unavailable" };
  }

  return {
    outcome: "loaded",
    settings: settings.data
      ? {
          enabled: settings.data.enabled,
          auditPurgeEnabled: settings.data.audit_purge_enabled,
          reason: settings.data.reason,
          updatedAt: settings.data.updated_at,
          ceilingRelease: ceilingReleaseOf(settings.data),
        }
      : null,
    runs: (runs.data ?? []).map((row) => ({
      id: row.id,
      mode: row.mode as "dry" | "live",
      status: row.status as RetentionRun["status"],
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      swept: (row.swept ?? {}) as Record<string, number | boolean>,
      refused: (row.refused ?? {}) as Record<string, string>,
    })),
  };
}

// sweptLines() moved to the contract module with the types, for the same
// reason: it is a pure function over a run, the panel calls it, and the panel
// is a Client Component.
export { sweptLines } from "@/lib/admin/retention-contract";
