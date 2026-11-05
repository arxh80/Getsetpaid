"use server";

// Break-glass impersonation: the WRITE half (five Server Actions) and the two
// list queries the two surfaces read.
//
// The state machine itself lives in the database (20260908020000): five
// SECURITY DEFINER RPCs, each carrying its own guard and its own audit write
// in one transaction. NOTHING IN THIS FILE IS THE ENFORCEMENT. Every action
// below is a thin call onto one of those RPCs, and every refusal a user can
// provoke is raised by the database, not decided here -- which is what makes
// the raw-PostgREST path (reachable from any browser with the anon key) and
// the app path identical.
//
// ===========================================================================
// WHAT THIS FILE ADDS ON TOP OF THE RPCs, AND WHY EACH ONE IS NOT REDUNDANT
// ===========================================================================
// 1. STEP-UP RE-AUTHENTICATION, on the two superuser actions THAT GRANT --
//    request and start -- and deliberately NOT on the one that takes access
//    away (see endImpersonationAction's own header for why gating a safety
//    control behind a five-minute credential is backwards when the thing it
//    ends runs for sixty). CLAUDE.md § Session security requires step-up
//    "before ... any high-risk admin/superuser function (including
//    impersonation)". It is checked HERE and not in the database because
//    `amr` freshness lives in the JWT and is read through
//    supabase.auth.getClaims(), which revalidates the token with the auth
//    server -- a Postgres function sees only the decoded claims it was handed.
//    The database's own gate (has_platform_permission -> aal2) is the floor;
//    step-up is the additional "and you proved it in the last five minutes".
//    THE UI GATE IS NOT THE CONTROL: app/(app)/super/impersonation/page.tsx
//    wraps the request form in <StepUpGate>, and these actions re-check
//    anyway, because hiding a form is not enforcement (CLAUDE.md
//    § Permissions).
// 2. A SENTENCE PER REFUSAL. The RPCs raise deliberately undifferentiated
//    42501s (a foreign admin probing session ids must not be able to tell a
//    real id in another tenant from a fabricated one), so the mapping from
//    SQLSTATE to prose happens here, once.
// 3. revalidatePath, which the database cannot do.
//
// ===========================================================================
// WHY THERE IS NO "impersonate as user X" PARAMETER ANYWHERE
// ===========================================================================
// The superuser does not become a member; they hold the `read_only` key set
// over one organisation for one window (DECISIONS-QUEUE Q96/Q97). There is no
// identity to borrow, nothing writes as anyone else, and every audit row this
// flow produces names the REAL actor -- private.log_audit_event() forces
// actor_user_id = auth.uid() and takes no override. "Impersonation" is the
// product's word for the access, not a description of a spoofed session.

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp, mintStepUpToken } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { isSuperuser } from "@/lib/admin/superuser";

const STEP_UP_REQUIRED =
  "Confirm it’s you before opening support access. Use the re-authentication prompt at the top of this page, then try again.";

const REASON_TOO_LONG =
  "That reason is too long. Keep it under 500 characters — it is a note for the workspace’s admins, not a report.";

const NOT_YOURS =
  "That request can’t be actioned from here. Reload the page — it may already have been answered, or it may not be yours to answer.";

const REASON_REQUIRED = "Give a reason. It goes on the permanent audit record.";

const UNKNOWN_ORG =
  "No workspace has that URL name. Check the slug — it’s the part of the workspace URL after the first slash.";

const ALREADY_LIVE =
  "You already have a live request for that workspace. Finish or end it before opening another.";

/** One shape for every refusal this module can produce. */
function refuse(message: string, formData: FormData): FormState {
  return { error: message, values: echoedValues(formData) };
}

/**
 * Map a PostgREST error from one of the five RPCs to the sentence it deserves.
 *
 * The SQLSTATEs are the ones 20260908020000 raises by hand (42501/22023) plus
 * the live-pair unique index (23505). Anything else is a fault, not a
 * refusal, and falls through to FAILED_MESSAGE with the cause logged.
 */
function rpcRefusal(
  context: string,
  code: string | undefined,
  message: string,
  formData: FormData,
): FormState {
  if (code === "42501") return refuse(NOT_YOURS, formData);
  if (code === "23505") return refuse(ALREADY_LIVE, formData);
  // 23514 is impersonation_sessions_reason_present -- in practice always the
  // 500-character cap, since the empty case is caught as 22023 by the RPC
  // before the INSERT. The form carries maxLength={500}, so reaching this
  // means the form was bypassed; it still deserves a sentence the caller can
  // act on rather than "we couldn't save that just now".
  if (code === "23514") return refuse(REASON_TOO_LONG, formData);
  if (code === "22023") {
    // Two 22023s exist: an empty reason and an unknown slug. They are told
    // apart by the message the function raised, which is our own text, not a
    // user's -- so this is not string-matching on untrusted input.
    return refuse(
      message.includes("slug") ? UNKNOWN_ORG : REASON_REQUIRED,
      formData,
    );
  }
  console.error(`[admin] ${context} failed:`, message);
  return refuse(FAILED_MESSAGE, formData);
}

/**
 * The superuser-side gate: on the allowlist, and a credential presented in the
 * last five minutes.
 *
 * isSuperuser() is the IDENTITY check and is deliberately not aal-gated
 * (lib/admin/superuser.ts); the aal2 requirement is enforced by
 * private.has_platform_permission() inside every RPC. This function therefore
 * checks the two things the database cannot see for itself: that the caller is
 * signed in at all, and that step-up is fresh.
 */
async function authoriseSuperuser(
  formData: FormData,
  { requireStepUp }: { requireStepUp: boolean },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly state: FormState }> {
  if (!(await getCurrentUser())) {
    return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  }
  if (!(await isSuperuser())) {
    // Not a distinguishing message: the same sentence a superuser gets when
    // they aim at somebody else's session. There is nothing to learn here.
    return { ok: false, state: refuse(NOT_YOURS, formData) };
  }
  if (requireStepUp && (!(await checkStepUp()) || !(await mintStepUpToken("impersonation")))) {
    return { ok: false, state: refuse(STEP_UP_REQUIRED, formData) };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 1. REQUEST (superuser)
// ---------------------------------------------------------------------------
export async function requestImpersonationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // STEP-UP REQUIRED: this is the act CLAUDE.md § Session security names.
  const gate = await authoriseSuperuser(formData, { requireStepUp: true });
  if (!gate.ok) return gate.state;

  const slug = field(formData, "organisationSlug");
  const reason = field(formData, "reason");
  const fieldErrors: Record<string, string> = {};
  if (!slug) fieldErrors.organisationSlug = "Enter the workspace’s URL name.";
  if (!reason) fieldErrors.reason = REASON_REQUIRED;
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("request_impersonation", {
    p_organisation_slug: slug,
    p_reason: reason,
  });
  if (error) {
    return rpcRefusal("request_impersonation", error.code, error.message, formData);
  }

  revalidatePath("/super/impersonation");
  return {
    message:
      "Request sent. An Owner or Admin of that workspace has to accept it before you can start a session — nothing is visible to you until they do.",
  };
}

// ---------------------------------------------------------------------------
// 2. START (superuser)
// ---------------------------------------------------------------------------
export async function startImpersonationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // STEP-UP REQUIRED. This is the moment access actually begins -- the
  // request only asked -- so it is the one that most deserves a fresh
  // credential, and acceptance can arrive hours after the request, by which
  // time the sign-in that covered the request is long stale. The page's
  // <StepUpGate> renders the re-auth prompt above this list when it is, which
  // is where STEP_UP_REQUIRED sends the caller.
  const gate = await authoriseSuperuser(formData, { requireStepUp: true });
  if (!gate.ok) return gate.state;

  const sessionId = field(formData, "sessionId");
  if (!sessionId) return refuse(FAILED_MESSAGE, formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc("start_impersonation_session", {
    p_session_id: sessionId,
  });
  if (error) {
    return rpcRefusal(
      "start_impersonation_session",
      error.code,
      error.message,
      formData,
    );
  }

  revalidatePath("/super/impersonation");
  revalidatePath("/", "layout");
  return { message: "Session started. It ends automatically when the clock runs out." };
}

// ---------------------------------------------------------------------------
// 3. END (superuser side)
// ---------------------------------------------------------------------------
/**
 * End a session, from the superuser's side.
 *
 * ===========================================================================
 * NO STEP-UP HERE, AND THIS IS A DELIBERATE ASYMMETRY WITH THE TWO ABOVE
 * ===========================================================================
 * FOUND IN SELF-REVIEW, and it is the kind of thing a uniform gate gets wrong
 * by being uniform. The step-up window is FIVE MINUTES (lib/auth/step-up.ts)
 * and the impersonation time-box is SIXTY, so for fifty-five of every sixty
 * minutes a superuser's credential is stale -- and if ending were gated the
 * same way as starting, the operator would be unable to CLOSE their own
 * session without re-authenticating first.
 *
 * That is backwards. Step-up exists to guard an action that GRANTS
 * capability; ending removes it. Putting friction in front of the safety
 * control makes the dangerous state (a session left open) the path of least
 * resistance, which is the opposite of what the gate is for. The customer's
 * own revoke on /[orgSlug]/support-access has no step-up either, for the same
 * reason, and neither does signing out.
 *
 * The identity check stays, and the database's own guard
 * (public.end_impersonation_session: your session, or `end_support_access` in
 * the target organisation) is unchanged and is the actual control -- that key
 * replaced `manage_organisation` in the pre-merge fix round (finding I1),
 * because manage_organisation does not survive suspension and the customer's
 * ability to REVOKE consent has to.
 */
export async function endImpersonationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const gate = await authoriseSuperuser(formData, { requireStepUp: false });
  if (!gate.ok) return gate.state;

  const sessionId = field(formData, "sessionId");
  if (!sessionId) return refuse(FAILED_MESSAGE, formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc("end_impersonation_session", {
    p_session_id: sessionId,
  });
  if (error) {
    return rpcRefusal("end_impersonation_session", error.code, error.message, formData);
  }

  revalidatePath("/super/impersonation");
  // The banner and the whole org shell are downstream of this; drop the
  // layout cache so the next org route the superuser tries renders its 404
  // rather than a stale bannered page.
  revalidatePath("/", "layout");
  return { message: "Session ended." };
}

// ---------------------------------------------------------------------------
// 4/5/6. THE ORGANISATION'S SIDE: accept, decline, revoke
//
// NO STEP-UP HERE, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
// manage_organisation -- and `end_support_access`, granted to exactly the roles
// that hold it -- is held only by Owner and Admin, both of which
// private.role_requires_mfa() covers, so the database already refuses these
// three below aal2 -- the accepting admin has presented a factor this session.
// CLAUDE.md's step-up list names "high-risk admin/superuser function", and
// whether granting support access should ALSO demand a five-minute-fresh
// credential is a real question rather than an obvious yes: the surface is a
// list page an admin may sit on, and a re-auth prompt in place of the list
// would be the first gate in the product to fire on a read. Queued as
// DECISIONS-QUEUE Q99 with "aal2 only, no step-up" as the shipped default.
// ---------------------------------------------------------------------------

/**
 * Resolve the acting organisation for one of the three org-side actions.
 *
 * Deliberately does NOT check manage_organisation here: the RPCs do, in the
 * same transaction as the write, and re-checking in TypeScript would be a
 * second copy of a rule that can drift. What this DOES establish is the
 * caller's own view of the workspace -- which is what revalidatePath needs,
 * and which fails for a slug that is not theirs.
 */
async function actingOrg(
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly state: FormState }
> {
  const orgSlug = field(formData, "orgSlug");
  if (!orgSlug) return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  return { ok: true, slug: org.slug };
}

async function callSessionRpc(
  fn: "accept_impersonation_request" | "decline_impersonation_request" | "end_impersonation_session",
  formData: FormData,
  success: string,
): Promise<FormState> {
  const acting = await actingOrg(formData);
  if (!acting.ok) return acting.state;

  const sessionId = field(formData, "sessionId");
  if (!sessionId) return refuse(FAILED_MESSAGE, formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, { p_session_id: sessionId });
  if (error) return rpcRefusal(fn, error.code, error.message, formData);

  revalidatePath(`/${acting.slug}/support-access`);
  return { message: success };
}

export async function acceptImpersonationRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callSessionRpc(
    "accept_impersonation_request",
    formData,
    "Accepted. GetSetPaid support can now open a 60-minute, read-only session on this workspace. You can end it at any time from this page.",
  );
}

export async function declineImpersonationRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callSessionRpc(
    "decline_impersonation_request",
    formData,
    "Declined. Nothing was shared, and support can’t open a session on this request.",
  );
}

export async function revokeImpersonationSessionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return callSessionRpc(
    "end_impersonation_session",
    formData,
    "Ended. Support access to this workspace has stopped.",
  );
}
