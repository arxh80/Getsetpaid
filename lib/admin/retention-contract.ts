// THE RETENTION JOB'S SHARED SHAPE — THE HALF A CLIENT COMPONENT MAY IMPORT.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHAT IT COST TO LEARN
// ===========================================================================
// `lib/admin/retention.ts` opens with `import "server-only"`, because it
// builds a Supabase server client and reads two tables through RLS. The panel
// that renders what it returns is a Client Component, and it was importing
// the row TYPES and the `sweptLines()` formatter from that same file — which
// drags `server-only` into the client graph and fails the build:
//
//   Error: 'server-only' cannot be imported from a Client Component module
//
// NOTHING SHORT OF A REAL BUILD CATCHES THAT. `pnpm lint` and
// `pnpm typecheck` are both perfectly happy — the types are types and the
// function is pure — and `pnpm build` is forbidden in this worktree
// (`CLAUDE.md`, "resolve to the hosted project"). It was found by
// `pnpm test:e2e`, which runs a real `next dev`, on the run that was supposed
// to be the last one: 43 passed, 80 failed, and every failure downstream of
// one module that would not compile.
//
// So the split is the one this repository already uses for exactly this
// problem — `lib/admin/lifecycle-contract.ts`,
// `lib/admin/overrides-contract.ts`, `lib/admin/impersonation-contract.ts`.
// The CONTRACT (types, and pure functions over them) lives here with no
// runtime dependency of any kind; the READ lives in `retention.ts` behind
// `server-only`. A Client Component may import this file; it may never
// import that one, and `server-only` is what enforces that rather than a
// convention anybody has to remember.

export interface RetentionRun {
  readonly id: string;
  readonly mode: "dry" | "live";
  readonly status: "running" | "completed" | "refused" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  /** Counts and `capped` flags only — the CHECK on `public.retention_runs.swept`
   *  (`private.jsonb_is_retention_summary()`) admits numbers and booleans and
   *  nothing else, so no string can reach this map and therefore no filename,
   *  search term or database message can reach the page that renders it. */
  readonly swept: Readonly<Record<string, number | boolean>>;
  /** `{sweep: hint}` for the sweeps that did not run. A hint or a SQLSTATE,
   *  never a PostgreSQL message — a message can quote a row value. */
  readonly refused: Readonly<Record<string, string>>;
}

export interface RetentionSettings {
  readonly enabled: boolean;
  readonly auditPurgeEnabled: boolean;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface SweptLine {
  readonly label: string;
  readonly value: number;
  readonly capped: boolean;
}

/**
 * The lines a run's `swept` map becomes on the page: `{table}.{what}` split
 * into a readable label and a number, with each sweep's `capped` boolean
 * folded in as a suffix rather than rendered as the word "true".
 *
 * ZERO IS RENDERED, NOT HIDDEN. "The sweep deleted nothing" and "the sweep
 * did not run" are different facts, and a panel that showed only non-zero
 * counts would make them look the same — which is the whole reason `refused`
 * is a column on the run rather than a line in a log nobody can reach.
 */
export function sweptLines(run: RetentionRun): readonly SweptLine[] {
  const out: SweptLine[] = [];
  for (const [key, value] of Object.entries(run.swept)) {
    if (typeof value !== "number") continue;
    if (key.endsWith(".capped")) continue;
    const capped = run.swept[`${key.split(".")[0]}.capped`] === true;
    out.push({ label: key, value, capped });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
