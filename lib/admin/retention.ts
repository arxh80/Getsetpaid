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

export interface RetentionRun {
  readonly id: string;
  readonly mode: "dry" | "live";
  readonly status: "running" | "completed" | "refused" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly swept: Readonly<Record<string, number | boolean>>;
  readonly refused: Readonly<Record<string, string>>;
}

export interface RetentionSettings {
  readonly enabled: boolean;
  readonly auditPurgeEnabled: boolean;
  readonly reason: string | null;
  readonly updatedAt: string;
}

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

export async function loadRetentionView(): Promise<RetentionView> {
  const supabase = await createClient();

  const [settings, runs] = await Promise.all([
    supabase
      .from("retention_settings")
      .select("enabled, audit_purge_enabled, reason, updated_at")
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

/**
 * The lines a run's `swept` map becomes on the page: `{table}.{what}` split
 * into a readable label and a number, with the booleans folded in as a
 * suffix rather than shown as "true".
 *
 * ZERO IS RENDERED, NOT HIDDEN. "The sweep deleted nothing" and "the sweep
 * did not run" are different facts, and a panel that shows only non-zero
 * counts makes them look the same — which is the whole reason `refused` is
 * a column and not a log line.
 */
export function sweptLines(
  run: RetentionRun,
): readonly { readonly label: string; readonly value: number; readonly capped: boolean }[] {
  const out: { label: string; value: number; capped: boolean }[] = [];
  for (const [key, value] of Object.entries(run.swept)) {
    if (typeof value !== "number") continue;
    if (key.endsWith(".capped")) continue;
    const capped = run.swept[`${key.split(".")[0]}.capped`] === true;
    out.push({ label: key, value, capped });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
