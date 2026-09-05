"use server";

// Connection requests: send, accept, decline, withdraw. Q78/Q79/Q80/Q83.
//
// The request-to-connect flow is CLAUDE.md § The private/network split's
// discovery model, and this module is its whole write surface. Four things
// about it are not a copy of any other action module.
//
// ===========================================================================
// 1. THE TABLE IS BI-TENANT, SO "WHICH ORGANISATION AM I ACTING AS" IS A
//    QUESTION EVERY ACTION HAS TO ANSWER EXPLICITLY
// ===========================================================================
// Every other write in this product happens in ONE organisation and pins it
// with `.eq("organisation_id", org.id)`. A connection request has TWO
// organisation columns and the caller is on exactly one side of it, so each
// action pins the side it is acting FROM:
//
//   send      -> from_organisation_id = org.id
//   withdraw  -> from_organisation_id = org.id   (the sender retracts)
//   accept    -> to_organisation_id   = org.id   (the recipient answers)
//   decline   -> to_organisation_id   = org.id
//
// Pinning the WRONG column would not be a security hole -- the two UPDATE
// policies refuse it independently, which is the whole reason they are two
// policies -- but it would turn a legitimate write into a silent 204 with
// count 0, i.e. "That change wasn't saved" on a button that should have worked.
//
// ===========================================================================
// 2. TWO GATES, AND THE WITHDRAW PATH DELIBERATELY SKIPS ONE
// ===========================================================================
// Sending and accepting both need the tier (Q76: a Free organisation cannot
// form a connection), so they go through `authoriseConnections`, which calls
// getNetworkConnectionAccess. WITHDRAWING DOES NOT, and that asymmetry is in
// the database too: 20260904003000's sender-withdraws policy carries no
// network_publish term, because gating the RETRACTION of a request behind the
// tier would strand a Free organisation with a pending request it can neither
// complete nor take back. `authoriseWithdraw` below is the narrower gate --
// suspension and the permission, no tier -- and it exists as its own function
// so the omission is a decision a reader can see rather than a missing line.
//
// ===========================================================================
// 3. `responded_at` MOVES WITH `status`, ALWAYS
// ===========================================================================
// `network_connection_requests_responded_iff_terminal` asserts
// (status = 'pending') = (responded_at is null). So EVERY action that leaves
// `pending` must set responded_at in the SAME statement or the write is a
// 23514 -- measured, not assumed: supabase/tests/rls_phase6_network.sql NR8
// drives exactly the statement this module must not write and asserts the
// refusal. `terminal()` below is the one place that pairing is written down.
//
// ===========================================================================
// 4. THE TRANSITION GUARD MAKES A RETRY MEANINGLESS, SO THE COPY MUST NOT
//    INVITE ONE
// ===========================================================================
// private.network_request_status_transition_guard() makes a terminal status
// immutable for every writer, `postgres` included. So "accept" on an
// already-declined request is not a race the user can win by trying again --
// it is over. The 23514 that raises is mapped to a sentence that says the
// request has already been answered and tells them to reload, rather than to
// REFUSED_MESSAGE's "try again", which would be an instruction that cannot
// work.

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser, hasPermission, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getNetworkConnectionAccess } from "@/lib/network/access";

/**
 * Shown when a terminal request is acted on again.
 *
 * NOT `REFUSED_MESSAGE`. That string ends "reload the page and check before
 * trying again", which is right for an access change and wrong here: the
 * transition guard means there is nothing to try again. This names what
 * happened so the user's next move is to look, not to click.
 */
const ALREADY_ANSWERED =
  "That request has already been answered. Reload the page to see where it stands.";

/**
 * Shown when the sender aims at a profile that is no longer published.
 *
 * Both inline `exists` clauses in the INSERT policy require a PUBLISHED, LIVE
 * profile on each end, and the second is also what makes to_organisation_id
 * unforgeable. From the client all three refusals are the same 42501, and
 * telling them apart would be the oracle lib/crm/write.ts's header declines to
 * build -- so this sentence covers the honest case and does not guess.
 */
const UNREACHABLE_PROFILE =
  "That profile can’t be reached from here — it may have been unpublished. Reload the network directory and try again.";

/**
 * Resolve the organisation and check CONNECTION write access.
 *
 * The gate for SEND, ACCEPT and DECLINE. Tier included (Q76).
 */
async function authoriseConnections(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };

  const access = await getNetworkConnectionAccess(org);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * The NARROWER gate, for WITHDRAW only: suspension and the permission, NO tier.
 *
 * A SEPARATE FUNCTION RATHER THAN A FLAG, so the omission is legible. It
 * mirrors 20260904003000's sender-withdraws policy exactly -- that policy
 * carries no network_publish term either -- and the reason is the same in both
 * places: a Free-tier organisation must be able to take back a request it can
 * no longer act on. Gating the retraction behind the tier would leave a pending
 * request standing against a counterparty for ever, and
 * network_connection_requests_live_pair means that pending row also blocks any
 * future request to the same profile.
 *
 * It does NOT skip suspension. A suspended workspace is read-only for
 * everything (Q6), and withdrawing is a write.
 */
async function authoriseWithdraw(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };

  if (org.isSuspended) {
    return {
      ok: false,
      state: {
        error:
          "This workspace is suspended, so it’s read-only. You can still see everything in it. Contact GetSetPaid support to have it reinstated — an Owner can’t do it from here.",
        values: echoed,
      },
    };
  }
  if (!(await hasPermission(org.id, "manage_network_connections"))) {
    return {
      ok: false,
      state: {
        error:
          "Your role in this workspace can’t send or accept connections. Ask an Owner, Admin or Manager.",
        values: echoed,
      },
    };
  }
  return { ok: true, org };
}

/**
 * The two columns that must move together when a request leaves `pending`.
 *
 * ONE PLACE, BECAUSE THE CONSTRAINT IS ONE FACT. Three actions call this, and a
 * fourth that forgot `responded_at` would be a 23514 the user cannot act on --
 * which is exactly what rls_phase6_network.sql NR8 measures. `responded_by` is
 * set from the session rather than left to its column default for the same
 * reason `created_by` is written explicitly everywhere else: a write and a
 * policy that agree only because a default happens to match are a latent break.
 */
function terminal(status: "accepted" | "declined" | "withdrawn", userId: string) {
  return {
    status,
    responded_at: new Date().toISOString(),
    responded_by: userId,
  };
}

/** Both routes a connection write changes. */
function revalidateNetwork(orgSlug: string) {
  revalidatePath(`/${orgSlug}/network`);
  revalidatePath(`/${orgSlug}/network/connections`);
}

/**
 * Map a PostgREST error on a connection write to the sentence it deserves.
 *
 * Returns null when the error is not one this module has a better sentence for,
 * so the caller falls through to logging it as a fault.
 */
function connectionErrorState(
  code: string | undefined,
  formData: FormData,
): FormState | null {
  const values = echoedValues(formData);
  // 23514: either the transition guard (a terminal request acted on again) or
  // the responded_iff_terminal CHECK. The first is what a user can actually
  // reach; the second is a bug in this file, and would show as the same
  // sentence -- which is acceptable because the sentence tells them to reload
  // and the log line carries the real cause.
  if (code === "23514") return { error: ALREADY_ANSWERED, values };
  // 23505: network_connection_requests_live_pair. A pending, accepted or
  // declined request to this profile already stands (Q79).
  if (code === "23505") {
    return {
      error:
        "You already have a connection request with this profile. Check your connections list to see where it stands.",
      values,
    };
  }
  if (code === "42501") return { error: REFUSED_MESSAGE, values };
  return null;
}

// ---------------------------------------------------------------------------
// The four actions
// ---------------------------------------------------------------------------

/**
 * Send a connection request.
 *
 * Q78: it is sent FROM one of your own published profiles, not from a bare
 * organisation -- that is how the recipient knows who is asking. Both ends are
 * checked by the policy's two inline `exists` clauses, and the second of those
 * is what makes `to_organisation_id` unforgeable: the profile named must really
 * belong to the organisation named.
 *
 * ===========================================================================
 * THE RECIPIENT ORGANISATION IS NOT A PARAMETER (review finding I4)
 * ===========================================================================
 * `to_organisation_id` is NOT NULL on the table, and this action used to
 * require it from the form. NOTHING COULD SUPPLY IT. The only sanctioned way
 * to find a foreign profile is `public.network_directory`, which deliberately
 * does not project `organisation_id` -- a discovery result identifies a
 * PROFILE, never a tenant -- and selecting it from `public.network_profiles`
 * for a foreign organisation is forbidden in as many words by that table's
 * directory policy (20260904003000). So the send-from-directory flow Task 4
 * inherits had no legal source for the value, and the doc comment that used to
 * stand here ("the value comes from the caller's own connections list, where
 * it is the caller's own side") was true of a REPLY and false of a first
 * request. Constraint 19 makes that Task 1's defect, not Task 3's.
 *
 * IT IS NOW DERIVED IN THE DATABASE, by
 * `private.fill_connection_request_recipient()` (20260904006000), a BEFORE
 * INSERT trigger that fills the column from `to_network_profile_id` when the
 * caller omits it -- which this action now always does. So the client sends
 * exactly what the directory hands it: two profile ids.
 *
 * THE POLICY'S TERM (ii) IS UNCHANGED AND STILL DOES REAL WORK. The trigger
 * fills only when the column is NULL, so a direct PostgREST caller who DOES
 * supply a mismatched pair is still refused with 42501 -- which is what makes
 * the column unforgeable for every writer, including one that never loads this
 * application, and what rls_phase6_network.sql NR3 asserts.
 */
export async function sendConnectionRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseConnections(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const fromProfileId = field(formData, "fromProfileId");
  const toProfileId = field(formData, "toProfileId");
  if (!fromProfileId || !toProfileId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { error } = await supabase.from("network_connection_requests").insert({
    from_organisation_id: org.id,
    from_network_profile_id: fromProfileId,
    // NO `to_organisation_id`. Omitting it is what makes the trigger derive it
    // (20260904006000); sending one would be sending a value this application
    // has no honest way to obtain.
    to_network_profile_id: toProfileId,
    // `requested_by` explicitly, though the column defaults to auth.uid().
    requested_by: user.id,
  });

  if (error) {
    // 42501 here has one likely cause a user can act on -- an end that is no
    // longer published -- and two they cannot (tier, role). The sentence names
    // the actionable one without claiming to know which happened. A forged
    // to_organisation_id is no longer among them: this action does not send
    // one.
    if (error.code === "42501") {
      return { error: UNREACHABLE_PROFILE, values: echoedValues(formData) };
    }
    const mapped = connectionErrorState(error.code, formData);
    if (mapped) return mapped;
    console.error("[network] send connection request failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidateNetwork(org.slug);
  return { message: "Request sent. They’ll see it in their connections list." };
}

export async function acceptConnectionRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseConnections(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const requestId = field(formData, "requestId");
  if (!requestId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`accept connection request ${requestId}`, () =>
    supabase
      .from("network_connection_requests")
      .update(terminal("accepted", user.id), { count: "exact" })
      .eq("id", requestId)
      // THE RECIPIENT'S SIDE. Pinning `to_organisation_id` is what makes this
      // the accept path; the recipient-responds policy refuses it independently
      // if the pin is wrong, and pinning the sender's column instead would turn
      // a legitimate accept into a silent count-0.
      .eq("to_organisation_id", org.id)
      .eq("status", "pending"),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug);
  return stateFor(
    result,
    "Connected. Fields they marked for connections are now visible to you.",
    formData,
  );
}

export async function declineConnectionRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseConnections(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const requestId = field(formData, "requestId");
  if (!requestId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`decline connection request ${requestId}`, () =>
    supabase
      .from("network_connection_requests")
      .update(terminal("declined", user.id), { count: "exact" })
      .eq("id", requestId)
      .eq("to_organisation_id", org.id)
      .eq("status", "pending"),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug);
  // THE COPY SAYS declined IS TERMINAL, because it is (Q79): the live-pair
  // unique index keeps a declined row in place, so the sender cannot ask again.
  // A user declining a request should know they are closing the door rather
  // than snoozing it.
  return stateFor(
    result,
    "Declined. They can’t send another request to this profile.",
    formData,
  );
}

/**
 * Withdraw a request you sent.
 *
 * NO TIER GATE (see `authoriseWithdraw`). Q79: withdrawing frees the pair for
 * exactly one retry, which is the one escape hatch in an otherwise terminal
 * state machine -- so the copy says so, or a user who withdrew by accident does
 * not know they can simply ask again.
 */
export async function withdrawConnectionRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseWithdraw(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const requestId = field(formData, "requestId");
  if (!requestId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`withdraw connection request ${requestId}`, () =>
    supabase
      .from("network_connection_requests")
      // `terminal()` -- so `responded_at` moves with the status here too. A
      // withdraw is the SENDER responding to their own request, which reads
      // oddly and is what the constraint says: anything that is not `pending`
      // has a responded_at.
      .update(terminal("withdrawn", user.id), { count: "exact" })
      .eq("id", requestId)
      // THE SENDER'S SIDE.
      .eq("from_organisation_id", org.id)
      .eq("status", "pending"),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug);
  return stateFor(
    result,
    "Withdrawn. You can send one more request to this profile.",
    formData,
  );
}
