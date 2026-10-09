import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { ConsentAction, ConsentPurpose } from "./catalogue";

// The signed-in user's OWN consent events, read under their own session.
//
// `consents_select_own` admits only the caller's rows, so this needs no user
// argument and could not read anybody else's if it had one. (The platform
// superuser's oversight policy would ALSO admit every row for an aal2
// superuser, which is why the query still filters on the caller's id: the
// account page shows the viewer's own history, whoever the viewer is.)

export interface ConsentEvent {
  readonly id: string;
  readonly action: ConsentAction;
  readonly policySlug: string;
  readonly policyVersion: number;
  /** granted_at or withdrawn_at -- whichever the event has. */
  readonly occurredAt: string;
}

export interface ConsentState {
  /** The newest event, or null if the person has never chosen. */
  readonly current: ConsentEvent | null;
  /** Newest first, at most HISTORY_LIMIT events. */
  readonly history: readonly ConsentEvent[];
  /** True when there are older events than the ones in `history`. */
  readonly truncated: boolean;
}

/** Paginate-everything rule: the history is bounded. The ledger grows by at
 *  most two rows per grant, and grants are metered at 10/hour, so twenty is
 *  several sessions of changes -- enough to see what happened recently. */
export const HISTORY_LIMIT = 20;

interface Row {
  id: string;
  action: ConsentAction;
  policy_slug: string;
  policy_version: number;
  granted_at: string | null;
  withdrawn_at: string | null;
}

/**
 * FAILS LOUDLY on a query error. A privacy page that rendered "you have not
 * agreed" during a database blip would misstate the person's own choice.
 */
export async function getOwnConsentState(
  userId: string,
  purpose: ConsentPurpose,
): Promise<ConsentState> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("consents")
    .select("id, action, policy_slug, policy_version, granted_at, withdrawn_at")
    .eq("user_id", userId)
    .eq("purpose", purpose.purpose)
    .order("seq", { ascending: false })
    .limit(HISTORY_LIMIT + 1);
  if (error) {
    throw new Error(`consents: could not read your consent history: ${error.message}`);
  }
  const rows = (data ?? []) as Row[];
  const history = rows.slice(0, HISTORY_LIMIT).map(toEvent);
  return {
    current: history[0] ?? null,
    history,
    truncated: rows.length > HISTORY_LIMIT,
  };
}

function toEvent(row: Row): ConsentEvent {
  const occurredAt = row.action === "granted" ? row.granted_at : row.withdrawn_at;
  if (!occurredAt) {
    // The CHECK constraints make this unreachable; say so if it ever is not.
    throw new Error(`consents: event ${row.id} has no timestamp for its action`);
  }
  return {
    id: row.id,
    action: row.action,
    policySlug: row.policy_slug,
    policyVersion: row.policy_version,
    occurredAt,
  };
}
