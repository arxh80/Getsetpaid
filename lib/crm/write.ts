import "server-only";

// A 204 IS NOT A SAVE.
//
// ===========================================================================
// THE MEASUREMENT THIS FILE EXISTS FOR
// ===========================================================================
// A PATCH whose rows are refused by a policy's USING clause matches nothing.
// PostgREST answers 204 No Content -- the same status as a PATCH that changed
// fifteen rows. An INSERT under the same conditions is a loud 403; UPDATE is
// not, and neither is DELETE.
//
// Measured on this stack by Task 3a, the same caller, the same statement, live
// organisation then suspended one:
//
//     no Prefer header       204   Content-Range: 0-14/*      vs  */*
//     Prefer: count=exact    204   Content-Range: 0-14/15     vs  */0
//     return=representation  200   6056 bytes of body         vs  2 ("[]")
//
// and, the half that decides what this file does, THROUGH supabase-js:
//
//     LIVE       status=204  count=15  data=null  error=null
//     SUSPENDED  status=204  count=0   data=null  error=null
//
// `status`, `data` and `error` are IDENTICAL. Only `count` differs. So any
// code that reads `if (error) fail() else succeed()` -- which is what every
// other write in this repository looked like before this file -- tells the
// user their edit saved and drops it.
//
// ===========================================================================
// WHY `count: "exact"` AND NOT THE TWO CHEAPER OPTIONS
// ===========================================================================
// Three mechanisms work. In cost order:
//
//   1. No Prefer header at all. `Content-Range: 0-14/*` against `*/*` already
//      separates an applied write from an accepted no-op. Cheapest -- and not
//      reachable from supabase-js, which surfaces `count` (null without the
//      header) and not the raw range. Reading the header would mean going
//      round the client.
//   2. `Prefer: count=exact`. What `.update(values, { count: "exact" })`
//      sends. Costs the server a count over the rows the statement matched --
//      which, for a save, is one row by primary key.
//   3. `Prefer: return=representation` (`.select()` in supabase-js). Works,
//      and is the most expensive of the three: a full body, measured at 6218
//      bytes for 15 contacts against 0. Right when the save path needs the
//      updated row back anyway; wrong as a default for "did this apply".
//
// This application uses (2). Every save here is by primary key, so the count
// is over at most one row, and it is the only one of the three that survives
// the client library without hand-rolling the transport.
//
// ONE CAVEAT, recorded because it is the trap in (1): a DELETE reports
// `Content-Range: */1` -- range `*`, real total -- so "read the range" does
// not generalise across verbs. `count` does.
//
// ===========================================================================
// WHY "REFUSED" IS ONE OUTCOME AND NOT THREE
// ===========================================================================
// A write can be refused because the workspace is suspended, because the role
// lacks the permission, because the record is outside the caller's scope,
// because the tier has no CRM writes, or because the row does not exist. From
// the client, several of those are literally indistinguishable -- that is the
// point of the tenant-isolation rule -- and the ones that are distinguishable
// should not be distinguished anyway, because "which of these is why" is an
// oracle. The UI's job is to be able to say WHY THE USER CANNOT WRITE before
// they try (lib/crm/write-access.ts, which has the org's state in hand), and
// to never claim a refused write succeeded. Those are different jobs and this
// file only does the second.

/** What a mutating request actually did. */
export type WriteResult =
  /** Rows really changed. The only outcome that may say "Saved". */
  | { readonly outcome: "applied"; readonly rows: number }
  /**
   * The request was accepted and changed nothing -- a policy's USING clause
   * matched no rows, or the row is gone. 204 with `count === 0`, or an
   * explicit 42501 from a function that raises rather than returning 0.
   */
  | { readonly outcome: "refused" }
  /** The request failed. A different sentence, and a logged one. */
  | { readonly outcome: "failed"; readonly message: string };

/** The shape of a PostgREST response this module reads. Narrowed on purpose. */
export interface MutationResponse {
  readonly error: { readonly message: string; readonly code?: string } | null;
  readonly count: number | null;
}

/**
 * Classify a mutating PostgREST response.
 *
 * A PURE FUNCTION, so the 204-is-not-a-save case is testable without a
 * database and without a suspended organisation -- the state that produces it
 * is a `count` of 0 and nothing else, and a unit test can hand it that
 * directly. The integration half (a policy really refusing a real PATCH) lives
 * in the RLS suite; this is the half that binds the CLIENT.
 *
 * `count === null` is treated as FAILED, not as applied. Null means the header
 * was not requested or not returned, which means this code cannot tell what
 * happened -- and "cannot tell" must never resolve to "saved". It is the exact
 * shape a caller that forgets `{ count: "exact" }` produces, so the failure is
 * loud instead of a silent return to the old behaviour.
 */
export function classifyWrite(
  response: MutationResponse,
  context: string,
): WriteResult {
  if (response.error) {
    // 42501 is insufficient_privilege: an INSERT refused by WITH CHECK, or
    // set_contact_primary_company() raising rather than committing half an
    // operation. It is a refusal, not a fault, and must not be logged as one
    // or shown as "something went wrong".
    if (response.error.code === "42501") return { outcome: "refused" };
    return { outcome: "failed", message: response.error.message };
  }
  if (response.count === null) {
    return {
      outcome: "failed",
      message: `${context}: no row count was returned, so whether the write applied is unknown. The caller must pass { count: "exact" }.`,
    };
  }
  if (response.count === 0) return { outcome: "refused" };
  return { outcome: "applied", rows: response.count };
}

/**
 * Run a mutation and classify it, logging a genuine failure once.
 *
 * The message only, never the row -- the same rule lib/list/query.ts states:
 * a log line must not become a second copy of tenant data.
 */
export async function commitWrite(
  context: string,
  run: () => PromiseLike<MutationResponse>,
): Promise<WriteResult> {
  const result = classifyWrite(await run(), context);
  if (result.outcome === "failed") {
    console.error(`[crm] ${context} failed:`, result.message);
  }
  return result;
}

/**
 * The sentence a refused write gets.
 *
 * One string, in one place, because five entity modules will each want to
 * write their own and the whole point is that the user is told the same true
 * thing every time: nothing changed. It deliberately does not guess WHY --
 * see the file header.
 */
export const REFUSED_MESSAGE =
  "That change wasn’t saved. Your access to this workspace may have changed — reload the page and check before trying again.";

export const FAILED_MESSAGE =
  "We couldn’t save that just now. Nothing has been changed. Try again in a moment.";
