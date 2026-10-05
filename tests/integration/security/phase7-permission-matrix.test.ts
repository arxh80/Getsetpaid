// =============================================================================
// PHASE 7 TASK 7 -- THE PERMISSION MATRIX, AT THE DATABASE LAYERS
// =============================================================================
// "An action is allowed only if ALL of these permit it: platform policy n
// subscription entitlement n organisation role n record scope n user-specific
// exception. Entitlements are enforced server-side -- hiding UI is not
// enforcement." (CLAUDE.md § Permissions.)
//
// This file is the RPC, TABLE and GRANT half of that proof. The PAGE half is
// tests/e2e/super-permissions.spec.ts, which needs a browser and a dev server;
// everything here talks to PostgREST with the anon key and a real principal's
// JWT -- the request a script sends, never the form.
//
// -----------------------------------------------------------------------------
// THE INVENTORY IS A CENSUS, NOT A LOOKUP -- AND THAT IS A FIX ROUND 1 CHANGE
// -----------------------------------------------------------------------------
// `SUPERUSER_ONLY_RPCS` and `PHASE7_TABLES` below were not written from memory.
// They were produced by querying the live catalogue for everything Phase 7's
// migrations (20260908000000 onward) added and left reachable from a browser:
//
//   -- functions a session can call at all
//   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
//     cross join lateral aclexplode(p.proacl) ax
//    where n.nspname = 'public' and ax.privilege_type = 'EXECUTE'
//      and pg_get_userbyid(ax.grantee) = 'authenticated';
//
//   -- relations a session can reach at all
//   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
//    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
//      and exists (select 1 from aclexplode(c.relacl) ax
//                   where pg_get_userbyid(ax.grantee) = 'authenticated');
//
// AS FIRST SHIPPED, THIS HEADER CLAIMED MORE THAN THE CODE DID, and the review
// caught it: the RPC query ended `and p.proname = any($1::text[])` -- it could
// only confirm that names ALREADY on the list still existed and were still
// granted -- and `PHASE7_TABLES` was a hardcoded literal with nothing derived
// from `pg_class` at all. A Phase 8 function or table granted to
// `authenticated` and never added to either list was invisible to both.
//
// SINCE PHASE 8 TASK 1'S FIX ROUND 1 (M8), BOTH CENSUSES COUNT `anon` TOO. A
// relation or function granted to `anon` ALONE is exactly the public-read case
// that task introduced, and a query keyed on `authenticated` could not see
// one. (None exists today: `legal_documents` and `subscription_plans` are the
// two anon-readable relations and both are granted to `authenticated` as
// well; `anon` holds EXECUTE on no function in `public`.)
//
// Both are now genuine censuses (§ GATE 0). Each runs the query above with NO
// name filter and asserts the FULL result set equals this file's lists plus a
// declared, justified allowlist of the pre-Phase-7 surfaces this task is not
// about (`PRE_PHASE7_RPCS`, `PRE_PHASE7_RELATIONS`). So a Phase 8 grant lands
// here as a red test naming itself, which is what the sentence always meant to
// promise. What a census still cannot catch: a surface reachable WITHOUT a
// grant to `authenticated` (a SECURITY DEFINER function granted to `public`,
// or a table in another exposed schema), and anything outside PostgREST
// entirely -- see THE LAYER THIS FILE DOES NOT REACH, below.
//
// -----------------------------------------------------------------------------
// THE LAYER THIS FILE DOES NOT REACH, NAMED RATHER THAN IMPLIED (Q126)
// -----------------------------------------------------------------------------
// The brief asks for a server-action layer probe: each of the fifteen exported
// `*Action` functions behind these surfaces invoked directly as each principal.
// THAT IS NOT TESTED HERE, by any test this task added. It is a real gap, and
// it is mitigated by something stronger than reasoning: NO module under
// `lib/admin/` -- nor `lib/feedback/admin-actions.ts` -- imports
// `lib/supabase/service.ts`, the service-role table client. So all fifteen run
// under the caller's own RLS and are enforced by the RPC and table layers THIS
// file probes, one layer down: eleven are thin wrappers over the guarded RPCs
// above, and `resolveIncidentAlertAction` / `updateFeedbackStatusAction` are
// plain RLS-gated `.update()`s covered by the table-layer UPDATE probe (which
// asserts an md5 of the whole table, not a row count). And that fact is
// ASSERTED, not assumed: `tests/unit/email/service-client-census.test.ts`
// censuses every file under `app`, `components`, `lib` and `proxy.ts` for
// importers of that client and allows exactly three `lib/email/*` modules, so
// a future `lib/admin/` action reaching for it is red before it merges.
// What is left open, and why this is queued as Q126: `lib/supabase/storage.ts`
// has no equivalent census (the feedback screenshot pipeline legitimately uses
// it, and is probed at the ROUTE layer by super-permissions.spec.ts), so a new
// operator surface could import that one with nothing going red.
//
// -----------------------------------------------------------------------------
// WHAT THE TWO RED MUTATIONS PROVE, AND WHAT EACH DOES NOT
// -----------------------------------------------------------------------------
// `private.has_platform_permission()` is a conjunction of two terms. Dropping
// EITHER, in the running database only, is a mutation this suite is measured
// against -- and the two answers are different in a way that matters:
//
// BOTH NUMBERS BELOW WERE RE-MEASURED IN THE PRE-MERGE FIX ROUND, against the
// suite as it stands. Fix round 1's own M1 change INVALIDATED mutation 1's
// figures -- pointing the `start_impersonation_session` refusals at a genuinely
// `accepted` session is exactly what makes that surface red under this mutation
// -- and the round did not re-run them, so this header carried 23/12/8/2 while
// the ledger's own re-measurement said 24. Each was run by replacing the
// function body in the running database only, then RESTORED BY A FULL
// `npx supabase db reset --local` and re-proved 224/224 green with
// `pg_get_functiondef()` byte-identical to the pre-mutation dump.
//
//   1. Drop `private.session_is_aal2()`, keeping the platform_admins term:
//      **24 of 224 red** (200 passed). This can only move ONE of the seven
//      principals -- a caller who is on the allowlist and below aal2, i.e.
//      `superuserAal1` -- so 21 of the 24 are that principal (**13 RPC
//      refusals, 7 table reads, 1 table write**) and 3 are cascade (the
//      `start_impersonation_session` positive control, which the aal2
//      superuser now shares a row with; one `accept_impersonation_request`
//      member-reachability check; and one `impersonation_sessions` read by
//      `overriddenOrgOwner`). The GRANT layer necessarily goes 0 red, because
//      grants do not read that function. It says nothing about the Owner rows,
//      Read Only, no-org or anonymous.
//   2. Drop the `platform_admins` term, keeping `session_is_aal2()`:
//      **53 of 224 red** (171 passed), ALL of them the three Owner principals
//      (33 RPC refusals -- **11 of the 13 RPCs, three times over** -- 19 table
//      reads, 1 table write). THIS is the mutation that proves the plan's named
//      case -- "unreachable by a non-superuser, EVEN AN ORG OWNER" -- is a
//      measurement and not an argument, and it proves as a side effect that the
//      Owner fixtures genuinely reach aal2: an aal1 Owner would not have gone
//      red at all.
//      **THE TWO RPCs IT LEAVES GREEN ARE THE POINT OF THE CAVEAT AT `ARGS`
//      BELOW**: `start_impersonation_session` and `audit_impersonated_page_view`
//      both carry a second, row-OWNERSHIP term (`superuser_user_id =
//      auth.uid()`, a live session held by the caller), so an Owner is refused
//      by that rather than by the guard and this mutation cannot move them.
//      Measured, not inferred -- the eleven names are in the run's own output.
//
// Neither mutation can move `readOnlyMember`, `noOrganisation` or `anonymous`
// (they are aal1 or sessionless, so neither term can flip them); their refusals
// rest on the positive controls instead.
//
// -----------------------------------------------------------------------------
// EVERY REFUSAL CARRIES A POSITIVE CONTROL. THIS IS THE POINT OF THE FILE.
// -----------------------------------------------------------------------------
// Four times this phase a test passed because its subject was never exercised:
// an upload limit nothing tested above 1 MB; an axe scan green because an
// expanded <pre> sat between the toggles it measured; a settings scan green
// because the fixture was a `manager` and the controls are Owner/Admin-only; a
// feature whose un-gating was protected by nothing. A refusal test is uniquely
// exposed to that class, because "the guard refused me" and "I could never have
// reached this anyway" are INDISTINGUISHABLE from the outside and mean opposite
// things -- a typo'd function name, a nonexistent row, an empty table and a
// missing fixture all produce a perfectly green refusal.
//
// So the arguments each refused principal calls an RPC with are THE SAME
// ARGUMENTS the aal2 superuser succeeds with, in the same run, against the same
// rows: `describe.each` drives both from one `ARGS` record. If the arguments
// were invalid, the function missing, or the row absent, the positive control
// goes red and says so. The same rule governs the table layer: every one of the
// seven tables is asserted NON-EMPTY, through the superuser's own read, before
// any "reads zero rows" assertion about anybody else is allowed to mean
// anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createFixtures,
  destroyFixtures,
  elevateToAal2,
  type RlsFixtures,
} from "../rls/support/fixtures";
import {
  cronJobs,
  destructivePrimitiveAcl,
  difference,
  exposedNullAclFunctions,
  exposedOverloads,
  exposedRpcSignatures,
  exposedSchemas,
  publicPrivileges,
  publicRelationsGranted,
  publicRpcNames,
  serviceRoleRpcSignatures,
  storageBuckets,
  storageFences,
  storagePermissivePolicies,
  tickCallees,
  type Queryable,
} from "./support/catalogue-census";
import { DECLARED_PRIVILEGES } from "./support/privilege-census";

// The SQLSTATEs a Phase 7 guard refuses with. 42501 is the house code for
// "caller is not the platform superuser at aal2" (every Phase 7 guard raises
// it), 28000 for "no session", and 42501 again for a missing EXECUTE grant.
// PGRST202 is PostgREST's "no such function in the exposed schema", which is
// what `anon` gets when a function it holds no grant on is not even in its
// schema cache view.
const REFUSAL_CODES = new Set(["42501", "28000", "PGRST202", "PGRST301", "P0001"]);

/**
 * Phase 8 Task 8: WHICH MECHANISM refused, which REFUSAL_CODES cannot say.
 * `42501` is both "the function's own guard refused you" and "you hold no
 * grant on the function" -- and a refusal by a missing grant is how Task 3's
 * dead seam guard stayed green. Classified from the error PostgREST returns:
 *   no-grant    -- Postgres' own "permission denied for <object>"
 *   not-exposed -- PGRST202, not in the role's schema cache at all
 *   no-session  -- 28000, raised by a function that found no auth.uid()
 *   guard       -- any other 42501: raised by the function or trigger itself
 *   other       -- anything else (a CHECK, a unique index, row state...)
 *   none        -- no error at all
 */
type Mechanism = "no-grant" | "not-exposed" | "no-session" | "guard" | "other" | "none";
function mechanismOf(error: { code?: string; message: string } | null | undefined): Mechanism {
  if (!error) return "none";
  if (error.code === "PGRST202") return "not-exposed";
  if (/permission denied for (function|table|view|relation|schema|sequence|column)/i.test(error.message)) {
    return "no-grant";
  }
  if (error.code === "28000") return "no-session";
  if (error.code === "42501") return "guard";
  return "other";
}
/** What may refuse a caller with no session. Never "guard": a guard that is
 *  what refuses anon means anon was granted something it should not hold. */
const ANON_MECHANISMS = new Set<Mechanism>(["no-grant", "not-exposed", "no-session"]);
/** The three lifecycle RPCs share ONE guard helper, whose message names the
 *  helper rather than the function -- still the function's own guard, reached
 *  on its first line. */
const GUARD_PREFIX: Record<string, string> = {
  suspend_organisation: "organisation lifecycle:",
  delete_organisation: "organisation lifecycle:",
  reinstate_organisation: "organisation lifecycle:",
  // Phase 8 Task 9c job 2: the two closure decisions share one guard helper
  // (private.closure_decision_target), whose message names the helper.
  reassign_closed_workspace: "closure decision:",
  delete_closed_workspace: "closure decision:",
};

// =============================================================================
// THE PRINCIPALS -- the Task 7 brief's list, built rather than described
// =============================================================================
type PrincipalKey =
  | "anonymous"
  | "noOrganisation"
  | "readOnlyMember"
  | "orgOwner"
  | "impersonatedOrgOwner"
  | "overriddenOrgOwner"
  | "suspendedMember"
  | "superuserAal1";

interface Principal {
  key: PrincipalKey;
  /** Why this principal is on the list -- the brief's own numbering. */
  why: string;
  client: () => SupabaseClient;
}

let fx: RlsFixtures;
let pool: Pool;

/** Principal 2: authenticated, member of nothing. */
let noOrgClient: SupabaseClient;
/** Principal 6: the superuser's own account on a session that never presented
 *  a factor. Same user id, same platform_admins row, aal1. */
let superuserAal1Client: SupabaseClient;
/** Principal 8's positive control: the superuser at aal2. */
let superuser: SupabaseClient;
/**
 * Phase 8 Task 8: a member -- the OWNER, at aal2 -- of a SUSPENDED workspace.
 * Phase 8 makes this principal meaningful for the first time: a suspended
 * workspace is read-only, but its people keep their statutory rights, and one
 * Phase 8 key (`export_organisation_data`) is deliberately
 * `survives_suspension = true`. So this principal must be refused every
 * operator surface like everybody else, and must STILL be able to exercise
 * the rights the product says survive suspension -- both asserted below.
 */
let suspendedClient: SupabaseClient;
let suspendedUserId = "";
const suspendedOrg = { id: "", slug: "" };

/** Rows the matrix addresses. All created through real paths in beforeAll --
 *  see SETUP DOUBLES AS THE POSITIVE CONTROL. */
const ARGS = {
  impersonationSessionId: "",
  /**
   * M1, fix round 1. A session held in `accepted` for the whole run, on its own
   * organisation, and the ONLY thing `start_impersonation_session`'s refusals
   * are aimed at.
   *
   * They used to be aimed at `impersonationSessionId` -- the session beforeAll
   * has already STARTED. That function refuses any row that is not `accepted`
   * with `42501`, the guard's own SQLSTATE, so all seven principals were being
   * refused by ROW STATE wearing the guard's code, and `REFUSAL_CODES` could
   * not tell the two apart. It was not theoretical: under mutation 1 (above),
   * 12 of the 13 superuser-only RPCs went red on `superuserAal1` and this one
   * STAYED GREEN -- the guard was gone and the test said the guard held. With
   * the refusals pointed at a genuinely `accepted` session owned by the
   * superuser, the guard is the only thing between THE SUPERUSER'S OWN aal1
   * SESSION and success, and the same mutation reds it.
   *
   * THAT QUALIFIER IS LOAD-BEARING, AND THE SENTENCE USED TO OMIT IT
   * (pre-merge review). After `has_platform_permission`, the UPDATE also
   * requires `superuser_user_id = (select auth.uid())`, which refuses
   * `anonymous`, `noOrganisation`, `readOnlyMember`, `orgOwner`,
   * `impersonatedOrgOwner` and `overriddenOrgOwner` with the identical
   * `42501`. So for SIX OF THE SEVEN principals M1 replaced one non-guard
   * refusal reason (row state) with another (row ownership); what it fixed
   * is the ONE principal the mutation can move. The measurable consequence,
   * stated rather than left for the next reader to discover: **dropping the
   * `platform_admins` term leaves THIS SURFACE entirely green**, which is
   * consistent with mutation 2's own arithmetic below -- its RPC refusals
   * divide evenly across the three Owner principals, and this surface
   * contributes none of them.
   */
  acceptedImpersonationSessionId: "",
  billingOverrideId: "",
  featureOverrideId: "",
  feedbackId: "",
  incidentAlertId: "",
  /** Phase 8 Task 1: a legal-document DRAFT held open for the whole run --
   *  the row every refused draft/publish/review call is aimed at, so a
   *  refusal is the guard's and not "no such draft". */
  legalDraftId: "",
  /** Phase 8 Task 2: a consent GRANT recorded by the Read Only member through
   *  the real RPC -- the row every other principal must not be able to read
   *  or change. */
  consentId: "",
  /** Phase 8 Task 3: a data subject request made through the real RPC by the
   *  Read Only member -- the row every refused transition and note is aimed
   *  at, so a refusal is the guard's and not "no such request". */
  dsrRequestId: "",
  /** Phase 8 Task 3 fix round 1: a PROCESSOR-scope request held open, because
   *  routing is refused on an account-scope one by the database whoever asks
   *  -- a refusal on that row would prove the scope check and not the
   *  permission gate. */
  dsrProcessorRequestId: "",
  /**
   * Phase 8 Task 4: an ACCOUNT export job started by the Read Only member
   * through the real path -- the row every other principal must not be able
   * to read, download or move. An account export needs no workspace
   * permission at all (it is the person's own data about themselves), so the
   * Read Only member is a real requester rather than a contrivance.
   */
  exportJobId: "",
  /**
   * Phase 8 Task 5: an account-scope ERASURE request made by the Read Only
   * member through the real RPC and held OPEN -- the row every refused
   * `start_erasure_for_request` call is aimed at, so a refusal is the
   * operator gate's and not "no such request" or "that request is closed".
   * Nothing ever runs the job it would create: this suite has no runner, the
   * positive control deletes the queued row it makes, and the Read Only
   * member's account is therefore never touched.
   */
  dsrErasureRequestId: "",
  /**
   * Phase 8 Task 6. A real retention run, made by a real DRY run through the
   * real RPCs in beforeAll -- the row public.retention_runs' positive control
   * needs before "nobody else can read it" means anything. A dry run deletes
   * nothing, so planting it costs the rest of the fixture nothing.
   */
  retentionRunId: "",
  /** Phase 8 Task 8: an account erasure job the no-workspace principal
   *  queued for themself, held for the run and never run. */
  erasureJobId: "",
};

// Phase 8 Task 2: the no-organisation principal's user id, for the
// record_consent attribution probe.
let noOrgUserId = "";

// Phase 8 Task 1. The slug the long-lived draft lives on, and the one each
// legal positive control borrows and gives back. Two different slugs, because
// a document holds at most one draft.
const LEGAL_HELD_SLUG = "accessibility";
const LEGAL_SCRATCH_SLUG = "ai-use";
const LEGAL_DRAFT_BODY = "## Matrix draft\n\nPermission matrix fixture text.";

const PRINCIPALS: Principal[] = [
  {
    key: "anonymous",
    why: "brief principal 1 -- no session at all",
    client: () => fx.anonClient,
  },
  {
    key: "noOrganisation",
    why: "brief principal 2 -- authenticated, a member of no organisation",
    client: () => noOrgClient,
  },
  {
    key: "readOnlyMember",
    why: "brief principal 3 -- a Read Only member of an organisation",
    client: () => fx.activeByRole.read_only.client,
  },
  {
    key: "orgOwner",
    why:
      "brief principal 4 -- an Org Owner AT aal2, the plan's named case. Owners " +
      "hold every in-tenant permission, so this is the principal most likely to " +
      "have been granted something by accident. aal2 matters: an aal1 owner " +
      "holds none of their own keys and would refuse for the MFA reason.",
    client: () => fx.ownerA.client,
  },
  {
    key: "impersonatedOrgOwner",
    why:
      "brief principal 5 -- the Owner of an organisation with a LIVE " +
      "impersonation session granted to the superuser. The session grants the " +
      "superuser a read of this workspace; it must grant this workspace nothing.",
    client: () => fx.ownerA.client,
  },
  {
    key: "overriddenOrgOwner",
    why:
      "brief principal 7 -- the Owner of an organisation carrying an active Pro " +
      "billing override. Subscription entitlement must not leak into platform " +
      "policy: a comped tier buys features, never the operator's console.",
    client: () => fx.ownerB.client,
  },
  {
    key: "suspendedMember",
    why:
      "Phase 8 Task 8 -- the Owner, AT aal2, of a SUSPENDED workspace. Holds " +
      "every in-tenant key the Owner role has; suspension switches off every " +
      "key but the three with survives_suspension = true. Refused every " +
      "operator surface, and still free to exercise their own rights.",
    client: () => suspendedClient,
  },
  {
    key: "superuserAal1",
    why:
      "brief principal 6 -- the platform superuser BELOW aal2. On the " +
      "allowlist, in platform_admins, one factor short. Tasks 1-6 each claimed " +
      "this refuses; this is the one place that proves it for every surface.",
    client: () => superuserAal1Client,
  },
];

// =============================================================================
// THE SUPERUSER-ONLY RPC INVENTORY
// =============================================================================
interface RpcSurface {
  fn: string;
  /** Built fresh per call so a row id created in beforeAll is read late. */
  args: () => Record<string, unknown>;
  /** The table a successful call would have written, snapshotted around every
   *  refusal so "refused" means "no side effect", not "an error came back". */
  sideEffectTable: string | null;
  /**
   * How to prove the aal2 superuser CAN do this, when a plain replay of
   * `args()` cannot say so.
   *
   * Three of the thirteen are not replayable: `start_impersonation_session`
   * refuses a session that is already running, and the two `revoke_*`
   * functions would destroy the very rows principals 5 and 7 are BUILT from.
   * Each therefore stands up its own disposable row, exercises the function on
   * it, and tidies up -- which is a STRONGER control than a replay, not a
   * weaker one: it proves the function end to end rather than proving it is
   * idempotent.
   */
  positiveControl?: () => Promise<void>;
  /**
   * An extra assertion run after EVERY refusal, for surfaces where "no side
   * effect" is a change to an existing row rather than a new one -- which
   * `sideEffectTable`'s row count cannot see. M1's surface is the only one
   * that has this today: a successful start moves the disposable session out
   * of `accepted`, so re-asserting the state it must still be in catches a
   * guard that let one principal through before the next principal's refusal
   * silently became a row-state refusal again.
   */
  invariant?: () => Promise<void>;
}

const SUPERUSER_ONLY_RPCS: RpcSurface[] = [
  // Phase 8 Task 9c job 2 (20261022001000; founder 2026-09-30, Q176/Q178).
  // THE SUPERUSER'S TWO DECISIONS ON A CLOSED WORKSPACE, and its dashboard
  // list. Probed against org B, which is ACTIVE -- so a principal that got
  // past the gates would still be refused, by the state check; the refusal
  // must therefore be the GUARD's (42501, message prefixed by the helper),
  // which is what the loop asserts. The positive control is the aal2
  // superuser reaching that state check: the decision gate let it through.
  // The decisions themselves are walked end to end in
  // rls_phase8_workspace_closure.sql § CS/CR/CX.
  ...(["reassign_closed_workspace", "delete_closed_workspace"] as const).map(
    (fn): RpcSurface => ({
      fn,
      args: () =>
        fn === "reassign_closed_workspace"
          ? { p_organisation_slug: fx.orgB.slug, p_new_owner_user_id: fx.ownerB.userId, p_reason: "matrix probe" }
          : { p_organisation_slug: fx.orgB.slug, p_reason: "matrix probe" },
      sideEffectTable: "audit_events",
      invariant: async () => {
        const { rows } = await pool.query<{ state: string }>(
          `select lifecycle_state as state from public.organisations where slug = $1`,
          [fx.orgB.slug],
        );
        expect(rows[0]?.state, `a refused principal moved org B through ${fn}`).toBe("active");
      },
      positiveControl: async () => {
        const args =
          fn === "reassign_closed_workspace"
            ? { p_organisation_slug: fx.orgB.slug, p_new_owner_user_id: fx.ownerB.userId, p_reason: "matrix positive control" }
            : { p_organisation_slug: fx.orgB.slug, p_reason: "matrix positive control" };
        const { error } = await superuser.rpc(fn, args);
        expect(
          error?.message ?? "",
          `${fn} must let the aal2 superuser past its gate (to the owner_closed check): ${error?.message}`,
        ).toMatch(/only a workspace its Owner closed awaits this decision/);
      },
    }),
  ),
  {
    fn: "closed_workspaces_awaiting_decision",
    args: () => ({ p_limit: 25 }),
    sideEffectTable: null,
    positiveControl: async () => {
      const { error } = await superuser.rpc("closed_workspaces_awaiting_decision", { p_limit: 25 });
      expect(error, `closed_workspaces_awaiting_decision: ${error?.message}`).toBeNull();
    },
  },
  // Phase 8 Task 9c job 3a (20261023000000): the reassign picker's read. Probed
  // against org B, which is ACTIVE, so the positive control is the aal2
  // superuser reaching the owner_closed check (the gate let it through); the
  // roster itself is walked end to end by tests/e2e/super-closures.spec.ts.
  {
    fn: "closed_workspace_reassign_candidates",
    args: () => ({ p_organisation_id: fx.orgB.id }),
    sideEffectTable: null,
    positiveControl: async () => {
      const { error } = await superuser.rpc("closed_workspace_reassign_candidates", {
        p_organisation_id: fx.orgB.id,
      });
      expect(
        error?.message ?? "",
        `closed_workspace_reassign_candidates must let the aal2 superuser past its gate: ${error?.message}`,
      ).toMatch(/only a workspace its Owner closed awaits this decision/);
    },
  },
  {
    fn: "request_impersonation",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_reason: "matrix positive control: request support access",
    }),
    sideEffectTable: "impersonation_sessions",
    positiveControl: async () => {
      // TIDIES ITS OWN ROW, and that is not housekeeping. `impersonation_
      // sessions_live_pair` is a unique index over (superuser, organisation)
      // for a LIVE pair, so a pending request left behind here makes the next
      // legitimate request on org B fail with 23505 -- and a positive control
      // that fails for a fixture reason is indistinguishable from the function
      // being broken, which is the failure mode this whole file is about.
      const { data: id, error } = await superuser.rpc("request_impersonation", {
        p_organisation_slug: fx.orgB.slug,
        p_reason: "matrix positive control: request support access",
      });
      expect(
        error,
        `request_impersonation must be reachable by the aal2 superuser: ${error?.message}`,
      ).toBeNull();
      await pool.query(`delete from public.impersonation_sessions where id = $1`, [id]);
    },
  },
  {
    fn: "start_impersonation_session",
    // M1: a session in `accepted`, not the one beforeAll already started. See
    // ARGS.acceptedImpersonationSessionId.
    args: () => ({ p_session_id: ARGS.acceptedImpersonationSessionId }),
    sideEffectTable: null,
    invariant: async () => {
      const { rows } = await pool.query<{ status: string; started_at: string | null }>(
        `select status, started_at from public.impersonation_sessions where id = $1`,
        [ARGS.acceptedImpersonationSessionId],
      );
      expect(
        rows[0]?.status,
        "the disposable session left `accepted` -- a principal STARTED it, so " +
          "every refusal after this one is a refusal by row state rather than " +
          "by the guard, which is exactly the false green M1 closed",
      ).toBe("accepted");
      expect(rows[0]?.started_at, "the refused start still stamped started_at").toBeNull();
    },
    positiveControl: async () => {
      // A disposable session on org B, walked end to end: request (superuser),
      // accept (that workspace's own Owner), start (superuser), end. A replay
      // against ARGS.impersonationSessionId would refuse -- it is already
      // running -- and would then look exactly like the guard refusing.
      const { data: id, error: reqErr } = await superuser.rpc("request_impersonation", {
        p_organisation_slug: fx.orgB.slug,
        p_reason: "positive control for start_impersonation_session",
      });
      expect(reqErr, `request_impersonation: ${reqErr?.message}`).toBeNull();
      const acc = await fx.ownerB.client.rpc("accept_impersonation_request", {
        p_session_id: id as string,
      });
      expect(acc.error, `accept_impersonation_request: ${acc.error?.message}`).toBeNull();
      const started = await superuser.rpc("start_impersonation_session", {
        p_session_id: id as string,
      });
      expect(
        started.error,
        `start_impersonation_session must be reachable by the aal2 superuser: ${started.error?.message}`,
      ).toBeNull();
      const ended = await superuser.rpc("end_impersonation_session", {
        p_session_id: id as string,
      });
      expect(ended.error, `end_impersonation_session: ${ended.error?.message}`).toBeNull();
      // Removed for the same reason request_impersonation removes its own:
      // org B must be left with NO session row, so the table block below can
      // assert that org B's Owner reads none -- an assertion a leftover row
      // from this control would silently turn into its opposite.
      await pool.query(`delete from public.impersonation_sessions where id = $1`, [id]);
    },
  },
  {
    fn: "audit_impersonated_page_view",
    args: () => ({
      p_organisation_id: fx.orgA.id,
      p_route: `/${fx.orgA.slug}/contacts`,
    }),
    sideEffectTable: "audit_events",
  },
  {
    fn: "audit_superuser_audit_log_view",
    args: () => ({ p_filters: {} }),
    sideEffectTable: "audit_events",
  },
  {
    fn: "platform_health_snapshot",
    args: () => ({}),
    sideEffectTable: "audit_events",
  },
  {
    fn: "suspend_organisation",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_reason: "matrix positive control: suspend",
    }),
    sideEffectTable: "organisations",
  },
  {
    fn: "delete_organisation",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_reason: "matrix positive control: close",
    }),
    sideEffectTable: "organisations",
  },
  {
    fn: "reinstate_organisation",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_reason: "matrix positive control: reopen",
    }),
    sideEffectTable: "organisations",
  },
  {
    fn: "grant_billing_override",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_override_tier: "pro",
      p_override_seats: null,
      p_reason: "matrix positive control: comp",
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    sideEffectTable: "organisation_billing_overrides",
    positiveControl: async () => {
      // Granted on org A and revoked again, so org B keeps exactly the one
      // override principal 7 is defined by.
      const { data: id, error } = await superuser.rpc("grant_billing_override", {
        p_organisation_slug: fx.orgA.slug,
        p_override_tier: "starter",
        p_override_seats: null,
        p_reason: "positive control for grant_billing_override",
        p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(
        error,
        `grant_billing_override must be reachable by the aal2 superuser: ${error?.message}`,
      ).toBeNull();
      await superuser.rpc("revoke_billing_override", {
        p_override_id: id as string,
        p_reason: "positive control cleanup",
      });
    },
  },
  {
    fn: "revoke_billing_override",
    args: () => ({
      p_override_id: ARGS.billingOverrideId,
      p_reason: "matrix positive control: revoke comp",
    }),
    sideEffectTable: null,
    positiveControl: async () => {
      // A DISPOSABLE override on org A, so the refusals below still point at a
      // real, live id (org B's) without the positive control revoking the very
      // row principal 7 is built from.
      const { data: id, error } = await superuser.rpc("grant_billing_override", {
        p_organisation_slug: fx.orgA.slug,
        p_override_tier: "starter",
        p_override_seats: null,
        p_reason: "positive control for revoke_billing_override",
        p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(error, `grant_billing_override: ${error?.message}`).toBeNull();
      const revoked = await superuser.rpc("revoke_billing_override", {
        p_override_id: id as string,
        p_reason: "positive control cleanup",
      });
      expect(
        revoked.error,
        `revoke_billing_override must be reachable by the aal2 superuser: ${revoked.error?.message}`,
      ).toBeNull();
    },
  },
  {
    fn: "grant_feature_override",
    args: () => ({
      p_organisation_slug: fx.orgB.slug,
      p_flag_key: "early_access_preview",
      p_reason: "matrix positive control: flag",
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    sideEffectTable: "organisation_feature_overrides",
    positiveControl: () => grantAndRevokeFeatureOverrideOnOrgA("grant_feature_override"),
  },
  {
    fn: "revoke_feature_override",
    args: () => ({
      p_override_id: ARGS.featureOverrideId,
      p_reason: "matrix positive control: unflag",
    }),
    sideEffectTable: null,
    positiveControl: () => grantAndRevokeFeatureOverrideOnOrgA("revoke_feature_override"),
  },
  {
    fn: "audit_feedback_screenshot_view",
    args: () => ({ p_feedback_id: ARGS.feedbackId }),
    sideEffectTable: "audit_events",
  },
  // ---- Phase 8 Task 1: the legal document store --------------------------
  {
    fn: "operator_legal_document_versions",
    args: () => ({ p_slug: null }),
    sideEffectTable: null,
  },
  {
    fn: "create_legal_document_draft",
    // The HELD slug: it already has its draft, so the superuser would get
    // 22023 here and every refused principal must get the guard's 42501 --
    // the row-state reason cannot be what refused them, because the guard
    // runs first. The positive control uses the scratch slug instead.
    args: () => ({ p_slug: LEGAL_HELD_SLUG }),
    sideEffectTable: "legal_documents",
    positiveControl: async () => {
      const { data: id, error } = await superuser.rpc("create_legal_document_draft", {
        p_slug: LEGAL_SCRATCH_SLUG,
      });
      expect(
        error,
        `create_legal_document_draft must be reachable by the aal2 superuser: ${error?.message}`,
      ).toBeNull();
      await discardLegalRows([id as string]);
    },
  },
  {
    fn: "update_legal_document_draft",
    args: () => ({
      p_document_id: ARGS.legalDraftId,
      p_title: "Accessibility Statement",
      p_body: LEGAL_DRAFT_BODY,
      p_effective_date: "2026-09-22",
    }),
    // Idempotent for the superuser (the same text), so the default replay is
    // the control -- and the invariant proves no principal changed the text.
    sideEffectTable: "audit_events",
    invariant: async () => {
      const { rows } = await pool.query(
        `select body, status from public.legal_documents where id = $1`,
        [ARGS.legalDraftId],
      );
      expect(rows[0]?.status).toBe("draft");
      expect(rows[0]?.body, "a refused principal rewrote the held draft").toBe(LEGAL_DRAFT_BODY);
    },
  },
  {
    fn: "publish_legal_document",
    args: () => ({ p_document_id: ARGS.legalDraftId }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      const { rows } = await pool.query(
        `select status from public.legal_documents where id = $1`,
        [ARGS.legalDraftId],
      );
      expect(rows[0]?.status, "a refused principal PUBLISHED the held draft").toBe("draft");
    },
    positiveControl: async () => {
      // A disposable draft on the scratch slug, published for real, then the
      // scratch document put back exactly as the seed had it.
      const { data: id, error } = await superuser.rpc("create_legal_document_draft", {
        p_slug: LEGAL_SCRATCH_SLUG,
      });
      expect(error, `create_legal_document_draft: ${error?.message}`).toBeNull();
      const published = await superuser.rpc("publish_legal_document", { p_document_id: id });
      expect(
        published.error,
        `publish_legal_document must be reachable by the aal2 superuser: ${published.error?.message}`,
      ).toBeNull();
      await discardLegalRows([id as string]);
    },
  },
  {
    fn: "transition_data_subject_request",
    args: () => ({ p_request_id: ARGS.dsrRequestId, p_status: "in_progress" }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      const { rows } = await pool.query(
        `select status from public.data_subject_requests where id = $1`,
        [ARGS.dsrRequestId],
      );
      expect(rows[0]?.status, "a refused principal moved a data subject request").toBe("open");
    },
    positiveControl: async () => {
      // A DISPOSABLE request, so the held one stays `open` for the refusals.
      const { data, error } = await fx.activeByRole.read_only.client.rpc(
        "submit_data_subject_request",
        { p_right_type: "rectification", p_subject_scope: "account", p_detail: "matrix positive control" },
      );
      const made = (data ?? []) as { request_id: string }[];
      expect(error, `submit_data_subject_request: ${error?.message}`).toBeNull();
      const moved = await superuser.rpc("transition_data_subject_request", {
        p_request_id: made[0].request_id,
        p_status: "in_progress",
      });
      expect(
        moved.error,
        `transition_data_subject_request must be reachable by the aal2 superuser: ${moved.error?.message}`,
      ).toBeNull();
    },
  },
  {
    // Phase 8 Task 3 FIX ROUND 1 (review finding I7 / Q160a): routing left
    // transition_data_subject_request() and became its own function, because
    // it must write the handover note in the same transaction.
    fn: "route_data_subject_request",
    args: () => ({
      p_request_id: ARGS.dsrProcessorRequestId,
      p_organisation_id: fx.orgA.id,
      p_handover_note: "matrix probe handover",
    }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      const { rows } = await pool.query(
        `select status, routed_at from public.data_subject_requests where id = $1`,
        [ARGS.dsrProcessorRequestId],
      );
      expect(rows[0]?.status, "a refused principal routed a data subject request").toBe("open");
      expect(rows[0]?.routed_at, "a refused principal stamped a routing").toBeNull();
    },
    positiveControl: async () => {
      // A DISPOSABLE processor-scope request, so the held one stays `open`.
      const { data, error } = await fx.activeByRole.read_only.client.rpc(
        "submit_data_subject_request",
        {
          p_right_type: "erasure",
          p_subject_scope: "workspace_records",
          p_detail: "matrix routing positive control",
        },
      );
      const made = (data ?? []) as { request_id: string }[];
      expect(error, `submit_data_subject_request: ${error?.message}`).toBeNull();
      const routed = await superuser.rpc("route_data_subject_request", {
        p_request_id: made[0].request_id,
        p_organisation_id: fx.orgA.id,
        p_handover_note: "matrix positive control handover: emailed the Owner",
      });
      expect(
        routed.error,
        `route_data_subject_request must be reachable by the aal2 superuser: ${routed.error?.message}`,
      ).toBeNull();
    },
  },
  {
    fn: "add_data_subject_request_note",
    args: () => ({ p_request_id: ARGS.dsrRequestId, p_body: "matrix probe note" }),
    sideEffectTable: "data_subject_request_notes",
    invariant: async () => {
      const { rows } = await pool.query(
        `select count(*)::int as n from public.data_subject_request_notes where request_id = $1`,
        [ARGS.dsrRequestId],
      );
      expect(rows[0]?.n, "a refused principal added an operator note").toBe(0);
    },
    positiveControl: async () => {
      const { data, error } = await fx.activeByRole.read_only.client.rpc(
        "submit_data_subject_request",
        { p_right_type: "objection", p_subject_scope: "account", p_detail: "matrix note control" },
      );
      const made = (data ?? []) as { request_id: string }[];
      expect(error, `submit_data_subject_request: ${error?.message}`).toBeNull();
      const noted = await superuser.rpc("add_data_subject_request_note", {
        p_request_id: made[0].request_id,
        p_body: "matrix positive control note",
      });
      expect(
        noted.error,
        `add_data_subject_request_note must be reachable by the aal2 superuser: ${noted.error?.message}`,
      ).toBeNull();
    },
  },
  {
    // Phase 8 Task 5. The operator running the erasure a statutory request
    // asked for -- necessary since 20260930004000, because the fulfilment
    // seam now requires a job to have RUN before such a request can be closed.
    fn: "start_erasure_for_request",
    args: () => ({ p_request_id: ARGS.dsrErasureRequestId }),
    sideEffectTable: "erasure_jobs",
    invariant: async () => {
      // THE ONE THAT MATTERS: no refused principal started an erasure of
      // ANYBODY, and the Read Only member still exists. A count of
      // erasure_jobs cannot see the second half.
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from auth.users u
          where u.id = (select d.user_id from public.data_subject_requests d where d.id = $1)`,
        [ARGS.dsrErasureRequestId],
      );
      expect(rows[0]?.n, "a refused principal erased the requester's account").toBe("1");
    },
    positiveControl: async () => {
      const { data: id, error } = await superuser.rpc("start_erasure_for_request", {
        p_request_id: ARGS.dsrErasureRequestId,
      });
      expect(
        error,
        `start_erasure_for_request must be reachable by the aal2 superuser: ${error?.message}`,
      ).toBeNull();
      // TIDIES ITS OWN ROW, for the reason request_impersonation does:
      // `erasure_jobs_one_live_account_job` is unique over a live job per
      // subject, so a queued job left behind makes the NEXT legitimate call
      // fail with 23505 -- and a refusal that fails for a fixture reason is
      // indistinguishable from the guard holding. Deleting it also means
      // nothing is ever left for a runner to pick up.
      await pool.query(`delete from public.erasure_jobs where id = $1`, [id]);
    },
  },
  {
    // Phase 8 Task 6. THE RETENTION KILL SWITCH -- the one retention RPC any
    // client role can reach at all (the other four are granted to
    // service_role alone and are probed by the relation/function censuses
    // rather than here). It is the control that stops the product enforcing
    // its own published retention policy, so a principal who is not the aal2
    // superuser reaching it would be able to switch the audit purge back on
    // -- or off -- with a reason of their choosing in the operator's own
    // audit log.
    fn: "set_retention_enabled",
    args: () => ({
      p_enabled: true,
      p_audit_purge_enabled: false,
      p_reason: "matrix probe",
    }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      // A COUNT OF audit_events CANNOT SEE THIS. The switches must still be
      // in the state the migration seeded them in: both on. A refused
      // principal that had somehow turned the audit purge off would leave no
      // row for the side-effect check to find and a product that had quietly
      // stopped deleting audit rows.
      const { rows } = await pool.query<{ enabled: boolean; audit: boolean }>(
        `select enabled, audit_purge_enabled as audit from public.retention_settings`,
      );
      expect(rows[0]?.enabled, "a refused principal stopped the retention job").toBe(true);
      expect(rows[0]?.audit, "a refused principal stopped the audit purge").toBe(true);
    },
    positiveControl: async () => {
      const { error } = await superuser.rpc("set_retention_enabled", {
        p_enabled: true,
        p_audit_purge_enabled: true,
        p_reason: "matrix positive control",
      });
      expect(
        error,
        `set_retention_enabled must be reachable by the aal2 superuser: ${error?.message}`,
      ).toBeNull();
    },
  },
  {
    // Phase 8 Task 9a (20261010000000, Q184, founder 2026-09-30). THE AUDIT
    // PURGE CEILING RELEASE: lifts rail 3 for 72 hours. A principal who is
    // not the aal2 superuser reaching it could let a refused backlog purge
    // proceed, with a reason of their choosing in the operator's audit log.
    fn: "release_audit_purge_ceiling",
    args: () => ({ p_reason: "matrix probe" }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      // AN UPDATE, NOT AN INSERT: the release lives on the one settings row,
      // so the row itself must still say "never released".
      const { rows } = await pool.query<{ at: string | null }>(
        `select audit_ceiling_released_at as at from public.retention_settings`,
      );
      expect(rows[0]?.at ?? null, "a refused principal released the audit purge ceiling").toBeNull();
    },
    positiveControl: async () => {
      const { data, error } = await superuser.rpc("release_audit_purge_ceiling", {
        p_reason: "matrix positive control",
      });
      try {
        expect(
          error,
          `release_audit_purge_ceiling must be reachable by the aal2 superuser: ${error?.message}`,
        ).toBeNull();
        expect(
          (data as { audit_ceiling_release_reason?: string } | null)?.audit_ceiling_release_reason,
        ).toBe("matrix positive control");
      } finally {
        // TIDIES ITS OWN RELEASE. A release left active would (a) make the
        // next principal's invariant above fail for a fixture reason and
        // (b) lift the ceiling under every retention test that runs after
        // this file for 72 hours.
        await pool.query(
          `update public.retention_settings
              set audit_ceiling_released_at = null, audit_ceiling_release_expires_at = null,
                  audit_ceiling_release_reason = null`,
        );
      }
    },
  },
  {
    fn: "record_legal_document_counsel_review",
    args: () => ({ p_document_id: ARGS.legalDraftId, p_reviewer: "Matrix Counsel LLP" }),
    sideEffectTable: "audit_events",
    invariant: async () => {
      const { rows } = await pool.query(
        `select counsel_reviewed_at from public.legal_documents where id = $1`,
        [ARGS.legalDraftId],
      );
      expect(rows[0]?.counsel_reviewed_at, "a refused principal recorded a counsel review").toBeNull();
    },
    positiveControl: async () => {
      const { data: id, error } = await superuser.rpc("create_legal_document_draft", {
        p_slug: LEGAL_SCRATCH_SLUG,
      });
      expect(error, `create_legal_document_draft: ${error?.message}`).toBeNull();
      const reviewed = await superuser.rpc("record_legal_document_counsel_review", {
        p_document_id: id,
        p_reviewer: "Matrix Counsel LLP",
      });
      expect(
        reviewed.error,
        `record_legal_document_counsel_review must be reachable by the aal2 superuser: ${reviewed.error?.message}`,
      ).toBeNull();
      await discardLegalRows([id as string]);
    },
  },
];

/**
 * RPCs Phase 7 added that are DELIBERATELY reachable by an ordinary member,
 * named here rather than omitted so the inventory assertion below can account
 * for every granted function and so the boundary is asserted rather than
 * skipped (the brief: "if a surface is deliberately member-reachable, the
 * expected value says so ... and the test asserts that boundary").
 */
const MEMBER_REACHABLE_RPCS: Record<string, string> = {
  close_my_workspace:
    "Phase 8 Task 9c (founder 2026-09-30, reversing Q104) -- an ACTIVE OWNER " +
    "of the workspace, at aal2, with the slug typed as confirmation and a " +
    "reason, closes their OWN workspace. Membership row checked directly (an " +
    "impersonator cannot); every other caller is refused with its own hint. " +
    "Asserted in rls_phase8_workspace_closure.sql § CG.",
  accept_impersonation_request:
    "the TARGET workspace's own Owner/Admin consents -- the whole point of " +
    "break-glass. Guarded on manage_organisation of that organisation.",
  decline_impersonation_request:
    "the mirror of accept: the target workspace's own Owner/Admin refusing " +
    "consent. Same manage_organisation gate, same organisation.",
  end_impersonation_session:
    "either side may end a live session; a customer who cannot end support " +
    "access has not consented to anything.",
  consume_rate_limit:
    "the app's own meter, called by every signed-in list read. Session-scoped " +
    "and it can only spend the CALLER's own budget.",
  feedback_budget_remaining:
    "a STABLE read of the caller's own feedback budget; spends nothing and " +
    "discloses nobody else's counter.",
  record_consent:
    "Phase 8 Task 2 -- ANY signed-in person records their OWN marketing " +
    "consent or withdrawal. Takes no user argument; the database stamps the " +
    "session's (asserted below, and in rls_phase8_consents.sql § CW).",
  submit_data_subject_request:
    "Phase 8 Task 3 -- ANY signed-in person exercises their OWN statutory " +
    "rights. Takes no user argument; the database stamps the session's, and " +
    "the 30-day deadline is a generated column no caller can name.",
  data_subject_request_note_counts:
    "Phase 8 Task 3 fix round 1 (M9) -- SECURITY INVOKER, so the notes " +
    "table's one SELECT policy (the aal2 platform superuser's) decides the " +
    "answer: any other caller gets NO ROWS rather than a refusal, for their " +
    "own request included. Asserted below and in § DN of the psql suite.",
  data_subject_request_recent_notes:
    "The sibling read of the same table, under the same SECURITY INVOKER " +
    "argument: it can return only rows the caller's own policy would have " +
    "returned. Granted to `authenticated` because the operator IS an " +
    "authenticated session; it is not an access path to anything.",
  audit_export_download:
    "Phase 8 Task 4 -- the download route calls it BEFORE it mints a signed " +
    "URL, so it has to be reachable by whoever may download. It refuses any " +
    "job that is not the caller's own (42501 not_your_export), one with no " +
    "archive, and one past its read-time expiry; on success it writes an " +
    "identifier-only audit row and nothing else. It returns no data at all.",
  my_erasure_blockers:
    "Phase 8 Task 5 -- ANY signed-in person asks what would stop them deleting " +
    "their OWN account (Q131). It takes no argument and reads " +
    "auth.uid(), so it cannot be pointed at anybody else, and it discloses " +
    "only the names of workspaces the caller is already an Owner of. A " +
    "signed-out caller gets no rows rather than an error.",
  withdraw_data_subject_request:
    "Phase 8 Task 3 -- the requester withdraws their OWN open request. The " +
    "BEFORE UPDATE trigger refuses a withdrawal by anyone but the requester, " +
    "and withdrawing must never be harder than asking.",
};

/**
 * Everything ELSE `authenticated` may EXECUTE in `public`, declared so the
 * census below can be an equality rather than a subset check.
 *
 * Each is pre-Phase-7 and outside this task's subject (Phase 2's CRM writes and
 * dedup, Phase 4's document audit, the permission reads every page makes). They
 * are not untested -- each has its own suite under `supabase/tests/` -- they are
 * simply not platform-superuser surfaces. Adding a name here is the deliberate,
 * reviewable act the census exists to force.
 */
const PRE_PHASE7_RPCS: Record<string, string> = {
  accept_invite: "Phase 1 invites -- the invitee activating their own membership",
  audit_document_action: "Phase 4 -- the document download/upload audit write",
  create_organisation: "Phase 1 -- any signed-in user may found a workspace",
  has_permission: "the permission read every gate in the product makes",
  is_platform_admin: "the identity read /super's own layout makes; discloses a boolean about the CALLER only",
  merge_records: "Phase 2 dedup -- tenant-scoped, gated on merge_records",
  screen_for_duplicates: "Phase 2 dedup detection, tenant-scoped",
  set_artist_primary_representation: "Phase 2 CRM write",
  set_contact_primary_company: "Phase 2 CRM write",
  set_custom_field_values: "Phase 2 custom fields, entitlement-gated",
};

/**
 * Everything ELSE `authenticated` holds a grant on in `public` -- tables AND
 * views, because a view is how Phase 6 exposes the network and a new one
 * granted to `authenticated` is exactly as much of a read surface as a table.
 *
 * Same contract as `PRE_PHASE7_RPCS`: this is the declared exclusion list that
 * makes the relation census an equality, so a Phase 8 table arrives as a red
 * test naming itself rather than as a silent gap.
 */
const PRE_PHASE7_RELATIONS = [
  "activity_events",
  "agencies",
  "artist_fee_history",
  "artist_representations",
  "artists",
  "audit_events",
  "companies",
  "contact_companies",
  "contacts",
  "custom_field_definitions",
  "custom_field_values",
  "document_links",
  "document_versions",
  "documents",
  "event_finance_summary",
  "event_lineup",
  "event_status_changes",
  "events",
  "financial_entries",
  "meeting_links",
  "meetings",
  "merge_candidates",
  "merges",
  "network_connected_profiles",
  "network_connection_requests",
  "network_directory",
  "network_links",
  "network_profiles",
  "note_links",
  "notes",
  "organisation_memberships",
  "organisation_subscriptions",
  "organisations",
  "permissions",
  "profiles",
  "role_permissions",
  "roles",
  "subscription_plans",
  "task_links",
  "tasks",
  "venue_rooms",
  "venues",
] as const;

/**
 * Phase 8 relations that are DELIBERATELY readable by every principal,
 * anonymous included -- asserted in their own block below, row by row, rather
 * than through the "reads nothing" contract the Phase 7 tables carry.
 * `legal_documents`: the fifteen public legal pages (Q128); the policy admits
 * the current published version only, and the grant is eight columns.
 */
const PUBLIC_READ_RELATIONS = ["legal_documents"] as const;

/**
 * Phase 8 relations a signed-in principal may read ONLY THEIR OWN rows of, and
 * write none of directly -- asserted in their own block below.
 * `consents`: the consent ledger (Task 2). SELECT to authenticated, rows
 * filtered to auth.uid() (plus the aal2 superuser's oversight read); writes go
 * through record_consent() alone.
 */
const OWN_ROW_RELATIONS = [
  "consents",
  "data_subject_requests",
  // Phase 8 Task 4: the export register. SELECT to authenticated filtered to
  // requested_by = auth.uid(); INSERT granted on TWO COLUMNS only (kind,
  // organisation_id) with everything else stamped by the trigger; no UPDATE
  // or DELETE for any client role at all. Deliberately NOT readable by a
  // second Admin of the same workspace -- an archive is a snapshot taken
  // under one person's access rights.
  "export_jobs",
  // Phase 8 Task 5: the erasure register. SELECT to authenticated, rows
  // filtered to the caller as SUBJECT or REQUESTER -- plus the aal2
  // operator's oversight read, which export_jobs deliberately does NOT have
  // (an erasure request is fulfilled from /super/data-requests and the
  // operator has to be able to see whether the job ran). INSERT granted on
  // ONE column (kind) with everything else stamped by the trigger; no UPDATE
  // or DELETE for any client role at all.
  "erasure_jobs",
] as const;

/**
 * Phase 8 relations NO principal but the aal2 platform superuser may read a
 * row of -- asserted in their own block below.
 * `data_subject_request_notes`: the operator's working notes (Q103). The
 * grant is to `authenticated` because the superuser's own PostgREST session
 * authenticates as that role; the single policy is what makes it
 * superuser-only, and the requester -- who CAN read the request the note is
 * on -- must read zero of them.
 */
const SUPERUSER_ONLY_RELATIONS = ["data_subject_request_notes"] as const;

const PHASE7_TABLES = [
  "feedback",
  "impersonation_sessions",
  "incident_alerts",
  "organisation_billing_overrides",
  "organisation_feature_overrides",
  "rate_limit_counters",
  "rate_limit_policies",
  // Phase 8 Task 6. The retention job's run log and its two kill switches:
  // platform state, readable by the aal2 superuser alone through
  // `view_platform_health`, with no INSERT/UPDATE/DELETE policy or grant for
  // any client role (public.set_retention_enabled() is the only writer of the
  // settings, and private.run_retention_sweep() of the runs).
  "retention_runs",
  "retention_settings",
] as const;

/** Every function name the matrix accounts for, in any role. */
function accountedRpcNames(): string[] {
  return [
    ...SUPERUSER_ONLY_RPCS.map((r) => r.fn),
    ...Object.keys(MEMBER_REACHABLE_RPCS),
    ...Object.keys(PRE_PHASE7_RPCS),
  ].sort();
}

/** Every relation the matrix accounts for, in any role. */
function accountedRelations(): string[] {
  return [
    ...PHASE7_TABLES,
    ...PUBLIC_READ_RELATIONS,
    ...OWN_ROW_RELATIONS,
    ...SUPERUSER_ONLY_RELATIONS,
    ...PRE_PHASE7_RELATIONS,
  ].sort();
}

/**
 * Phase 8 Task 8. Every `public` function `service_role` may EXECUTE -- the
 * sessionless runners' whole surface, keyed by SIGNATURE. None of these is
 * reachable from a browser (the API-role census proves that half); this list
 * is the other half: a new server-only entry point arrives as a red test
 * naming itself, instead of as a function nobody has asked "who calls this,
 * and what stops anybody else?" about.
 */
const SERVER_ONLY_RPCS: Record<string, string> = {
  "claim_erasure_job()": "Task 5 -- the erasure runner takes the next queued job; bearer-secret route only",
  "claim_export_job()": "Task 4 -- the export runner takes the next queued job; bearer-secret route only",
  "consent_is_granted(p_user_id uuid, p_purpose text)":
    "Task 2 -- the check a future marketing sender must make; server-side because it names a user",
  "erasure_purge_manifest(p_job_id uuid)":
    "Task 5 -- the storage keys the runner deletes BEFORE run_erasure_job may proceed",
  "export_limits_for_runner()": "Task 4 -- the declared ceilings, read by the export runner",
  "export_plan(p_job_id uuid)": "Task 4 -- which tables a job reads, taken from the catalogue",
  "export_read_page(p_job_id uuid, p_table text, p_after text, p_limit integer)":
    "Task 4 -- the read engine; reads AS THE REQUESTER through export_reader, never as a definer",
  "fail_erasure_job(p_job_id uuid, p_reason text)": "Task 5 -- records a refused erasure's reason on the job",
  "fail_retention_run(p_run_id uuid, p_reason text)": "Task 6 -- records a refused sweep's reason on the run",
  "mark_notices_delivered(p_notice text, p_subject_ids uuid[])":
    "Task 9b job 3 -- the ONLY write path of private.notification_deliveries, ONLY after Brevo accepted the connection-request / task-reminder email, and only for a subject still in that email's state; refuses any session",
  "mark_notices_undeliverable(p_notice text, p_subject_ids uuid[], p_reason text)":
    "Task 9b fix round 1 (I2) -- the second write path of private.notification_deliveries: records a DETERMINISTIC refusal once, so one workspace's unrenderable rows leave the queue; same state rule as mark_notices_delivered; refuses any session",
  "mark_erasure_failures_notified(p_job_ids uuid[])":
    "Task 9b job 2 -- stamps erasure_jobs.failure_notified_at ONLY after the superuser's email was accepted (the table's CHECK makes a column grant unusable)",
  "pending_connection_request_notifications(p_limit integer)":
    "Task 9b job 3 -- the connection-request notice queue; addresses through ACTIVE memberships only, content is the counterparty's published display name and a slug",
  "pending_dsr_notifications(p_limit integer)":
    "Task 9b job 2 -- the DSR received/closed notice queue; the address is auth.users through user_id, the tombstone excluded",
  "pending_export_ready_notifications(p_limit integer)":
    "Task 9b job 2 -- the export-ready notice queue; returns no archive key and no URL",
  "pending_lockout_notifications(p_limit integer)":
    "Phase 7 Task 6c -- the account-holder lockout notice queue, read by the sender",
  "pending_workspace_closure_notifications(p_limit integer)":
    "Task 9c job 2 -- the superuser's closure email queue: slug, name and closed-at of an owner_closed workspace, nothing from inside it; addressed by the sender to SUPPORT_CONTACT_EMAIL",
  "pending_workspace_decision_notifications(p_limit integer)":
    "Task 9c job 2 -- the reassign/delete notice queue: the Owners/Admins snapshotted on the decision's audit row, the tombstone excluded; slug and name from that row, never the reason",
  "pending_task_reminder_notifications(p_limit integer)":
    "Task 9b job 3 -- the task-reminder queue: a live, open, due task's CURRENT active assignee, its title and due date, never its detail",
  "retention_object_manifest(p_run_id uuid, p_limit integer)":
    "Task 6 -- names objects only for a run that would not refuse (fix round 1, C2)",
  "run_erasure_job(p_job_id uuid)":
    "Task 5 -- THE erasure entry point, and the only caller of private.erase_account",
  "run_retention_sweep(p_run_id uuid, p_limit integer)":
    "Task 6 -- THE sweep entry point, and the only caller of the audit purge",
  "start_retention_run(p_dry boolean)": "Task 6 -- every refusal is asked here, before a run exists",
};

/** Phase 8 Task 8. The three private buckets. */
const DECLARED_BUCKETS = [
  "documents|public=false",
  "exports|public=false",
  "feedback-screenshots|public=false",
];

/** Phase 8 Task 8. The product's ONE clock, and the five halves it drives. */
const DECLARED_CRON = [
  "incident-alert-delivery|*/10 * * * *|select private.run_incident_alert_tick()",
];
const DECLARED_TICK_CALLEES = [
  "deliver_erasure_jobs",
  "deliver_export_jobs",
  "deliver_incident_alerts",
  "deliver_retention_sweep",
  "raise_dsr_deadline_alerts",
];

/**
 * Runs `plant` inside a transaction on one pooled connection, hands the SAME
 * connection to `measure`, and rolls everything back -- so a plant can never
 * leak into the rest of the run, and the census sees exactly what the plant
 * made.
 */
async function withPlant<T>(
  plant: (c: Queryable) => Promise<void>,
  measure: (c: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await plant(client);
    return await measure(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

// =============================================================================
// SETUP -- AND IT DOUBLES AS THE POSITIVE CONTROL FOR HALF THE RPC INVENTORY
// =============================================================================
// Every row the matrix addresses is created HERE, by the aal2 superuser,
// through the real RPC, with the same argument builder the refusals use. So
// `request_impersonation`, `accept_impersonation_request`,
// `start_impersonation_session`, `grant_billing_override` and
// `grant_feature_override` are all proved WORKING before a single refusal is
// asserted: if any of them were broken, misnamed or given bad arguments, this
// hook throws and the whole file goes red rather than 91 refusals going quietly
// green.
beforeAll(async () => {
  fx = await createFixtures();
  pool = fx._pool;
  superuser = fx.superuser.client;

  // ---- Principal 2: authenticated, no organisation ------------------------
  const noOrgEmail = `matrix-noorg-${fx.runId}@test.local`;
  const { data: created, error: createErr } =
    await fx.adminAuth.auth.admin.createUser({
      email: noOrgEmail,
      password: "Test-Passw0rd!-rls-js",
      email_confirm: true,
    });
  if (createErr || !created.user) {
    throw new Error(`could not create the no-organisation principal: ${createErr?.message}`);
  }
  fx._allUserIds.push(created.user.id);
  noOrgUserId = created.user.id;
  noOrgClient = createClient(fx.apiUrl, fx.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  {
    const { error } = await noOrgClient.auth.signInWithPassword({
      email: noOrgEmail,
      password: "Test-Passw0rd!-rls-js",
    });
    if (error) throw new Error(`no-organisation principal sign-in: ${error.message}`);
  }

  // ---- Principal 6: the superuser at aal1 ---------------------------------
  // A SECOND session for the SAME account, deliberately not elevated. Same
  // user id, same platform_admins row, one factor short -- which is the only
  // difference this principal is meant to isolate. (createFixtures() elevates
  // fx.superuser.client; this client is a fresh sign-in beside it.)
  superuserAal1Client = createClient(fx.apiUrl, fx.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  {
    const { error } = await superuserAal1Client.auth.signInWithPassword({
      email: fx.superuser.email,
      password: "Test-Passw0rd!-rls-js",
    });
    if (error) throw new Error(`aal1 superuser sign-in: ${error.message}`);
    const { data: aal } =
      await superuserAal1Client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal1") {
      throw new Error(
        `the aal1 superuser principal is ${aal?.currentLevel} -- it must be aal1 ` +
          `or every refusal it collects proves nothing about the aal2 gate`,
      );
    }
  }

  // ---- Phase 8 Task 8: the Owner of a SUSPENDED workspace, at aal2 -------
  // Built through the real paths end to end: a real account, a real TOTP
  // factor, a workspace founded through create_organisation(), and a
  // suspension through the operator's own audited RPC. The DENOMINATOR is
  // asserted before anything relies on it: the workspace really is suspended,
  // this person really is its active Owner, and the session really is aal2 --
  // otherwise every "refused" below could be the MFA gate or a missing
  // membership wearing the suspension's clothes.
  {
    const email = `matrix-suspended-${fx.runId}@test.local`;
    const { data: made, error } = await fx.adminAuth.auth.admin.createUser({
      email,
      password: "Test-Passw0rd!-rls-js",
      email_confirm: true,
    });
    if (error || !made.user) throw new Error(`suspended principal: ${error?.message}`);
    fx._allUserIds.push(made.user.id);
    suspendedUserId = made.user.id;
    suspendedClient = createClient(fx.apiUrl, fx.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await suspendedClient.auth.signInWithPassword({
      email,
      password: "Test-Passw0rd!-rls-js",
    });
    if (signedIn.error) throw new Error(`suspended principal sign-in: ${signedIn.error.message}`);
    await elevateToAal2(suspendedClient, "suspendedMember");
    suspendedOrg.slug = `rls-js-s-${fx.runId}`;
    const { data: orgId, error: orgErr } = await suspendedClient.rpc("create_organisation", {
      p_name: `RLS JS Suspended Org ${fx.runId}`,
      p_slug: suspendedOrg.slug,
    });
    if (orgErr || !orgId) throw new Error(`suspended principal's workspace: ${orgErr?.message}`);
    suspendedOrg.id = orgId as string;
    fx._allOrgIds.push(suspendedOrg.id);
    const suspended = await superuser.rpc("suspend_organisation", {
      p_organisation_slug: suspendedOrg.slug,
      p_reason: "permission matrix: the suspended-workspace principal",
    });
    if (suspended.error) {
      throw new Error(`POSITIVE CONTROL FAILED: suspend_organisation: ${suspended.error.message}`);
    }
    const { rows } = await pool.query<{ state: string; role: string; status: string }>(
      `select o.lifecycle_state as state, m.role as role, m.status
         from public.organisations o
         join public.organisation_memberships m on m.organisation_id = o.id
        where o.id = $1 and m.user_id = $2`,
      [suspendedOrg.id, suspendedUserId],
    );
    if (rows.length !== 1 || rows[0].state !== "suspended" || rows[0].role !== "owner" || rows[0].status !== "active") {
      throw new Error(
        `DENOMINATOR: the suspended principal is not the active Owner of a suspended ` +
          `workspace (${JSON.stringify(rows)}), so nothing it is refused says anything about suspension`,
      );
    }
  }

  // ---- Principal 5: a LIVE impersonation session on org A -----------------
  // Positive controls for request_impersonation (superuser),
  // accept_impersonation_request (the org's own Owner) and
  // start_impersonation_session (superuser), in that order and all real.
  {
    const { data: sessionId, error } = await superuser.rpc("request_impersonation", {
      p_organisation_slug: fx.orgA.slug,
      p_reason: "permission matrix: a live session on org A",
    });
    if (error || !sessionId) {
      throw new Error(`POSITIVE CONTROL FAILED: request_impersonation: ${error?.message}`);
    }
    ARGS.impersonationSessionId = sessionId as string;
    const accepted = await fx.ownerA.client.rpc("accept_impersonation_request", {
      p_session_id: ARGS.impersonationSessionId,
    });
    if (accepted.error) {
      throw new Error(`POSITIVE CONTROL FAILED: accept_impersonation_request: ${accepted.error.message}`);
    }
    const started = await superuser.rpc("start_impersonation_session", {
      p_session_id: ARGS.impersonationSessionId,
    });
    if (started.error) {
      throw new Error(`POSITIVE CONTROL FAILED: start_impersonation_session: ${started.error.message}`);
    }
    const { rows } = await pool.query(
      `select status, started_at, expires_at from public.impersonation_sessions where id = $1`,
      [ARGS.impersonationSessionId],
    );
    if (rows.length !== 1 || !rows[0].started_at || new Date(rows[0].expires_at) <= new Date()) {
      throw new Error(
        "the impersonation session is not live, so principal 5 is an ordinary " +
          "Owner and its rows would prove nothing about session inheritance",
      );
    }
  }

  // ---- M1: a session held in `accepted`, on its OWN organisation ----------
  // The target of start_impersonation_session's seven refusals, and the reason
  // it needs a third workspace: org A's live-pair slot is taken by the session
  // above and org B's is borrowed and released by three positive controls, so
  // a row that must stay `accepted` for the whole run can live in neither
  // (`impersonation_sessions_live_pair` is unique over superuser+organisation
  // for requested/accepted/active).
  //
  // ownerA creates it deliberately: they are already the workspace-side
  // principal that impersonation_sessions is documented as readable by, so the
  // extra row changes no table-layer expectation. Creating it as ownerB would
  // have handed `overriddenOrgOwner` -- a principal asserted to read NOTHING
  // from that table -- a row it could legitimately see, turning an assertion
  // into its opposite.
  {
    const orgCSlug = `rls-js-c-${fx.runId}`;
    const { data: orgCId, error: orgCErr } = await fx.ownerA.client.rpc(
      "create_organisation",
      { p_name: `RLS JS Test Org C ${fx.runId}`, p_slug: orgCSlug },
    );
    if (orgCErr || !orgCId) {
      throw new Error(`could not create the accepted-session workspace: ${orgCErr?.message}`);
    }
    // destroyFixtures() deletes by this array, so the third workspace is torn
    // down with the other two rather than left behind for the next suite.
    fx._allOrgIds.push(orgCId as string);

    const { data: sessionId, error } = await superuser.rpc("request_impersonation", {
      p_organisation_slug: orgCSlug,
      p_reason: "permission matrix: a session that stays ACCEPTED, never started",
    });
    if (error || !sessionId) {
      throw new Error(`POSITIVE CONTROL FAILED: request_impersonation (org C): ${error?.message}`);
    }
    ARGS.acceptedImpersonationSessionId = sessionId as string;
    const accepted = await fx.ownerA.client.rpc("accept_impersonation_request", {
      p_session_id: ARGS.acceptedImpersonationSessionId,
    });
    if (accepted.error) {
      throw new Error(
        `POSITIVE CONTROL FAILED: accept_impersonation_request (org C): ${accepted.error.message}`,
      );
    }
    // THE DENOMINATOR FOR M1. If this row is not `accepted` with a null
    // started_at, start_impersonation_session's refusals are back to being
    // delivered by row state wearing the guard's own 42501.
    const { rows } = await pool.query(
      `select status, started_at from public.impersonation_sessions where id = $1`,
      [ARGS.acceptedImpersonationSessionId],
    );
    if (rows.length !== 1 || rows[0].status !== "accepted" || rows[0].started_at !== null) {
      throw new Error(
        "the disposable session is not in `accepted` with a null started_at, so " +
          "start_impersonation_session's refusals would be refusals of row state " +
          "and not of the guard (M1)",
      );
    }
  }

  // ---- Principal 7: an active Pro billing override on org B (Starter) -----
  {
    const { data: id, error } = await superuser.rpc("grant_billing_override", {
      p_organisation_slug: fx.orgB.slug,
      p_override_tier: "pro",
      p_override_seats: null,
      p_reason: "permission matrix: entitlement must not leak into platform policy",
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (error || !id) {
      throw new Error(`POSITIVE CONTROL FAILED: grant_billing_override: ${error?.message}`);
    }
    ARGS.billingOverrideId = id as string;
  }
  {
    const { data: id, error } = await superuser.rpc("grant_feature_override", {
      p_organisation_slug: fx.orgB.slug,
      p_flag_key: "early_access_preview",
      p_reason: "permission matrix: the feature-override table needs a row to read",
      p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (error || !id) {
      throw new Error(`POSITIVE CONTROL FAILED: grant_feature_override: ${error?.message}`);
    }
    ARGS.featureOverrideId = id as string;
  }

  // ---- Rows for the two platform tables with no client write path ---------
  // `feedback` gets a row with a CLEAN screenshot so
  // audit_feedback_screenshot_view() has something viewable to be refused
  // over; `incident_alerts` gets one so its SELECT refusals have a denominator.
  // Planted as `postgres`, the route every other planted platform row in this
  // repo uses -- both columns sit outside every client grant by design.
  ARGS.feedbackId = randomUUID();
  await pool.query(
    `insert into public.feedback
       (id, user_id, user_email, organisation_id, organisation_role, category,
        message, route, screenshot_key, screenshot_mime, screenshot_size_bytes,
        screenshot_scan_status, screenshot_scanned_at)
     values ($1,$2,$3,$4,'owner','bug','permission matrix fixture',
             '/matrix', $5, 'image/png', 1024, 'clean', now())`,
    [
      ARGS.feedbackId,
      fx.ownerA.userId,
      fx.ownerA.email,
      fx.orgA.id,
      `feedback/${ARGS.feedbackId}`,
    ],
  );
  ARGS.incidentAlertId = randomUUID();
  await pool.query(
    `insert into public.incident_alerts (id, alert_type, organisation_id, summary, details)
     values ($1,'rate_limit_tripped',$2,'permission matrix fixture','{}'::jsonb)`,
    [ARGS.incidentAlertId, fx.orgA.id],
  );

  // ---- Phase 8 Task 1: a legal-document draft held open for the run -------
  // Created through the real RPC by the aal2 superuser, so it is also a
  // positive control for create_legal_document_draft and
  // update_legal_document_draft before any refusal is asserted.
  {
    const { data: id, error } = await superuser.rpc("create_legal_document_draft", {
      p_slug: LEGAL_HELD_SLUG,
    });
    if (error || !id) {
      throw new Error(`POSITIVE CONTROL FAILED: create_legal_document_draft: ${error?.message}`);
    }
    ARGS.legalDraftId = id as string;
    const saved = await superuser.rpc("update_legal_document_draft", {
      p_document_id: ARGS.legalDraftId,
      p_title: "Accessibility Statement",
      p_body: LEGAL_DRAFT_BODY,
      p_effective_date: "2026-09-22",
    });
    if (saved.error) {
      throw new Error(`POSITIVE CONTROL FAILED: update_legal_document_draft: ${saved.error.message}`);
    }
  }

  // ---- Phase 8 Task 2: a consent grant held for the run -----------------
  // Recorded by the Read Only member through the real RPC -- the positive
  // control for record_consent before any refusal is asserted.
  {
    const { rows } = await pool.query<{ version: number }>(
      `select version from public.legal_documents where slug = 'marketing-preferences' and status = 'published'`,
    );
    const { data, error } = await fx.activeByRole.read_only.client.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: rows[0].version,
      p_statement: "marketing-email-1",
    });
    const recorded = (data ?? []) as { consent_id: string }[];
    if (error || recorded.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: record_consent: ${error?.message}`);
    }
    ARGS.consentId = recorded[0].consent_id;
  }

  // ---- Phase 8 Task 3: a data subject request held open for the run -----
  // Made by the Read Only member through the real RPC -- the positive control
  // for submit_data_subject_request before any refusal is asserted.
  {
    const { data, error } = await fx.activeByRole.read_only.client.rpc(
      "submit_data_subject_request",
      {
        p_right_type: "access",
        p_subject_scope: "account",
        p_detail: "matrix fixture: please send me a copy of my data",
      },
    );
    const made = (data ?? []) as { request_id: string }[];
    if (error || made.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: submit_data_subject_request: ${error?.message}`);
    }
    ARGS.dsrRequestId = made[0].request_id;
  }

  // ...and a PROCESSOR-scope one, the subject of the routing refusals.
  {
    const { data, error } = await fx.activeByRole.read_only.client.rpc(
      "submit_data_subject_request",
      {
        p_right_type: "erasure",
        p_subject_scope: "workspace_records",
        p_detail: "matrix fixture: a promoter has me saved as a contact",
      },
    );
    const made = (data ?? []) as { request_id: string }[];
    if (error || made.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: submit_data_subject_request (processor): ${error?.message}`);
    }
    ARGS.dsrProcessorRequestId = made[0].request_id;
  }

  // ---- Phase 8 Task 4: an export job held for the run -------------------
  // Started by the Read Only member through the real INSERT path -- the
  // positive control for the register's own attribution before any refusal is
  // asserted. It is left QUEUED: nothing in this file runs the runner, so the
  // job never acquires an archive, which is exactly what makes the download
  // RPC's refusals below distinguishable from "there is no archive".
  {
    const { data, error } = await fx.activeByRole.read_only.client
      .from("export_jobs")
      .insert({ kind: "account" } as never)
      .select("id");
    const made = (data ?? []) as { id: string }[];
    if (error || made.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: export_jobs insert: ${error?.message}`);
    }
    ARGS.exportJobId = made[0].id;
  }

  // ---- Phase 8 Task 5: an ACCOUNT-scope erasure request held OPEN --------
  // The row every refused `start_erasure_for_request` call is aimed at, so a
  // refusal is the operator gate's and not "no such request" or "that request
  // is closed". Nothing here runs the erasure runner, and the positive
  // control deletes the queued job it creates, so the Read Only member's
  // account survives this file intact -- asserted, not assumed, in the
  // surface's own `invariant`.
  {
    const { data, error } = await fx.activeByRole.read_only.client.rpc(
      "submit_data_subject_request",
      {
        p_right_type: "erasure",
        p_subject_scope: "account",
        p_detail: "matrix fixture: please delete my account",
      },
    );
    const made = (data ?? []) as { request_id: string }[];
    if (error || made.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: submit_data_subject_request (erasure): ${error?.message}`);
    }
    ARGS.dsrErasureRequestId = made[0].request_id;
  }

  // ---- Phase 8 Task 8: an account erasure the no-workspace principal queued
  // for themself, through the real one-column INSERT -- the row the new
  // erasure_jobs block reads. Nothing in this file runs a runner.
  {
    const { data, error } = await noOrgClient
      .from("erasure_jobs")
      .insert({ kind: "account" } as never)
      .select("id");
    const made = (data ?? []) as { id: string }[];
    if (error || made.length !== 1) {
      throw new Error(`POSITIVE CONTROL FAILED: erasure_jobs insert: ${error?.message}`);
    }
    ARGS.erasureJobId = made[0].id;
  }

  // `rate_limit_counters` needs a row too, and the honest way to get one is to
  // spend a real budget through the real meter as a real member.
  {
    const { error } = await fx.activeByRole.manager.client.rpc("consume_rate_limit", {
      p_category: "search",
    });
    if (error) {
      throw new Error(`POSITIVE CONTROL FAILED: consume_rate_limit as a member: ${error.message}`);
    }
  }
  // Phase 8 Task 6: public.retention_runs needs a row, or "nobody but the
  // superuser can read it" measures nothing -- the positive control above
  // says exactly that and said it on this table's first run here. The honest
  // way to get one is a REAL DRY RUN through the real RPCs, as the
  // sessionless server role they are granted to: it deletes nothing (that is
  // what `dry` means) and it proves the two RPCs work at the same time.
  {
    const { rows } = await pool.query<{ id: string }>(
      `select (public.start_retention_run(true)).id as id`,
    );
    ARGS.retentionRunId = rows[0].id;
    await pool.query(`select public.run_retention_sweep($1, 500)`, [ARGS.retentionRunId]);
  }
}, 180_000);

afterAll(async () => {
  if (!fx) return;
  if (ARGS.retentionRunId) {
    await pool.query(`delete from public.audit_events where action = 'retention.swept'`);
    await pool.query(`delete from public.retention_runs`);
  }
  await pool.query(`delete from public.incident_alerts where id = $1`, [
    ARGS.incidentAlertId,
  ]);
  // Phase 8 Task 8: the held erasure job and anything the new principals made.
  await pool.query(`delete from public.erasure_jobs where subject_user_id = any($1::uuid[])`, [fx._allUserIds]);
  await pool.query(`delete from public.export_jobs where requested_by = any($1::uuid[])`, [fx._allUserIds]);
  await pool.query(
    `delete from public.audit_events where target_type = 'feedback' and target_id = $1`,
    [ARGS.feedbackId],
  );
  await pool.query(`delete from public.feedback where id = $1`, [ARGS.feedbackId]);
  if (ARGS.legalDraftId) await discardLegalRows([ARGS.legalDraftId]);
  // Phase 8 Task 3: the register and its notes refuse every delete from every
  // role (private.data_subject_requests_delete_guard), so the fixtures are
  // removed the one way the schema permits -- with the triggers out of the
  // way, as the owner, exactly as the psql suite's own housekeeping does.
  await pool.query(`set session_replication_role = replica`);
  await pool.query(`delete from public.audit_events where target_type = 'data_subject_request'`);
  await pool.query(
    `delete from public.data_subject_request_notes where request_id in
       (select id from public.data_subject_requests where user_id = any($1::uuid[]))`,
    [fx._allUserIds],
  );
  await pool.query(`delete from public.data_subject_requests where user_id = any($1::uuid[])`, [
    fx._allUserIds,
  ]);
  await pool.query(`set session_replication_role = default`);
  await pool.query(
    `delete from public.rate_limit_counters where subject_id = any($1::uuid[])`,
    [[fx.orgA.id, fx.orgB.id, ...fx._allUserIds]],
  );
  await pool.query(
    // _allOrgIds, not [orgA, orgB]: M1's accepted session lives on the third
    // workspace beforeAll creates and pushes onto that array.
    `delete from public.impersonation_sessions where target_organisation_id = any($1::uuid[])`,
    [fx._allOrgIds],
  );
  await destroyFixtures(fx);
});

// =============================================================================
// GATE 0: THE INVENTORY IS COMPLETE
// =============================================================================
describe("the inventory is mechanical", () => {
  it("every function `authenticated` can execute in `public` is accounted for", async () => {
    // A CENSUS, since fix round 1. This query carries NO `proname = any(...)`
    // filter -- the filter is what made the first cut able only to confirm
    // names already on the list, while the header claimed a Phase 8 grant
    // would land as a red test naming itself (review finding M2). Now it does:
    // a new granted function appears in `granted` and in none of the three
    // lists, and this assertion names it.
    // AND THE GRANTEE PREDICATE COUNTS `PUBLIC` (census audit, finding 2).
    // `aclexplode` yields `grantee = 0` for the pseudo-role PUBLIC, and
    // `pg_get_userbyid(0)` is neither 'authenticated' nor 'anon' -- so an
    // explicit `grant execute ... to public` was absent from this census
    // entirely while PostgREST exposed the function to an anonymous browser.
    // The sibling test below covers the OTHER, commoner shape, which no ACL
    // query can see at all.
    // Phase 8 Task 8: the query is catalogue-census.ts's publicRpcNames(),
    // unchanged in meaning, so the denominator block below can run the SAME
    // census on a connection that has just planted something.
    const granted = await publicRpcNames(pool);
    const accounted = accountedRpcNames();
    expect(
      granted,
      "a function `authenticated` or `anon` may EXECUTE in `public` is on neither this " +
        "file's Phase 7 lists nor PRE_PHASE7_RPCS. Either probe it as a " +
        "principal-by-principal surface above, or add it to PRE_PHASE7_RPCS " +
        "with the reason it is out of scope -- the equality is the whole point: " +
        "a grant that nothing probes must not be able to arrive silently.",
    ).toEqual(accounted);
    // Both halves of the old test survive inside the equality: every name this
    // file probes must also still EXIST and still be granted, or the refusals
    // below are refusals of a function that is not there.
    for (const fn of SUPERUSER_ONLY_RPCS.map((r) => r.fn)) {
      expect(granted, `${fn} is probed by this file and is not granted`).toContain(fn);
    }
  });

  it("no function in `public` has NO ACL AT ALL -- the shape the census above cannot see", async () => {
    // CENSUS AUDIT, FINDING 2, and the half that matters. A function created
    // in `public` WITHOUT the house
    //
    //   revoke all on function ... from public, anon, authenticated, service_role;
    //
    // has `proacl IS NULL`. Postgres's default for a function is EXECUTE to
    // the pseudo-role PUBLIC, which INCLUDES `anon` -- so it is callable
    // through PostgREST by an unauthenticated browser. `aclexplode(NULL)`
    // returns NO ROWS, so such a function is absent from the census above
    // entirely: it is matched against nothing and named by nothing. This
    // assertion is the only thing in the repository between a forgotten
    // `revoke` and an unauthenticated RPC, and a forgotten `revoke` is the
    // commonest way that exact failure ships.
    //
    // Measured clean at 163 migrations (0 with a PUBLIC grant, 0 with a null
    // ACL) -- clean purely because every migration happens to carry the
    // revoke, a convention that until now was enforced by nothing.
    const { rows } = await pool.query<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind in ('f','p') and p.proacl is null
        order by p.proname`,
    );
    expect(
      rows.map((r) => r.proname),
      "this function was created in `public` with no explicit ACL, so it carries Postgres's " +
        "default of EXECUTE to PUBLIC -- which includes `anon`, and PostgREST will call it for " +
        "an unauthenticated browser. Add the house " +
        "`revoke all on function ... from public, anon, authenticated, service_role;` and then " +
        "grant it to exactly the roles that need it. NOTE that no ACL-based census can see this " +
        "function: aclexplode(NULL) returns no rows, so it is invisible to the equality above.",
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: a function created without the house revoke is caught", async () => {
    // Both halves of the finding, planted and rolled back. Without this the
    // two assertions above are a pair of empty results, which is exactly the
    // shape this whole audit is about.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`create function public.zzz_planted_no_revoke() returns int language sql as $$ select 1 $$`);
      const nullAcl = await client.query<{ proname: string }>(
        `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proacl is null and p.proname = 'zzz_planted_no_revoke'`,
      );
      expect(nullAcl.rows.map((r) => r.proname)).toEqual(["zzz_planted_no_revoke"]);

      // ...and it is INVISIBLE to the ACL census, which is the point.
      const aclCensus = await client.query<{ proname: string }>(
        `select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) ax
          where n.nspname = 'public' and ax.privilege_type = 'EXECUTE'
            and p.proname = 'zzz_planted_no_revoke'`,
      );
      expect(aclCensus.rows, "aclexplode(NULL) returns no rows -- that IS the hole").toEqual([]);

      // The other shape: an EXPLICIT grant to PUBLIC, which the widened
      // grantee predicate now catches and the old one did not.
      await client.query(`revoke all on function public.zzz_planted_no_revoke() from public`);
      await client.query(`grant execute on function public.zzz_planted_no_revoke() to public`);
      const widened = await client.query<{ proname: string; old_predicate: boolean }>(
        `select distinct p.proname,
                bool_or(pg_get_userbyid(ax.grantee) in ('authenticated','anon')) as old_predicate
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) ax
          where n.nspname = 'public' and ax.privilege_type = 'EXECUTE'
            and (ax.grantee = 0 or pg_get_userbyid(ax.grantee) in ('authenticated','anon'))
            and p.proname = 'zzz_planted_no_revoke'
          group by p.proname`,
      );
      expect(widened.rows.map((r) => r.proname)).toEqual(["zzz_planted_no_revoke"]);
      expect(widened.rows[0]!.old_predicate, "the OLD grantee predicate is supposed to miss this").toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("every relation `authenticated` holds a grant on in `public` is accounted for", async () => {
    // The same census, at the read layer, and the half that was weakest:
    // `PHASE7_TABLES` was a hardcoded literal with nothing derived from
    // `pg_class` at all, so a Phase 8 table granted to `authenticated` was
    // invisible to this file entirely. Views are included deliberately --
    // `network_directory` is how Phase 6 exposes the network, so a view is
    // exactly as much of a read surface as a table.
    // COLUMN-LEVEL GRANTS COUNT TOO (Phase 8 Task 1). The first cut read
    // `pg_class.relacl` alone, and a relation whose only grant to
    // `authenticated` is column-level has NO entry there -- `legal_documents`
    // (eight granted columns, nothing table-level) was invisible to this
    // census while being readable by every session. Measured: registering it
    // in PUBLIC_READ_RELATIONS turned this equality RED, because the query
    // could not see the table the list now named. `pg_attribute.attacl` is
    // where a column grant lives.
    const rows = await publicRelationsGranted(pool);
    const granted = rows.map((r) => r.relname).sort();
    expect(
      granted,
      "a relation `authenticated` or `anon` holds a grant on in `public` is on neither " +
        "PHASE7_TABLES nor PRE_PHASE7_RELATIONS. A platform table added by a " +
        "later phase belongs in the first (and gets probed by every principal); " +
        "a tenant one belongs in the second with its reason.",
    ).toEqual(accountedRelations());

    // And the seven this file probes are real TABLES with RLS on -- a view has
    // no RLS of its own, so the two facts have to be asserted together.
    const phase7 = rows.filter((r) => (PHASE7_TABLES as readonly string[]).includes(r.relname));
    expect(phase7.map((r) => r.relname).sort()).toEqual([...PHASE7_TABLES].sort());
    expect(
      phase7.filter((r) => r.relkind !== "r" || !r.relrowsecurity),
      "a Phase 7 surface this file probes is not an RLS-enabled table",
    ).toEqual([]);
  });
});

// =============================================================================
// GATE 0, PHASE 8 TASK 8: EVERY CENSUS REACHES PHASE 8, AND EACH SEES ITS PLANT
// =============================================================================
// The equality tests above prove the lists match the catalogue TODAY. They
// cannot prove the census would notice TOMORROW's surface: a census whose
// query cannot see a shape passes perfectly over a catalogue that has none.
// So every census below is run twice -- once against the live catalogue, once
// on a connection that has just planted one unregistered thing -- and the
// planted run must name the plant and nothing else. Where an OLDER census
// could not see a plant, that is asserted too, as the hole it was.
describe("GATE 0 (Phase 8): the censuses reach every Phase 8 surface", () => {
  it("the exposed schemas are read from config.toml, and they are public + graphql_public", () => {
    expect(exposedSchemas()).toEqual(["graphql_public", "public"]);
  });

  it("no exposed function carries a second overload -- the shape the NAME census cannot see", async () => {
    expect(await exposedOverloads(pool, exposedSchemas())).toEqual([]);
  });

  it("no function in ANY exposed schema has a NULL ACL", async () => {
    expect(await exposedNullAclFunctions(pool, exposedSchemas())).toEqual([]);
  });

  it("every exposed signature is a public name the matrix accounts for, or graphql_public.graphql", async () => {
    const sigs = await exposedRpcSignatures(pool, exposedSchemas());
    const accounted = new Set(accountedRpcNames().map((n) => `public.${n}`));
    const stray = sigs.filter((s) => {
      const name = s.slice(0, s.indexOf("("));
      return !accounted.has(name) && name !== "graphql_public.graphql";
    });
    expect(stray, "an exposed function the matrix does not account for").toEqual([]);
    // DENOMINATOR: the graphql_public entry is real, so deriving the exposed
    // schemas reaches something the old public-only query did not.
    expect(sigs.filter((s) => s.startsWith("graphql_public."))).toHaveLength(1);
  });

  it("EVERY privilege on `public` -- table and column level, API roles and service_role -- is declared", async () => {
    const d = difference(await publicPrivileges(pool), DECLARED_PRIVILEGES);
    expect(d, "a privilege was added or removed; see support/privilege-census.ts").toEqual({
      unaccounted: [],
      missing: [],
    });
  });

  it("every service_role RPC is declared, with its reason", async () => {
    expect(await serviceRoleRpcSignatures(pool)).toEqual(Object.keys(SERVER_ONLY_RPCS).sort());
    for (const [sig, why] of Object.entries(SERVER_ONLY_RPCS)) {
      expect(why.length, sig).toBeGreaterThan(30);
    }
  });

  it("the destructive primitives are executable by postgres ALONE", async () => {
    const acl = await destructivePrimitiveAcl(pool);
    // REACH: the census must contain the erasure primitive and the retention
    // job's bodies, or "every entry is postgres-only" is about nothing.
    const names = acl.map((e) => e.split("|")[0]);
    for (const must of ["erase_account", "erase_organisation", "purge_audit_events", "retention_sweep_body"]) {
      expect(names, `REACH: ${must}`).toContain(must);
    }
    expect(names.filter((n) => n.startsWith("sweep_")).length).toBeGreaterThanOrEqual(7);
    expect(acl.filter((e) => !e.endsWith("|postgres"))).toEqual([]);
  });

  it("storage: exactly the three buckets, all private, deny-all, each fenced four ways", async () => {
    expect(await storageBuckets(pool)).toEqual(DECLARED_BUCKETS);
    expect(await storagePermissivePolicies(pool)).toEqual([]);
    const fences = await storageFences(pool);
    for (const b of DECLARED_BUCKETS.map((x) => x.split("|")[0])) {
      expect(fences.filter((f) => f.startsWith(`${b}|`)).sort(), b).toEqual(
        ["DELETE", "INSERT", "SELECT", "UPDATE"].map((c) => `${b}|${c}`),
      );
    }
  });

  it("cron: exactly one job, and it drives exactly the five declared halves", async () => {
    expect(await cronJobs(pool)).toEqual(DECLARED_CRON);
    expect(await tickCallees(pool)).toEqual(DECLARED_TICK_CALLEES);
  });

  it("REACH: the relation and privilege censuses contain every Phase 8 table", async () => {
    const rels = (await publicRelationsGranted(pool)).map((r) => r.relname);
    const privs = await publicPrivileges(pool);
    for (const t of [
      "legal_documents",
      "consents",
      "data_subject_requests",
      "data_subject_request_notes",
      "export_jobs",
      "erasure_jobs",
      "retention_runs",
      "retention_settings",
    ]) {
      expect(rels, `REACH: ${t}`).toContain(t);
      expect(privs.some((p) => p.startsWith(`${t}|`)), `REACH (privileges): ${t}`).toBe(true);
    }
    // The column-level Phase 8 controls are IN the privilege census by column.
    expect(privs).toContain("legal_documents|anon|SELECT|body");
    expect(privs).toContain("erasure_jobs|authenticated|INSERT|kind");
    expect(privs).toContain("data_subject_requests|service_role|UPDATE|fulfilment_kind");
  });

  it("REACH: the Phase 3-6 audit triggers are in the coverage census, and only the declared excusal is uncovered", async () => {
    const { rows } = await pool.query<{ table_name: string; uncovered_ops: string[]; coverage: string }>(
      `select table_name, uncovered_ops, coverage from private.audit_coverage() order by 1`,
    );
    const generic = rows.filter((r) => r.coverage === "generic").map((r) => r.table_name);
    for (const t of [
      "events",
      "event_lineup",
      "tasks",
      "notes",
      "documents",
      "financial_entries",
      "network_profiles",
      "organisation_memberships",
    ]) {
      expect(generic, `REACH: ${t}`).toContain(t);
    }
    expect(rows.filter((r) => r.uncovered_ops.length > 0).map((r) => r.table_name)).toEqual(["organisations"]);
  });

  // ---------------------------------------------------------------------------
  // THE PLANTS
  // ---------------------------------------------------------------------------
  it("PLANT: an unregistered RPC granted to authenticated is named by the RPC census", async () => {
    const d = await withPlant(
      async (c) => {
        await c.query(`create function public.zzz_t8_rpc() returns int language sql as $$ select 1 $$`);
        await c.query(`revoke all on function public.zzz_t8_rpc() from public, anon, authenticated, service_role`);
        await c.query(`grant execute on function public.zzz_t8_rpc() to authenticated`);
      },
      async (c) => difference(await publicRpcNames(c), accountedRpcNames()),
    );
    expect(d).toEqual({ unaccounted: ["zzz_t8_rpc"], missing: [] });
  });

  it("PLANT: an OVERLOAD of a registered RPC -- invisible to the name census, named by the overload census", async () => {
    const m = await withPlant(
      async (c) => {
        await c.query(
          `create function public.record_consent(p_user_id uuid, p_purpose text) returns int language sql as $$ select 1 $$`,
        );
        await c.query(
          `revoke all on function public.record_consent(uuid, text) from public, anon, authenticated, service_role`,
        );
        await c.query(`grant execute on function public.record_consent(uuid, text) to authenticated`);
      },
      async (c) => ({
        names: difference(await publicRpcNames(c), accountedRpcNames()),
        overloads: await exposedOverloads(c, exposedSchemas()),
        sigs: await exposedRpcSignatures(c, exposedSchemas()),
      }),
    );
    // THE HOLE, measured: the name census does not move.
    expect(m.names).toEqual({ unaccounted: [], missing: [] });
    expect(m.overloads).toEqual(["public.record_consent"]);
    expect(m.sigs).toContain("public.record_consent(p_user_id uuid, p_purpose text)");
  });

  it("PLANT: a THIRD exposed schema in config.toml -- missed by the public-only census, named by the derived one", async () => {
    // The pool role cannot create objects in graphql_public (supabase_admin
    // owns it), so the derivation is proved the way it would really fail: a
    // config.toml that exposes one more schema, and a function granted to
    // anon in it.
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "t8-config-"));
    try {
      mkdirSync(join(root, "supabase"));
      const real = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
      const planted = real.replace(
        /^schemas = \["public", "graphql_public"\]/m,
        'schemas = ["public", "graphql_public", "zzz_t8_exposed"]',
      );
      expect(planted, "the plant must actually change config.toml's [api].schemas").not.toBe(real);
      writeFileSync(join(root, "supabase", "config.toml"), planted);
      const m = await withPlant(
        async (c) => {
          await c.query(`create schema zzz_t8_exposed`);
          await c.query(`create function zzz_t8_exposed.leak() returns int language sql as $$ select 1 $$`);
          await c.query(`revoke all on function zzz_t8_exposed.leak() from public`);
          await c.query(`grant execute on function zzz_t8_exposed.leak() to anon`);
        },
        async (c) => ({
          old: difference(await publicRpcNames(c), accountedRpcNames()),
          sigs: await exposedRpcSignatures(c, exposedSchemas(root)),
        }),
      );
      expect(exposedSchemas(root)).toEqual(["graphql_public", "public", "zzz_t8_exposed"]);
      expect(m.old, "the OLD public-only census cannot see it -- that is the hole").toEqual({
        unaccounted: [],
        missing: [],
      });
      expect(m.sigs).toContain("zzz_t8_exposed.leak()");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PLANT: an unregistered table is named by the relation census AND the privilege census", async () => {
    const m = await withPlant(
      async (c) => {
        await c.query(`create table public.zzz_t8_table (id uuid primary key)`);
        await c.query(`grant select on public.zzz_t8_table to authenticated`);
      },
      async (c) => ({
        rel: difference((await publicRelationsGranted(c)).map((r) => r.relname), accountedRelations()),
        priv: difference(await publicPrivileges(c), DECLARED_PRIVILEGES),
      }),
    );
    expect(m.rel).toEqual({ unaccounted: ["zzz_t8_table"], missing: [] });
    expect(m.priv.unaccounted).toContain("zzz_t8_table|authenticated|SELECT|*");
    expect(m.priv.missing).toEqual([]);
  });

  it("PLANT: a COLUMN-level grant on a registered table -- invisible to the relation census, named by the privilege census", async () => {
    const m = await withPlant(
      async (c) => {
        await c.query(`grant update (action) on public.consents to authenticated`);
      },
      async (c) => ({
        rel: difference((await publicRelationsGranted(c)).map((r) => r.relname), accountedRelations()),
        priv: difference(await publicPrivileges(c), DECLARED_PRIVILEGES),
      }),
    );
    // THE HOLE, measured: consents is already on the relation list.
    expect(m.rel).toEqual({ unaccounted: [], missing: [] });
    expect(m.priv).toEqual({ unaccounted: ["consents|authenticated|UPDATE|action"], missing: [] });
  });

  it("PLANT: a service_role grant on a new public function is named", async () => {
    const d = await withPlant(
      async (c) => {
        await c.query(`create function public.zzz_t8_server() returns int language sql as $$ select 1 $$`);
        await c.query(
          `revoke all on function public.zzz_t8_server() from public, anon, authenticated, service_role`,
        );
        await c.query(`grant execute on function public.zzz_t8_server() to service_role`);
      },
      async (c) => difference(await serviceRoleRpcSignatures(c), Object.keys(SERVER_ONLY_RPCS)),
    );
    expect(d).toEqual({ unaccounted: ["zzz_t8_server()"], missing: [] });
  });

  it("PLANT: EXECUTE on a destructive primitive for service_role is named", async () => {
    const acl = await withPlant(
      async (c) => {
        await c.query(`grant execute on function private.purge_audit_events to service_role`);
      },
      (c) => destructivePrimitiveAcl(c),
    );
    expect(acl.filter((e) => !e.endsWith("|postgres"))).toEqual(["purge_audit_events|postgres,service_role"]);
  });

  it("PLANT: a new public bucket and a permissive storage policy are each named, and the bucket is unfenced", async () => {
    const m = await withPlant(
      async (c) => {
        await c.query(`insert into storage.buckets (id, name, public) values ('zzz-t8', 'zzz-t8', true)`);
        await c.query(`create policy zzz_t8_open on storage.objects for select to authenticated using (true)`);
      },
      async (c) => ({
        buckets: difference(await storageBuckets(c), DECLARED_BUCKETS),
        permissive: await storagePermissivePolicies(c),
        fenced: (await storageFences(c)).filter((f) => f.startsWith("zzz-t8|")),
      }),
    );
    expect(m.buckets).toEqual({ unaccounted: ["zzz-t8|public=true"], missing: [] });
    expect(m.permissive).toEqual(["objects|zzz_t8_open"]);
    expect(m.fenced, "a bucket with no fence is what the four-fence check exists to report").toEqual([]);
  });

  it("PLANT: a second cron job, and a sixth half of the tick, are each named", async () => {
    const m = await withPlant(
      async (c) => {
        await c.query(`select cron.schedule('zzz-t8', '* * * * *', 'select 1')`);
        await c.query(`create function private.zzz_t8_sixth_half() returns void language sql as $$ select $$`);
        const { rows } = await c.query<{ def: string }>(
          `select pg_get_functiondef('private.run_incident_alert_tick'::regproc) as def`,
        );
        await c.query(rows[0].def.replace(/\bbegin\b/i, "begin\n  perform private.zzz_t8_sixth_half();"));
      },
      async (c) => ({ cron: difference(await cronJobs(c), DECLARED_CRON), tick: await tickCallees(c) }),
    );
    expect(m.cron).toEqual({ unaccounted: ["zzz-t8|* * * * *|select 1"], missing: [] });
    expect(difference(m.tick, DECLARED_TICK_CALLEES)).toEqual({
      unaccounted: ["zzz_t8_sixth_half"],
      missing: [],
    });
  });
});

// =============================================================================
// LAYER 1: RPC OVER POSTGREST
// =============================================================================
describe.each(SUPERUSER_ONLY_RPCS)(
  "RPC $fn",
  ({ fn, args, sideEffectTable, positiveControl, invariant }) => {
    it("POSITIVE CONTROL: the aal2 platform superuser reaches it", async () => {
      // The load-bearing test of the whole block. By default it calls the
      // function with the SAME argument builder every refusal below uses, so a
      // refusal that is really a typo, a missing row or an absent function
      // cannot hide. Three surfaces override it -- see `positiveControl`'s doc
      // comment for why a replay would be wrong for those and what replaces it.
      //
      // The lifecycle three are sequenced (suspend, close, reopen) on org B,
      // which is left LIVE afterwards because `reinstate_organisation` is last
      // of the three in the inventory array.
      if (positiveControl) {
        await positiveControl();
        return;
      }
      const { error } = await superuser.rpc(fn, args() as never);
      expect(
        error,
        `${fn} must be reachable by the aal2 superuser with these arguments, or ` +
          `every refusal in this block is a refusal of nothing: ${error?.message}`,
      ).toBeNull();
    });

    it.each(PRINCIPALS)(
      "refuses $key, with no side effect and no audit row",
      async ({ key, client }) => {
        const before = await countRows(sideEffectTable);
        const auditBefore = await auditCount();

        const { error } = await client().rpc(fn, args() as never);

        expect(
          error,
          `${fn} must refuse ${key} -- it returned success, which means this ` +
            `principal can perform a platform-superuser action`,
        ).not.toBeNull();
        expect(
          REFUSAL_CODES.has(error!.code ?? ""),
          `${fn} refused ${key} with an unexpected code ${error!.code}: ` +
            `${error!.message}. A refusal must be the guard's 42501 (or 28000 ` +
            `for a sessionless caller), not an incidental failure that would ` +
            `stop being a refusal the day the incidental cause went away`,
        ).toBe(true);

        // "Refused" means NO SIDE EFFECT, not "an error came back". A guard
        // that raises after its write has already landed is not a guard.
        expect(await countRows(sideEffectTable), `${fn} wrote to ${sideEffectTable} while refusing ${key}`)
          .toBe(before);
        // And a refused superuser action must not self-audit as if it had
        // succeeded -- Task 1's "prove a Link prefetch cannot mint a
        // self-audit row" is the precedent. audit_superuser_audit_log_view,
        // platform_health_snapshot and audit_impersonated_page_view all write
        // their audit row FIRST on the success path, which is exactly the
        // shape that leaks one on a refusal if the guard is in the wrong place.
        expect(await auditCount(), `${fn} minted an audit row while refusing ${key}`)
          .toBe(auditBefore);

        // And for a surface whose success is an UPDATE rather than an INSERT,
        // the row's own state -- which a count cannot see. See `invariant`.

        // PHASE 8 TASK 8: THE MECHANISM, NOT JUST THE CODE. `REFUSAL_CODES`
        // cannot tell "the function's own guard refused me" from "I hold no
        // EXECUTE grant" -- both are 42501 -- and Task 3's DF9 passed for
        // exactly that reason (a grant was absent, so a dead guard looked
        // alive). Every surface in this block is GRANTED to `authenticated`
        // (GATE 0 proves it), so for a signed-in principal the only honest
        // refusal is one raised BY THE FUNCTION ITSELF: its own name prefixes
        // the message. A "permission denied for function" here would mean the
        // grant moved and the guard was never reached.
        const mechanism = mechanismOf(error);
        if (key === "anonymous") {
          expect(
            ANON_MECHANISMS.has(mechanism),
            `${fn} refused anonymous by an unexpected mechanism ${mechanism}: ${error!.message}`,
          ).toBe(true);
        } else {
          expect(
            mechanism,
            `${fn} refused ${key} by ${mechanism}, not by its own guard: ${error!.message}`,
          ).toBe("guard");
          expect(
            error!.message.startsWith(GUARD_PREFIX[fn] ?? `${fn}:`),
            `${fn}'s refusal of ${key} was not raised by ${fn} itself: ${error!.message}`,
          ).toBe(true);
        }

        if (invariant) await invariant();
      },
    );
  },
);

describe("RPCs Phase 7 added that are deliberately member-reachable", () => {
  it.each(Object.entries(MEMBER_REACHABLE_RPCS))(
    "%s is on the inventory with its reason, not omitted from it",
    (fn, reason) => {
      // Not a skip. The inventory test above asserts each of these is granted
      // and exists; this pins WHY it is not in the refusal block, so removing
      // the justification is a diff somebody reads rather than a silent gap.
      expect(reason.length).toBeGreaterThan(40);
      expect(SUPERUSER_ONLY_RPCS.map((r) => r.fn)).not.toContain(fn);
    },
  );

  it("consume_rate_limit cannot be pointed at an organisation the caller is not in", async () => {
    // The boundary that IS asserted for a member-reachable RPC: Task 5's I1
    // class -- a caller-supplied organisation reaching a platform counter.
    // POSITIVE CONTROL FIRST: the same call against their OWN workspace
    // succeeds, so the refusal below is the membership check and not a wrong
    // category name, a bad scope or an unreachable function.
    const own = await fx.activeByRole.manager.client.rpc("consume_rate_limit", {
      p_category: "exports",
      p_organisation_id: fx.orgA.id,
    });
    expect(own.error, `a member could not meter their own workspace: ${own.error?.message}`).toBeNull();

    const { error } = await fx.activeByRole.manager.client.rpc("consume_rate_limit", {
      p_category: "exports",
      p_organisation_id: fx.orgB.id,
    });
    expect(error, "a member metered a workspace they do not belong to").not.toBeNull();
  });

  it("the two note reads return the OPERATOR's rows and none of the requester's own", async () => {
    // Phase 8 Task 3 fix round 1 (M9). Both functions are SECURITY INVOKER
    // over public.data_subject_request_notes, whose only SELECT policy is the
    // aal2 superuser's -- so the grant to `authenticated` is not an access
    // path. POSITIVE CONTROL FIRST, or "the requester reads no notes" passes
    // because there are none: plant a real note and prove the operator reads
    // it through the same function before asserting the requester does not.
    const planted = await superuser.rpc("add_data_subject_request_note", {
      p_request_id: ARGS.dsrRequestId,
      p_body: "matrix note-read boundary probe",
    });
    expect(planted.error, `add_data_subject_request_note: ${planted.error?.message}`).toBeNull();

    const operatorNotes = await superuser.rpc("data_subject_request_recent_notes", {
      p_request_ids: [ARGS.dsrRequestId],
      p_per_request: 5,
    });
    expect(operatorNotes.error, `${operatorNotes.error?.message}`).toBeNull();
    expect(
      (operatorNotes.data ?? []).length,
      "DENOMINATOR: the operator must read the planted note through this function",
    ).toBeGreaterThanOrEqual(1);
    const operatorCounts = await superuser.rpc("data_subject_request_note_counts", {
      p_request_ids: [ARGS.dsrRequestId],
    });
    expect(
      Number(((operatorCounts.data ?? []) as { note_count: number }[])[0]?.note_count ?? 0),
    ).toBeGreaterThanOrEqual(1);

    // The REQUESTER of that very request -- the sharpest principal there is.
    const requester = fx.activeByRole.read_only.client;
    const ownNotes = await requester.rpc("data_subject_request_recent_notes", {
      p_request_ids: [ARGS.dsrRequestId],
      p_per_request: 5,
    });
    expect(ownNotes.error, `${ownNotes.error?.message}`).toBeNull();
    expect(ownNotes.data ?? [], "the requester read an operator note (Q103)").toEqual([]);
    const ownCounts = await requester.rpc("data_subject_request_note_counts", {
      p_request_ids: [ARGS.dsrRequestId],
    });
    expect(ownCounts.error, `${ownCounts.error?.message}`).toBeNull();
    expect(
      ownCounts.data ?? [],
      "the requester learned HOW MANY operator notes their request carries",
    ).toEqual([]);
  });

  it("accept_impersonation_request refuses a member of the target org who lacks manage_organisation", async () => {
    // Owner/Admin only. A read-only member of the very organisation named by
    // the request is the sharpest probe: they can SEE the row (the
    // target-admin SELECT policy is role-gated, so in fact they cannot -- which
    // this asserts too) and must not be able to consent on the workspace's
    // behalf.
    // Org A, not org B: this probe runs after the table block, and org B is
    // deliberately left with no live session there. Org A already carries the
    // matrix's own live session, so the probe uses a workspace whose live-pair
    // slot is free -- the same 23505 trap request_impersonation's own positive
    // control documents.
    await pool.query(
      `delete from public.impersonation_sessions where target_organisation_id = $1 and status = 'pending'`,
      [fx.orgB.id],
    );
    const { data: sessionId, error: reqErr } = await superuser.rpc(
      "request_impersonation",
      { p_organisation_slug: fx.orgB.slug, p_reason: "consent-gate probe" },
    );
    expect(reqErr, "POSITIVE CONTROL: the superuser must be able to raise the request").toBeNull();

    const { error } = await fx.activeByRole.read_only.client.rpc(
      "accept_impersonation_request",
      { p_session_id: sessionId as string },
    );
    expect(error, "a Read Only member consented to support access").not.toBeNull();

    const { rows } = await pool.query(
      `select accepted_at from public.impersonation_sessions where id = $1`,
      [sessionId],
    );
    expect(rows[0].accepted_at, "the refused consent still landed").toBeNull();

    await pool.query(`delete from public.impersonation_sessions where id = $1`, [sessionId]);
  });
});

// =============================================================================
// LAYER 2: TABLES AND VIEWS OVER POSTGREST
// =============================================================================
/**
 * Which principals may legitimately READ rows of each table, and why. The
 * brief: a deliberately member-reachable surface states the boundary with its
 * reason and Q number rather than being skipped.
 */
const MEMBER_READABLE: Partial<Record<string, PrincipalKey[]>> = {
  // Task 2: the target workspace's own Owner/Admin must see the request in
  // order to consent to it (impersonation_sessions_select_target_admin). Both
  // keys are the same underlying Owner of org A -- listed twice because the
  // principal list treats "an Owner" and "an Owner under a live session" as
  // separate subjects, and the second is exactly the one that must gain
  // nothing extra from the session.
  impersonation_sessions: ["orgOwner", "impersonatedOrgOwner"],
  // Task 4 / Q103: EVERY active member -- not just an Owner or an Admin --
  // reads their own workspace's override row, because their own entitlement
  // resolution needs it. RLS filters rows, not columns, so the policy cannot
  // hide the reason from a member; the UI narrows the clock to Owner/Admin and
  // the POLICY does not, and this asserts the policy AS BUILT rather than as
  // the UI implies. `readOnlyMember` is on the list for exactly that reason:
  // dropping it would have made this a test of the UI's intent.
  //
  // What the policy must still refuse is the CROSS-TENANT read, which the
  // ">0 rows" assertion here cannot see. That is asserted separately, by
  // organisation id, in "an override is visible only inside its own workspace".
};

/**
 * The two tables whose SELECT policy is TENANT-scoped rather than
 * platform-scoped, and the workspace each principal belongs to.
 *
 * A count-based expectation is the wrong instrument for these: "this member
 * read some rows" is satisfied just as happily by a member reading ANOTHER
 * workspace's comp, which is the leak worth catching. So the assertion is on
 * the organisation id of every row returned, and the ">0" denominator is
 * demanded of the one principal whose workspace is guaranteed to carry a live
 * override (principal 7, built in beforeAll).
 */
const ORG_SCOPED_TABLES = new Set([
  "organisation_billing_overrides",
  "organisation_feature_overrides",
]);
function organisationOf(key: PrincipalKey): string | null {
  switch (key) {
    case "readOnlyMember":
    case "orgOwner":
    case "impersonatedOrgOwner":
      return fx.orgA.id;
    case "overriddenOrgOwner":
      return fx.orgB.id;
    case "suspendedMember":
      return suspendedOrg.id;
    default:
      // anonymous, noOrganisation, and the aal1 superuser -- who is a member
      // of no organisation at all, which is precisely why platform_admins and
      // not a membership is what makes a superuser.
      return null;
  }
}

/**
 * A VALID row body per table, so an INSERT refusal is the grant or the policy
 * refusing and never a NOT NULL constraint.
 *
 * This is the denominator, at the write layer. `insert({ id })` would be
 * refused by all seven tables, and by six of them for a reason that has
 * nothing to do with permissions -- which is a green test measuring a missing
 * column. Each body below would be accepted if the caller were permitted.
 */
function validInsert(table: string): Record<string, unknown> {
  const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
  switch (table) {
    case "feedback":
      // organisation_id NULL, deliberately and per Q124: "/invites",
      // "/onboarding" and "/super" are real signed-in surfaces with no
      // workspace in their path, so a null attribution is accepted from ANY
      // caller. Naming org A instead would refuse four of the seven principals
      // for a membership reason and say nothing about the INSERT policy --
      // the cross-tenant attribution boundary has its own assertion below and
      // its own suite (rls_phase7_feedback.sql).
      return {
        organisation_id: null,
        category: "bug",
        message: "permission matrix write probe",
        route: "/matrix",
      };
    case "impersonation_sessions":
      return {
        superuser_user_id: fx.superuser.userId,
        target_organisation_id: fx.orgA.id,
        reason: "permission matrix write probe",
      };
    case "incident_alerts":
      return {
        alert_type: "rate_limit_tripped",
        summary: "permission matrix write probe",
      };
    case "organisation_billing_overrides":
      return {
        organisation_id: fx.orgA.id,
        override_tier: "pro",
        reason: "permission matrix write probe",
        granted_by: fx.superuser.userId,
        expires_at: inAnHour,
      };
    case "organisation_feature_overrides":
      return {
        organisation_id: fx.orgA.id,
        flag_key: "early_access_preview",
        reason: "permission matrix write probe",
        granted_by: fx.superuser.userId,
        expires_at: inAnHour,
      };
    case "rate_limit_counters":
      return {
        category: "search",
        subject_scope: "user",
        subject_id: fx.ownerA.userId,
        window_start: new Date().toISOString(),
        request_count: 1,
      };
    case "rate_limit_policies":
      return {
        category: "matrix_probe",
        subject_scope: "user",
        max_requests: 999_999,
        window_seconds: 1,
        description: "permission matrix write probe",
      };
    // Phase 8 Task 6. Both bodies are fully valid -- they satisfy every CHECK
    // on their table -- so what refuses them is the missing grant and the
    // missing policy, which is the only thing this probe is allowed to be
    // measuring.
    case "retention_runs":
      return {
        correlation_id: "00000000-0000-4000-8000-0000000000f6",
        mode: "dry",
        status: "running",
      };
    case "retention_settings":
      // The singleton row already exists, so this would be a 23505 even for a
      // permitted caller -- which is why the SECOND id is used: `false` is
      // refused by the CHECK, and `true` by the primary key, and neither is
      // the refusal we are asking about. So the probe writes the row that IS
      // valid in every way but the grant: an UPSERT-shaped insert of the same
      // id, which PostgREST sends as a plain INSERT and which a permitted
      // caller would see refused by the primary key AFTER the policy has
      // admitted it. The checksum below is what carries the weight either way.
      return { id: true, enabled: false, audit_purge_enabled: false };
    default:
      throw new Error(`no valid INSERT body for ${table}`);
  }
}

/**
 * `feedback` is the ONE Phase 7 table a member may legitimately INSERT into --
 * CLAUDE.md § In-app feedback: "any logged-in user, on any tier". It is named
 * here rather than left to be discovered, because a blanket "nobody can
 * INSERT" test over an invalid body would have passed on this table too, for
 * the wrong reason, and hidden the fact that the policy is deliberately open.
 */
const MEMBER_INSERTABLE = new Set(["feedback"]);

/** A column every row of the table has, for a filter that matches everything.
 *  The two rate-limit tables have no `id`. */
function anyColumn(table: string): string {
  if (table.startsWith("rate_limit_")) return "category";
  // public.retention_settings' primary key is the boolean singleton `id`,
  // which is an `id` and filters fine.
  return "id";
}

/**
 * A VALID single-column UPDATE per table, for the same reason `validInsert`
 * exists: a probe that sets a nonexistent column, or a value a CHECK would
 * reject, is refused before any policy is consulted and proves nothing.
 *
 * `incident_alerts.summary` and the two `reason` columns are chosen
 * deliberately: all three tables carry a table-level UPDATE grant for
 * `authenticated`, so the policy and the write guard are genuinely the only
 * things standing between a session and the row (DECISIONS-QUEUE Q125).
 */
const UPDATE_PROBE: Record<string, Record<string, unknown>> = {
  feedback: { status: "archived" },
  impersonation_sessions: { reason: "matrix update probe" },
  incident_alerts: { summary: "matrix update probe" },
  organisation_billing_overrides: { reason: "matrix update probe" },
  organisation_feature_overrides: { reason: "matrix update probe" },
  rate_limit_counters: { request_count: 999_999 },
  rate_limit_policies: { description: "matrix update probe" },
  // Phase 8 Task 6. Both are VALID single-column writes -- duration_ms has
  // only a >= 0 CHECK, and `reason` a non-blank one -- so what refuses them
  // is the absent grant and the absent policy, not a constraint that would
  // have refused the superuser too.
  retention_runs: { duration_ms: 999 },
  retention_settings: { reason: "matrix update probe" },
};

/**
 * A checksum of the WHOLE table, read as `postgres`.
 *
 * Row counts miss an UPDATE and a delete-plus-insert; this does not. "Refused"
 * has to mean "the table is byte-for-byte what it was", because a guard that
 * raises after its write has landed is not a guard, and a refusal that
 * silently mutates one column is the worst of both.
 */
async function tableChecksum(table: string): Promise<string> {
  const { rows } = await pool.query(
    `select coalesce(md5(string_agg(t::text, '|' order by t::text)), 'empty') as h
       from public.${table} t`,
  );
  return rows[0].h as string;
}

describe.each(PHASE7_TABLES)("table %s", (table) => {
  it("POSITIVE CONTROL: the aal2 platform superuser reads rows from it", async () => {
    // WITHOUT THIS, EVERY "reads zero rows" ASSERTION BELOW IS VACUOUS. An
    // empty table refuses everybody perfectly, and a mistyped table name
    // refuses everybody perfectly too.
    const { data, error } = await superuser.from(table).select("*").limit(5);
    expect(error, `${table}: the superuser's own read failed: ${error?.message}`).toBeNull();
    expect(
      (data ?? []).length,
      `${table} is EMPTY, so "nobody else can read it" measures nothing. Plant a ` +
        `row in beforeAll before trusting a single refusal in this block.`,
    ).toBeGreaterThan(0);
  });

  it.each(PRINCIPALS)("$key reads only what policy permits", async ({ key, client }) => {
    const { data, error } = await client().from(table).select("*").limit(50);

    if (ORG_SCOPED_TABLES.has(table)) {
      // Task 4 / Q103: every ACTIVE MEMBER -- not just an Owner or an Admin --
      // reads their own workspace's override, because their own entitlement
      // resolution needs it. RLS filters rows and not columns, so the policy
      // cannot hide the reason from a member; the UI narrows the clock to
      // Owner/Admin and the POLICY does not. `readOnlyMember` is treated as
      // permitted here for exactly that reason: expecting a refusal would have
      // made this a test of the UI's intent rather than of the policy.
      const org = organisationOf(key);
      const rows = (data ?? []) as { organisation_id: string }[];
      if (org === null) {
        expect(
          rows,
          `${table}: ${key} belongs to no workspace and read rows anyway`,
        ).toEqual([]);
        return;
      }
      expect(error, `${table}: ${key} errored: ${error?.message}`).toBeNull();
      expect(
        rows.filter((r) => r.organisation_id !== org),
        `${table}: ${key} read ANOTHER workspace's override -- the tenant ` +
          `boundary, which a row COUNT would never have noticed`,
      ).toEqual([]);
      if (key === "overriddenOrgOwner") {
        expect(
          rows.length,
          `${table}: principal 7's workspace carries a live override built in ` +
            `beforeAll and this read returned nothing, so every "reads only its ` +
            `own" assertion above it is vacuous`,
        ).toBeGreaterThan(0);
      }
      return;
    }

    const permitted = (MEMBER_READABLE[table] ?? []).includes(key);

    if (permitted) {
      expect(
        error,
        `${table}: ${key} is member-readable by design and errored: ${error?.message}`,
      ).toBeNull();
      expect(
        (data ?? []).length,
        `${table}: ${key} is documented as member-readable and read NOTHING -- ` +
          `either the policy regressed or this expectation is wrong. Both are ` +
          `findings; neither is a pass.`,
      ).toBeGreaterThan(0);
      return;
    }
    // Refusal here is zero ROWS, not an error: a SELECT policy that matches
    // nothing is PostgREST's 200 + []. That is the correct shape -- an error
    // would itself be an existence oracle. `anon` holds no SELECT grant at
    // all and does get an error, which is also correct.
    const code = error?.code ?? null;
    expect(
      code === null || REFUSAL_CODES.has(code),
      `${table}: ${key} got an unexpected error ${code}: ${error?.message}`,
    ).toBe(true);
    expect(data ?? [], `${table}: ${key} READ ROWS it must not see`).toEqual([]);
  });

  it.each(PRINCIPALS)("$key cannot write to it", async ({ key, client }) => {
    const filter = anyColumn(table);

    // ---- INSERT, with a body that WOULD be accepted from a permitted caller
    const insertBefore = await tableChecksum(table);
    const ins = await client().from(table).insert(validInsert(table) as never);
    if (MEMBER_INSERTABLE.has(table) && key !== "anonymous") {
      expect(
        ins.error,
        `${table}: ${key} is permitted to submit by design and was refused: ${ins.error?.message}`,
      ).toBeNull();
      await pool.query(
        `delete from public.feedback where route = '/matrix' and message = 'permission matrix write probe'`,
      );
    } else {
      expect(
        ins.error,
        `${table}: ${key} INSERTed a row with a fully valid body`,
      ).not.toBeNull();
      expect(
        await tableChecksum(table),
        `${table}: ${key}'s refused INSERT still changed the table`,
      ).toBe(insertBefore);
    }

    // ---- UPDATE and DELETE, aimed at EVERY row (`not.is(col, null)` matches
    // them all), so a zero-row match cannot be mistaken for a policy refusal:
    // PostgREST reports an unmatched UPDATE as a 200 with no rows, which looks
    // exactly like a refusal from the outside. The assertion that carries the
    // weight is therefore the table's own bytes, read back as `postgres`.
    const before = await tableChecksum(table);
    await client().from(table).update(UPDATE_PROBE[table] as never).not(filter, "is", null);
    // Not one of the seven carries a DELETE policy for any client role,
    // deliberately -- platform history is append-only from a session, and the
    // grant block below proves no client role holds the privilege either.
    await client().from(table).delete().not(filter, "is", null);
    expect(
      await tableChecksum(table),
      `${table}: ${key} changed or removed rows`,
    ).toBe(before);
  });
});

// =============================================================================
// LAYER 3: THE GRANTS THEMSELVES
// =============================================================================
// BYPASSRLS bypasses POLICIES, not GRANTS -- Task 5's I3 was exactly that
// confusion. A policy is the wrong place to look for the last line of defence
// against a role that does not consult policies, so the grants are asserted
// directly, from the catalogue, in the shape `\dp` prints.
describe("grants on Phase 7 tables are minimal", () => {
  it("no client role holds DELETE on any Phase 7 table", async () => {
    const { rows } = await pool.query(
      `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = any($1::text[])
          and grantee in ('anon','authenticated','service_role')
          and privilege_type in ('DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
      [[...PHASE7_TABLES]],
    );
    expect(rows, "a client role can delete platform history").toEqual([]);
  });

  it("`anon` holds nothing at all on any Phase 7 table", async () => {
    const { rows } = await pool.query(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any($1::text[]) and grantee = 'anon'`,
      [[...PHASE7_TABLES]],
    );
    expect(rows, "a signed-out caller holds a grant on a platform table").toEqual([]);
  });

  it("no Phase 7 table gives `authenticated` a TABLE-level UPDATE", async () => {
    // THE ROW THAT WAS RED, and the reason 20260919000000 exists.
    //
    // `incident_alerts` held table-level UPDATE for `authenticated`. That was
    // never member-reachable -- the row policy gates on
    // has_platform_permission, and the matrix above measures exactly that,
    // principal by principal, and finds it closed. What it left open is
    // slower: any column a later migration adds becomes writable from the
    // single aal2 superuser's own browser the moment it exists, with only the
    // resolution guard's hand-maintained immutable list in the way -- a list
    // `account_notified_at` (20260916001000) already had to be remembered
    // into. A column-level grant inverts that: a forgotten column is outside
    // the grant and fails closed.
    //
    // Asserted as a RULE over all seven tables rather than as a fact about the
    // one that was wrong, so the next platform table cannot arrive with the
    // same shape and a green suite.
    const { rows } = await pool.query<{ table_name: string; n: number }>(
      `select g.table_name, count(*)::int as n
         from information_schema.column_privileges g
        where g.table_schema = 'public'
          and g.table_name = any($1::text[])
          and g.grantee = 'authenticated'
          and g.privilege_type = 'UPDATE'
        group by g.table_name`,
      [[...PHASE7_TABLES]],
    );
    const columnCount = await pool.query<{ table_name: string; n: number }>(
      `select c.table_name, count(*)::int as n
         from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = any($1::text[])
        group by c.table_name`,
      [[...PHASE7_TABLES]],
    );
    const total = new Map(columnCount.rows.map((r) => [r.table_name, r.n]));
    for (const row of rows) {
      expect(
        row.n,
        `${row.table_name} grants \`authenticated\` UPDATE on all ${row.n} of ` +
          `its columns -- a table-level grant, so every column a later ` +
          `migration adds is writable from the operator's own browser the ` +
          `moment it exists (Q125). Narrow it to the columns the client ` +
          `actually writes.`,
      ).toBeLessThan(total.get(row.table_name)!);
    }
    // The denominator: if NOTHING granted `authenticated` UPDATE on any of the
    // seven, the loop above would be vacuous.
    expect(
      rows.length,
      "no Phase 7 table grants `authenticated` UPDATE at all, so the rule above " +
        "checked nothing -- feedback.status and incident_alerts' resolution " +
        "flag are both real client writes and at least two rows are expected",
    ).toBeGreaterThan(0);
  });

  it("`authenticated` writes only the resolution flag on `incident_alerts`", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema='public' and table_name='incident_alerts'
          and grantee='authenticated' and privilege_type='UPDATE'
        order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["resolved_at", "resolved_by"]);
  });

  it("service_role writes exactly the three delivery stamps on `incident_alerts`", async () => {
    // One column per channel, each stamped only by its own sender after
    // ok:true: the email digest, the account-holder notice (Q114) and, since
    // 20261014000000, the Telegram alert (founder 2026-09-30, Q111). A fourth
    // column here -- or `telegram_notified_at` granted to a client role --
    // is a channel whose stamp somebody else can move.
    const { rows } = await pool.query<{ grantee: string; column_name: string }>(
      `select grantee, column_name from information_schema.column_privileges
        where table_schema='public' and table_name='incident_alerts'
          and privilege_type='UPDATE' and column_name like '%notified_at'
          and grantee <> 'postgres' -- the table owner, not a grantee
        order by grantee, column_name`,
    );
    expect(rows).toEqual([
      { grantee: "service_role", column_name: "account_notified_at" },
      { grantee: "service_role", column_name: "notified_at" },
      { grantee: "service_role", column_name: "telegram_notified_at" },
    ]);
  });

  it("the connection-request / task-reminder ledger is reachable by NO API role -- its one write path is a service_role RPC", async () => {
    // Task 9b job 3 (founder 2026-09-30, Q157(3)/Q174/Q45; 20261016000000).
    // A ledger in `private` rather than a column on tasks /
    // network_connection_requests, because both of those grant
    // `authenticated` table-level UPDATE -- the Q125 shape above -- so a stamp
    // column there would be browser-writable the moment it existed. The
    // denominator: the table must exist, or every `false` below is vacuous.
    const { rows } = await pool.query<{ role: string; priv: string; held: boolean; exists: boolean }>(
      `select r as role, p as priv,
              has_table_privilege(r, 'private.notification_deliveries', p) as held,
              to_regclass('private.notification_deliveries') is not null as exists
         from unnest(array['anon','authenticated','service_role']) r
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`,
    );
    expect(rows.length).toBe(15);
    expect(rows.every((r) => r.exists)).toBe(true);
    expect(rows.filter((r) => r.held)).toEqual([]);
    const fn = await pool.query<{ anon: boolean; authed: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.mark_notices_delivered(text, uuid[])', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.mark_notices_delivered(text, uuid[])', 'EXECUTE') as authed,
              has_function_privilege('service_role', 'public.mark_notices_delivered(text, uuid[])', 'EXECUTE') as service`,
    );
    expect(fn.rows[0]).toEqual({ anon: false, authed: false, service: true });
  });

  it("service_role's reach into `feedback` is the two-column delivery seam and nothing more", async () => {
    // BYPASSRLS makes the policy irrelevant for this role, so the grant is the
    // whole of the control. 20260911030000 narrowed it after the first cut
    // copied incident_alerts' whole-table SELECT, which would have read past
    // the two-year retention term the policy carries.
    const { rows } = await pool.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where table_schema='public' and table_name='feedback' and grantee='service_role'
        order by privilege_type, column_name`,
      [],
    );
    expect(rows).toEqual([
      { privilege_type: "SELECT", column_name: "id" },
      { privilege_type: "SELECT", column_name: "notified_at" },
      { privilege_type: "UPDATE", column_name: "notified_at" },
    ]);
  });

  it("`authenticated` cannot name its own attribution columns on `feedback`", async () => {
    // Attribution is non-forgeable BY CONSTRUCTION, not by validation: an
    // INSERT that so much as mentions user_id is 42501 before any trigger
    // runs. This asserts the grant that makes that true, so a future migration
    // widening it to a table-level INSERT is caught here and not by a leak.
    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema='public' and table_name='feedback'
          and grantee='authenticated' and privilege_type='INSERT'
        order by column_name`,
    );
    const granted = new Set(rows.map((r) => r.column_name));
    for (const forbidden of [
      "user_id",
      "user_email",
      "organisation_role",
      "status",
      "notified_at",
      "during_support_access",
    ]) {
      expect(
        granted.has(forbidden),
        `feedback.${forbidden} is inside the client INSERT grant -- a submitter ` +
          `can now name it, which is the I1 bug class`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// PHASE 8 TASK 1: THE ONE TABLE EVERY PRINCIPAL MAY READ
// =============================================================================
// `legal_documents` inverts the Phase 7 contract: EVERYONE reads it, anonymous
// included. So the assertion is not "reads nothing" but "reads exactly the
// fifteen current published versions, and never the draft beforeAll holds
// open" -- with the draft's existence proved first, or "never the draft" is a
// statement about nothing.
describe("table legal_documents (public-read by design)", () => {
  const everyone: { key: string; client: () => SupabaseClient }[] = [
    ...PRINCIPALS.map(({ key, client }) => ({ key: key as string, client })),
    { key: "superuserAal2", client: () => superuser },
  ];

  it("DENOMINATOR: the held draft exists and is a draft", async () => {
    const { rows } = await pool.query(
      `select slug, status, version from public.legal_documents where id = $1`,
      [ARGS.legalDraftId],
    );
    expect(rows).toEqual([{ slug: LEGAL_HELD_SLUG, status: "draft", version: 2 }]);
  });

  it.each(everyone)("$key reads the 15 current versions and not the draft", async ({ client }) => {
    const { data, error } = await client()
      .from("legal_documents")
      .select("id, slug, version")
      .limit(100);
    expect(error, error?.message).toBeNull();
    const rows = (data ?? []) as { id: string; slug: string; version: number }[];
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(15);
    expect(rows.map((r) => r.id)).not.toContain(ARGS.legalDraftId);
    expect(rows.find((r) => r.slug === LEGAL_HELD_SLUG)?.version).toBe(1);
  });

  it.each(everyone)("$key cannot name the reviewer or the status", async ({ client }) => {
    for (const column of ["counsel_reviewer", "status", "published_by"]) {
      const { data, error } = await client().from("legal_documents").select(column).limit(1);
      expect(error, `${column} was selectable`).not.toBeNull();
      expect(REFUSAL_CODES.has(error!.code ?? ""), `${column}: ${error!.code}`).toBe(true);
      expect(data).toBeNull();
    }
  });

  it.each(everyone)("$key cannot write to it -- the aal2 superuser included", async ({ client }) => {
    const before = await tableChecksum("legal_documents");
    await client()
      .from("legal_documents")
      .insert({ slug: "terms", version: 77, title: "t", body: "b", effective_date: "2026-01-01" } as never);
    await client().from("legal_documents").update({ title: "matrix update probe" } as never).not("id", "is", null);
    await client().from("legal_documents").delete().not("id", "is", null);
    expect(await tableChecksum("legal_documents"), "a direct write changed the legal store").toBe(before);
  });

  it("no client role holds a write privilege, and anon holds exactly the eight-column read", async () => {
    const { rows } = await pool.query<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'legal_documents'
          and grantee in ('anon','authenticated','service_role')
        order by grantee, privilege_type, column_name`,
    );
    expect(rows.filter((r) => r.privilege_type !== "SELECT")).toEqual([]);
    expect(rows.filter((r) => r.grantee === "service_role")).toEqual([]);
    expect(rows.filter((r) => r.grantee === "anon").map((r) => r.column_name)).toEqual([
      "body",
      "counsel_reviewed_at",
      "effective_date",
      "id",
      "published_at",
      "slug",
      "title",
      "version",
    ]);
  });
});

// =============================================================================
// PHASE 8 TASK 2: A TABLE EACH PRINCIPAL READS ONLY ITS OWN ROWS OF
// =============================================================================
// `consents` is readable by every signed-in session, row-filtered to the
// caller. The held grant (beforeAll) belongs to the Read Only member, so every
// OTHER principal must read it as absent, the Read Only member must read it,
// and the aal2 superuser must read it (oversight) -- the last two being the
// positive controls that make the others' "absent" mean something.
describe("table consents (own rows only)", () => {
  const readsIt = new Set(["readOnlyMember", "superuserAal2"]);
  const everyone: { key: string; client: () => SupabaseClient }[] = [
    ...PRINCIPALS.map(({ key, client }) => ({ key: key as string, client })),
    { key: "superuserAal2", client: () => superuser },
  ];

  it("DENOMINATOR: the held grant exists and is the Read Only member's", async () => {
    const { rows } = await pool.query(
      `select user_id, action from public.consents where id = $1`,
      [ARGS.consentId],
    );
    expect(rows).toEqual([{ user_id: fx.activeByRole.read_only.userId, action: "granted" }]);
  });

  it.each(everyone)("$key reads the held grant only if it is theirs (or the aal2 operator)", async ({ key, client }) => {
    const { data, error } = await client().from("consents").select("id, user_id").eq("id", ARGS.consentId);
    if (key === "anonymous") {
      // anon holds no grant at all -- refused, not merely filtered.
      expect(error, "anon read the consent ledger").not.toBeNull();
      expect(REFUSAL_CODES.has(error!.code ?? ""), error?.code).toBe(true);
      return;
    }
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length, key).toBe(readsIt.has(key) ? 1 : 0);
  });

  it.each(everyone)("$key cannot write to it directly -- the aal2 superuser included", async ({ client }) => {
    const before = await tableChecksum("consents");
    await client()
      .from("consents")
      .insert({ purpose: "marketing_email", action: "withdrawn", policy_version: 2, mechanism: "account_settings" } as never);
    await client().from("consents").update({ action: "withdrawn" } as never).eq("id", ARGS.consentId);
    await client().from("consents").delete().eq("id", ARGS.consentId);
    expect(await tableChecksum("consents"), "a direct write changed the consent ledger").toBe(before);
  });

  it("record_consent stamps the CALLER: a no-organisation user's grant is theirs, and a user argument does not exist", async () => {
    const forged = await noOrgClient.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "withdrawn",
      p_user_id: fx.activeByRole.read_only.userId,
    } as never);
    expect(forged.error, "record_consent accepted a user argument").not.toBeNull();
    const { rows: before } = await pool.query(`select action from public.consents where id = $1`, [ARGS.consentId]);
    expect(before, "the held grant was touched").toEqual([{ action: "granted" }]);

    const { rows: v } = await pool.query<{ version: number }>(
      `select version from public.legal_documents where slug = 'marketing-preferences' and status = 'published'`,
    );
    const { data, error } = await noOrgClient.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: v[0].version,
      // A grant must name listed wording since 20260923003000 (review M1).
      p_statement: "marketing-email-1",
    });
    expect(error, error?.message).toBeNull();
    const id = ((data ?? []) as { consent_id: string }[])[0]?.consent_id;
    const { rows } = await pool.query(`select user_id from public.consents where id = $1`, [id]);
    expect(rows).toEqual([{ user_id: noOrgUserId }]);
  });

  it("anonymous cannot record a consent at all", async () => {
    const before = await tableChecksum("consents");
    const { error } = await fx.anonClient.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: 2,
    });
    expect(error).not.toBeNull();
    expect(REFUSAL_CODES.has(error!.code ?? ""), error?.code).toBe(true);
    expect(await tableChecksum("consents")).toBe(before);
  });

  it("no client role holds a write privilege, and service_role holds nothing", async () => {
    const { rows } = await pool.query<{ grantee: string; privilege_type: string }>(
      `select distinct grantee, privilege_type from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'consents'
          and grantee in ('anon','authenticated','service_role')
        order by grantee, privilege_type`,
    );
    expect(rows).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });
});

// =============================================================================
// PHASE 8 TASK 3: THE REGISTER (OWN ROWS) AND THE NOTES (OPERATOR ONLY)
// =============================================================================
// The held request belongs to the Read Only member. Every other principal must
// read it as absent; the Read Only member and the aal2 superuser must read it,
// which is what makes the others' "absent" mean something. The NOTES are the
// Q103 half: the requester can read the request and must read NONE of its
// notes.
describe("table export_jobs (own rows only, Phase 8 Task 4)", () => {
  const everyone: { key: string; client: () => SupabaseClient }[] = [
    ...PRINCIPALS.map(({ key, client }) => ({ key: key as string, client })),
    { key: "superuserAal2", client: () => superuser },
  ];

  it("DENOMINATOR: the held job exists, is the Read Only member's, and is still queued", async () => {
    const { rows } = await pool.query(
      `select requested_by, kind, status, organisation_id from public.export_jobs where id = $1`,
      [ARGS.exportJobId],
    );
    expect(rows).toEqual([
      {
        requested_by: fx.activeByRole.read_only.userId,
        kind: "account",
        status: "queued",
        organisation_id: null,
      },
    ]);
  });

  it.each(everyone)(
    "$key reads the held job only if it is theirs -- THE AAL2 OPERATOR INCLUDED",
    async ({ key, client }) => {
      const { data, error } = await client()
        .from("export_jobs")
        .select("id, requested_by")
        .eq("id", ARGS.exportJobId);
      if (key === "anonymous") {
        // anon holds no grant on the table at all -- refused, not filtered.
        expect(error, "anon read the export register").not.toBeNull();
        expect(REFUSAL_CODES.has(error!.code ?? ""), error?.code).toBe(true);
        return;
      }
      expect(error, error?.message).toBeNull();
      // There is NO oversight policy on this table: the platform superuser
      // reads nobody's export jobs either, which is a deliberate difference
      // from consents and data subject requests.
      expect((data ?? []).length, key).toBe(key === "readOnlyMember" ? 1 : 0);
    },
  );

  it.each(everyone)("$key cannot move or delete it -- the aal2 superuser included", async ({ client }) => {
    const before = await tableChecksum("export_jobs");
    await client()
      .from("export_jobs")
      .update({ status: "succeeded" } as never)
      .eq("id", ARGS.exportJobId);
    await client().from("export_jobs").delete().eq("id", ARGS.exportJobId);
    expect(await tableChecksum("export_jobs"), "a direct write changed the export register").toBe(
      before,
    );
  });

  it("the insert stamps the CALLER, and the forgeable columns are outside the grant", async () => {
    const forged = await noOrgClient
      .from("export_jobs")
      .insert({
        kind: "account",
        requested_by: fx.activeByRole.read_only.userId,
        status: "succeeded",
      } as never);
    expect(forged.error, "export_jobs accepted a forged requester or status").not.toBeNull();

    // ...and the honest insert from the same principal IS accepted, so the
    // refusal above is the grant's and not "this caller cannot insert".
    const { data, error } = await noOrgClient
      .from("export_jobs")
      .insert({ kind: "account" } as never)
      .select("id, requested_by, status");
    expect(error, error?.message).toBeNull();
    const made = (data ?? []) as { id: string; requested_by: string; status: string }[];
    expect(made[0]?.requested_by).toBe(noOrgUserId);
    expect(made[0]?.status).toBe("queued");
    await pool.query(`delete from public.export_jobs where id = $1`, [made[0].id]);
  });

  it.each(everyone)("$key cannot audit-and-download a job that is not theirs", async ({ key, client }) => {
    if (key === "readOnlyMember") return;
    const { error } = await client().rpc("audit_export_download", { p_job_id: ARGS.exportJobId });
    expect(error, `${key} passed the export download gate`).not.toBeNull();
    // BY WHICH RULE (Phase 8 Task 8). The held job is QUEUED, with no archive,
    // so "refused" alone is also what `export_has_no_archive` answers -- and
    // measured: with the IDOR term (`requested_by = auth.uid()`) deleted from
    // audit_export_download, every principal here was still refused, by row
    // state, and this test stayed green. A signed-in stranger must be refused
    // by the OWNERSHIP rule itself; anon by the missing session or grant.
    if (key === "anonymous") {
      expect(ANON_MECHANISMS.has(mechanismOf(error)), `${mechanismOf(error)} ${error?.message}`).toBe(true);
    } else {
      expect(error?.hint, `${key} was refused by ${error?.hint ?? error?.message}, not by the ownership rule`).toBe(
        "not_your_export",
      );
    }
  });

  it("POSITIVE CONTROL: even the requester is refused while the job has no archive", async () => {
    // The gate is three rules, not one, and this is the only way to tell them
    // apart: the owner passes `not_your_export` and is stopped by
    // `export_has_no_archive`.
    const { error } = await fx.activeByRole.read_only.client.rpc("audit_export_download", {
      p_job_id: ARGS.exportJobId,
    });
    expect(error, "the owner was let through a job with no archive").not.toBeNull();
    expect(error?.hint ?? error?.message).toContain("export_has_no_archive");
  });

  it("no download was audited by any of that", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.audit_events where action = 'export_job.downloaded'`,
    );
    expect(rows[0]?.n).toBe("0");
  });
});

describe("table data_subject_requests (own rows only) and its operator notes", () => {
  const readsIt = new Set(["readOnlyMember", "superuserAal2"]);
  const everyone: { key: string; client: () => SupabaseClient }[] = [
    ...PRINCIPALS.map(({ key, client }) => ({ key: key as string, client })),
    { key: "superuserAal2", client: () => superuser },
  ];

  it("DENOMINATOR: the held request exists, is the Read Only member's, and is open", async () => {
    const { rows } = await pool.query(
      `select user_id, status from public.data_subject_requests where id = $1`,
      [ARGS.dsrRequestId],
    );
    expect(rows).toEqual([{ user_id: fx.activeByRole.read_only.userId, status: "open" }]);
  });

  /** The notes this request really carries, straight out of Postgres. */
  async function heldRequestNoteCount(): Promise<number> {
    const { rows } = await pool.query(
      `select count(*)::int as n from public.data_subject_request_notes where request_id = $1`,
      [ARGS.dsrRequestId],
    );
    return rows[0].n as number;
  }

  it("DENOMINATOR: the held request carries a real operator note", async () => {
    // RELATIVE, NOT ABSOLUTE, AND THAT IS THE POINT. This block used to assert
    // the count was exactly 1, which silently depended on nothing earlier in
    // the file having written to the SAME held request. Fix round 1 broke that
    // by adding the note-read boundary test above, which plants its own probe
    // on this very row -- so the assertion failed for a reason that had
    // nothing to do with what it measures. What has to be true is that THIS
    // call wrote exactly one note; the total is then read from the database by
    // the reads below rather than assumed.
    const before = await heldRequestNoteCount();
    const { error } = await superuser.rpc("add_data_subject_request_note", {
      p_request_id: ARGS.dsrRequestId,
      p_body: "matrix denominator note -- the requester must not read this",
    });
    expect(error, `add_data_subject_request_note: ${error?.message}`).toBeNull();
    const after = await heldRequestNoteCount();
    expect(after, "one call must write exactly one note").toBe(before + 1);
    expect(after, "DENOMINATOR: there is a real note to fail to read").toBeGreaterThanOrEqual(1);
  });

  it.each(everyone)("$key reads the held request only if it is theirs (or the aal2 operator)", async ({ key, client }) => {
    const { data, error } = await client()
      .from("data_subject_requests")
      .select("id, user_id")
      .eq("id", ARGS.dsrRequestId);
    if (key === "anonymous") {
      expect(error, "anon read the request register").not.toBeNull();
      expect(REFUSAL_CODES.has(error!.code ?? ""), error?.code).toBe(true);
      return;
    }
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length, key).toBe(readsIt.has(key) ? 1 : 0);
  });

  it.each(everyone)("$key reads an operator note only if it is the aal2 operator", async ({ key, client }) => {
    const { data, error } = await client()
      .from("data_subject_request_notes")
      .select("id, body")
      .eq("request_id", ARGS.dsrRequestId);
    if (key === "anonymous") {
      expect(error, "anon read the operator notes").not.toBeNull();
      expect(REFUSAL_CODES.has(error!.code ?? ""), error?.code).toBe(true);
      return;
    }
    expect(error, error?.message).toBeNull();
    // THE Q103 ASSERTION: readOnlyMember CAN read the request above and must
    // read none of its notes here. The operator's expected number is the
    // database's own count, so this is strictly stronger than the literal 1 it
    // replaces -- the operator must read EVERY note on the row, not just one.
    const total = await heldRequestNoteCount();
    expect(total, "DENOMINATOR: the row must carry at least one note").toBeGreaterThanOrEqual(1);
    expect((data ?? []).length, key).toBe(key === "superuserAal2" ? total : 0);
  });

  it.each(everyone)("$key cannot write to either table directly -- the aal2 superuser included", async ({ client }) => {
    const before = await tableChecksum("data_subject_requests");
    const notesBefore = await tableChecksum("data_subject_request_notes");
    await client()
      .from("data_subject_requests")
      .insert({
        user_id: fx.activeByRole.read_only.userId,
        user_email: "matrix@test.local",
        right_type: "access",
        subject_scope: "account",
        detail: "direct",
      } as never);
    await client()
      .from("data_subject_requests")
      .update({ status: "fulfilled" } as never)
      .eq("id", ARGS.dsrRequestId);
    await client().from("data_subject_requests").delete().eq("id", ARGS.dsrRequestId);
    await client()
      .from("data_subject_request_notes")
      .insert({ request_id: ARGS.dsrRequestId, author_user_id: fx.activeByRole.read_only.userId, body: "x" } as never);
    expect(await tableChecksum("data_subject_requests"), "a direct write changed the register").toBe(before);
    expect(await tableChecksum("data_subject_request_notes"), "a direct write changed the notes").toBe(notesBefore);
  });

  it("submit_data_subject_request stamps the CALLER, and no user argument exists", async () => {
    const forged = await noOrgClient.rpc("submit_data_subject_request", {
      p_right_type: "access",
      p_subject_scope: "account",
      p_detail: "forged",
      p_user_id: fx.activeByRole.read_only.userId,
    } as never);
    expect(forged.error, "submit_data_subject_request accepted a user argument").not.toBeNull();

    const { data, error } = await noOrgClient.rpc("submit_data_subject_request", {
      p_right_type: "access",
      p_subject_scope: "account",
      p_detail: "a no-workspace account has these rights too",
    });
    expect(error, error?.message).toBeNull();
    const id = ((data ?? []) as { request_id: string }[])[0]?.request_id;
    const { rows } = await pool.query(
      `select user_id, (due_by - requested_at)::text as window from public.data_subject_requests where id = $1`,
      [id],
    );
    expect(rows).toEqual([{ user_id: noOrgUserId, window: "30 days" }]);
  });

  it("no CLIENT role holds a write privilege on either table", async () => {
    const { rows } = await pool.query<{ table_name: string; grantee: string; privilege_type: string }>(
      `select distinct table_name, grantee, privilege_type from information_schema.column_privileges
        where table_schema = 'public'
          and table_name in ('data_subject_requests', 'data_subject_request_notes')
          and grantee in ('anon','authenticated')
        order by table_name, grantee, privilege_type`,
    );
    expect(rows).toEqual([
      { table_name: "data_subject_request_notes", grantee: "authenticated", privilege_type: "SELECT" },
      { table_name: "data_subject_requests", grantee: "authenticated", privilege_type: "SELECT" },
    ]);
  });

  // service_role IS NOT A CLIENT ROLE, and since Phase 8 Task 4 it holds a
  // deliberate, COLUMN-LEVEL write on the register: the export job records
  // its outcome there (20260927003000 § 1), which is what finally gives the
  // psql suite's seam probe a positive control rather than a refusal by a
  // missing privilege. Asserted as the EXACT set of columns, so a third one
  // arriving is red -- and `fulfilment_recorded_at` is deliberately absent,
  // because the trigger stamps it and a BEFORE trigger may assign a column
  // the updating role holds no privilege on.
  it("service_role's write is EXACTLY the two seam columns plus the two notice stamps, and nothing on the notes", async () => {
    // The stamps since 20261015000000 (Task 9b job 2, Q157(3)/Q174/Q45):
    // written only after the requester's email was accepted, once, alone.
    const { rows } = await pool.query<{ table_name: string; column_name: string; privilege_type: string }>(
      `select distinct table_name, column_name, privilege_type from information_schema.column_privileges
        where table_schema = 'public'
          and table_name in ('data_subject_requests', 'data_subject_request_notes')
          and grantee = 'service_role' and privilege_type <> 'SELECT'
        order by table_name, column_name, privilege_type`,
    );
    expect(rows).toEqual([
      { table_name: "data_subject_requests", column_name: "closed_notified_at", privilege_type: "UPDATE" },
      { table_name: "data_subject_requests", column_name: "fulfilment_kind", privilege_type: "UPDATE" },
      { table_name: "data_subject_requests", column_name: "fulfilment_reference", privilege_type: "UPDATE" },
      { table_name: "data_subject_requests", column_name: "received_notified_at", privilege_type: "UPDATE" },
    ]);
  });
});

// =============================================================================
// PHASE 8 TASK 8: THE ERASURE REGISTER (OWN ROWS, WITH OPERATOR OVERSIGHT)
// =============================================================================
// `erasure_jobs` was registered in OWN_ROW_RELATIONS by Task 5 and then probed
// by NOTHING at the table layer -- the only assertions about it were the
// side-effect row count around start_erasure_for_request. Declared as an
// own-rows relation and never read as one is the invisible-denominator shape
// this whole file exists to refuse. The held job belongs to the no-workspace
// principal (a person with nothing that could block an erasure), and NOTHING
// in this file runs a runner: the invariant at the end of the block proves the
// account is still there.
describe("table erasure_jobs (own rows + operator oversight, Phase 8 Task 8)", () => {
  const readsIt = new Set(["noOrganisation", "superuserAal2"]);
  const everyone: { key: string; client: () => SupabaseClient }[] = [
    ...PRINCIPALS.map(({ key, client }) => ({ key: key as string, client })),
    { key: "superuserAal2", client: () => superuser },
  ];

  it("DENOMINATOR: the held job exists, is the no-workspace principal's, and is queued", async () => {
    const { rows } = await pool.query(
      `select subject_user_id, requested_by, kind, status from public.erasure_jobs where id = $1`,
      [ARGS.erasureJobId],
    );
    expect(rows).toEqual([
      { subject_user_id: noOrgUserId, requested_by: noOrgUserId, kind: "account", status: "queued" },
    ]);
  });

  it.each(everyone)("$key reads the held job only if it is theirs or they are the aal2 operator", async ({ key, client }) => {
    const { data, error } = await client().from("erasure_jobs").select("id").eq("id", ARGS.erasureJobId);
    if (key === "anonymous") {
      expect(error, "anon read the erasure register").not.toBeNull();
      expect(mechanismOf(error), error?.message).toBe("no-grant");
      return;
    }
    // RLS FILTER, not an error: the grant is there and the policy decides.
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length, key).toBe(readsIt.has(key) ? 1 : 0);
  });

  it.each(everyone)("$key cannot move, re-point or delete it -- the aal2 operator included", async ({ client }) => {
    const before = await tableChecksum("erasure_jobs");
    await client().from("erasure_jobs").update({ status: "succeeded" } as never).eq("id", ARGS.erasureJobId);
    await client()
      .from("erasure_jobs")
      .update({ subject_user_id: fx.activeByRole.read_only.userId } as never)
      .eq("id", ARGS.erasureJobId);
    await client().from("erasure_jobs").delete().eq("id", ARGS.erasureJobId);
    expect(await tableChecksum("erasure_jobs"), "a direct write changed the erasure register").toBe(before);
  });

  it("the insert names nobody: a forged subject is refused by the grant, and the honest insert is stamped", async () => {
    // A member of org A trying to erase SOMEBODY ELSE -- the IDOR the one-column
    // INSERT grant exists to make impossible.
    const forged = await fx.activeByRole.manager.client
      .from("erasure_jobs")
      .insert({ kind: "account", subject_user_id: noOrgUserId } as never);
    expect(forged.error, "erasure_jobs accepted a caller-chosen subject").not.toBeNull();
    expect(mechanismOf(forged.error), forged.error?.message).toBe("no-grant");
    // Same principal, honest body: admitted as far as the TRIGGER, which is
    // what proves the refusal above was the grant and not "a manager cannot
    // insert at all". Rolled straight back out; nothing runs it.
    const { data, error } = await fx.activeByRole.manager.client
      .from("erasure_jobs")
      .insert({ kind: "account" } as never)
      .select("id, subject_user_id, requested_by");
    expect(error, error?.message).toBeNull();
    const made = (data ?? []) as { id: string; subject_user_id: string; requested_by: string }[];
    expect(made[0]?.subject_user_id).toBe(fx.activeByRole.manager.userId);
    expect(made[0]?.requested_by).toBe(fx.activeByRole.manager.userId);
    await pool.query(`delete from public.erasure_jobs where id = $1`, [made[0].id]);
  });

  it("INVARIANT: nothing in this file erased the held job's subject", async () => {
    const { rows } = await pool.query(`select count(*)::int as n from auth.users where id = $1`, [noOrgUserId]);
    expect(rows[0].n).toBe(1);
  });
});

// =============================================================================
// PHASE 8 TASK 8: WHAT EACH PRINCIPAL MAY DO WITH ITS OWN RIGHTS
// =============================================================================
// Every block above asks what a principal is REFUSED. Phase 8's surfaces are
// mostly the other kind: a person's statutory rights over their own data,
// which must be AVAILABLE to anybody signed in -- including the two principals
// Phase 8 made meaningful: a member of a SUSPENDED workspace (suspension is
// read-only, and a statutory right is not a write to the workspace) and the
// platform superuser below aal2 (they are also a person). Each assertion names
// the mechanism that decides the answer.
describe("Phase 8: each principal's own rights, and the mechanism behind each answer", () => {
  it("anonymous: every rights RPC refuses, and by the missing session or grant -- never by a guard it reached", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["record_consent", { p_purpose: "marketing_email", p_action: "granted", p_policy_version: 1, p_statement: "marketing-email-1" }],
      ["submit_data_subject_request", { p_right_type: "access", p_subject_scope: "account", p_detail: "anon" }],
      ["withdraw_data_subject_request", { p_request_id: ARGS.dsrRequestId }],
      ["audit_export_download", { p_job_id: ARGS.exportJobId }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await fx.anonClient.rpc(fn, args as never);
      expect(error, `${fn} served anonymous`).not.toBeNull();
      expect(ANON_MECHANISMS.has(mechanismOf(error)), `${fn}: ${mechanismOf(error)} ${error?.message}`).toBe(true);
    }
    // my_erasure_blockers answers a sessionless caller with NO ROWS (asserted in
    // MEMBER_REACHABLE_RPCS' reason); measured here rather than trusted.
    const blockers = await fx.anonClient.rpc("my_erasure_blockers");
    if (blockers.error) {
      expect(ANON_MECHANISMS.has(mechanismOf(blockers.error)), blockers.error.message).toBe(true);
    } else {
      expect(blockers.data ?? []).toEqual([]);
    }
  });

  it("the SUSPENDED workspace's Owner records a consent, and it is theirs", async () => {
    const { rows } = await pool.query<{ version: number }>(
      `select version from public.legal_documents where slug = 'marketing-preferences' and status = 'published'`,
    );
    const { data, error } = await suspendedClient.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: rows[0].version,
      p_statement: "marketing-email-1",
    });
    expect(error, `a suspended member could not record their own consent: ${error?.message}`).toBeNull();
    const id = ((data ?? []) as { consent_id: string }[])[0]?.consent_id;
    const owner = await pool.query(`select user_id from public.consents where id = $1`, [id]);
    expect(owner.rows).toEqual([{ user_id: suspendedUserId }]);
  });

  it("the SUSPENDED workspace's Owner makes a data subject request, and it is theirs", async () => {
    const { data, error } = await suspendedClient.rpc("submit_data_subject_request", {
      p_right_type: "access",
      p_subject_scope: "account",
      p_detail: "matrix: a suspended workspace's member keeps their rights",
    });
    expect(error, `a suspended member could not exercise a statutory right: ${error?.message}`).toBeNull();
    const id = ((data ?? []) as { request_id: string }[])[0]?.request_id;
    const owner = await pool.query(`select user_id from public.data_subject_requests where id = $1`, [id]);
    expect(owner.rows).toEqual([{ user_id: suspendedUserId }]);
  });

  it("the SUSPENDED workspace's Owner exports their account AND their workspace (export_organisation_data survives suspension)", async () => {
    const account = await suspendedClient
      .from("export_jobs")
      .insert({ kind: "account" } as never)
      .select("id, requested_by");
    expect(account.error, `account export refused to a suspended member: ${account.error?.message}`).toBeNull();
    const workspace = await suspendedClient
      .from("export_jobs")
      .insert({ kind: "workspace", organisation_id: suspendedOrg.id } as never)
      .select("id, requested_by, organisation_id");
    expect(
      workspace.error,
      `the workspace export -- the one Phase 8 key that survives suspension -- was refused: ${workspace.error?.message}`,
    ).toBeNull();
    const ids = [
      ...((account.data ?? []) as { id: string }[]),
      ...((workspace.data ?? []) as { id: string }[]),
    ].map((r) => r.id);
    expect(ids).toHaveLength(2);
    await pool.query(`delete from public.export_jobs where id = any($1::uuid[])`, [ids]);
  });

  it("CONTROL: a SUSPENDED Owner still cannot export a workspace they are not in -- the RLS check, not the suspension", async () => {
    const { error } = await suspendedClient
      .from("export_jobs")
      .insert({ kind: "workspace", organisation_id: fx.orgA.id } as never);
    expect(error, "a suspended Owner exported a workspace they are not a member of").not.toBeNull();
  });

  it("the SUSPENDED workspace's Owner reads what would stop an erasure, and it names nobody else's workspace", async () => {
    const { data, error } = await suspendedClient.rpc("my_erasure_blockers");
    expect(error, error?.message).toBeNull();
    // Sole Owner of an EMPTY workspace: it goes with them (Q131), so nothing blocks.
    expect(data ?? []).toEqual([]);
  });

  it("the superuser BELOW aal2 is still a person: they record a consent and make a request of their own", async () => {
    const { rows } = await pool.query<{ version: number }>(
      `select version from public.legal_documents where slug = 'marketing-preferences' and status = 'published'`,
    );
    const consent = await superuserAal1Client.rpc("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: rows[0].version,
      p_statement: "marketing-email-1",
    });
    expect(consent.error, consent.error?.message).toBeNull();
    const dsr = await superuserAal1Client.rpc("submit_data_subject_request", {
      p_right_type: "access",
      p_subject_scope: "account",
      p_detail: "matrix: the operator's own account has these rights too",
    });
    expect(dsr.error, dsr.error?.message).toBeNull();
    const id = ((dsr.data ?? []) as { request_id: string }[])[0]?.request_id;
    const owner = await pool.query(`select user_id from public.data_subject_requests where id = $1`, [id]);
    expect(owner.rows).toEqual([{ user_id: fx.superuser.userId }]);
    // ...and, at aal1, still cannot OPERATE on it -- the guard's refusal.
    const op = await superuserAal1Client.rpc("transition_data_subject_request", {
      p_request_id: id,
      p_status: "in_progress",
    });
    expect(mechanismOf(op.error), op.error?.message).toBe("guard");
  });

  it("the DATA SUBJECT withdraws their own request; nobody else can, and the refusal is the trigger's", async () => {
    const { data, error } = await fx.activeByRole.read_only.client.rpc("submit_data_subject_request", {
      p_right_type: "objection",
      p_subject_scope: "account",
      p_detail: "matrix: withdrawal boundary",
    });
    expect(error, error?.message).toBeNull();
    const id = ((data ?? []) as { request_id: string }[])[0]!.request_id;
    for (const [who, client] of [
      ["orgOwner", fx.ownerA.client],
      ["suspendedMember", suspendedClient],
      ["superuserAal2", superuser],
    ] as const) {
      const { error: e } = await client.rpc("withdraw_data_subject_request", { p_request_id: id });
      expect(e, `${who} withdrew somebody else's request`).not.toBeNull();
    }
    const still = await pool.query(`select status from public.data_subject_requests where id = $1`, [id]);
    expect(still.rows).toEqual([{ status: "open" }]);
    const own = await fx.activeByRole.read_only.client.rpc("withdraw_data_subject_request", { p_request_id: id });
    expect(own.error, own.error?.message).toBeNull();
    const after = await pool.query(`select status from public.data_subject_requests where id = $1`, [id]);
    expect(after.rows).toEqual([{ status: "withdrawn" }]);
  });
});

// =============================================================================
// HELPERS
// =============================================================================
async function countRows(table: string | null): Promise<number> {
  if (table === null) return 0;
  const { rows } = await pool.query(`select count(*)::int as n from public.${table}`);
  return rows[0].n as number;
}

async function auditCount(): Promise<number> {
  const { rows } = await pool.query(`select count(*)::int as n from public.audit_events`);
  return rows[0].n as number;
}

/**
 * Put the legal document store back: delete the given versions and the audit
 * rows that name THEM (fix round 1, M8 -- this used to delete every
 * `legal_document` audit row in the database), and re-publish any version a
 * positive control superseded. The immutability guard refuses all of that for every role, by
 * design, so it runs with triggers off -- `session_replication_role =
 * replica`, the DBA escape hatch 20260922000000's header names -- inside one
 * transaction on one pooled connection, so the setting cannot leak.
 */
async function discardLegalRows(ids: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      `delete from public.audit_events where target_type = 'legal_document' and target_id = any($1::uuid[])`,
      [ids],
    );
    await client.query(`delete from public.legal_documents where id = any($1::uuid[])`, [ids]);
    // The newest superseded version of a slug left with no published one --
    // version 1 for both slugs this file borrows, but not assumed.
    await client.query(
      `update public.legal_documents d
          set status = 'published', superseded_at = null
        where d.status = 'superseded'
          and not exists (select 1 from public.legal_documents p
                           where p.slug = d.slug and p.status = 'published')
          and d.version = (select max(o.version) from public.legal_documents o
                            where o.slug = d.slug and o.status = 'superseded')`,
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Shared by grant_feature_override and revoke_feature_override's positive
 *  controls: a disposable flag on org A, so org B keeps the single active
 *  feature override principal 7 is defined by. */
async function grantAndRevokeFeatureOverrideOnOrgA(under: string): Promise<void> {
  const { data: id, error } = await superuser.rpc("grant_feature_override", {
    p_organisation_slug: fx.orgA.slug,
    p_flag_key: "early_access_preview",
    p_reason: `positive control for ${under}`,
    p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  expect(error, `grant_feature_override (${under}): ${error?.message}`).toBeNull();
  const revoked = await superuser.rpc("revoke_feature_override", {
    p_override_id: id as string,
    p_reason: "positive control cleanup",
  });
  expect(
    revoked.error,
    `revoke_feature_override (${under}) must be reachable by the aal2 superuser: ${revoked.error?.message}`,
  ).toBeNull();
}
