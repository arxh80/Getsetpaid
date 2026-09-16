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
// THAT IS NOT TESTED HERE, by any test this task added. It is a real gap and it
// is mitigated rather than closed, for one specific structural reason: NO
// module under `lib/admin/` constructs a service-role client (`createServiceClient`
// appears nowhere in that tree), so every one of those actions is enforced by
// the RPC and table layers THIS file probes, one layer down -- eleven are thin
// wrappers over the guarded RPCs above, and `resolveIncidentAlertAction` /
// `updateFeedbackStatusAction` are plain RLS-gated `.update()`s covered by the
// table-layer UPDATE probe (which asserts an md5 of the whole table, not a row
// count). The residual is a FUTURE action that reaches for `createServiceClient()`
// and is gated only by `isSuperuser()`: that action would bypass both layers
// this file measures, and nothing here would notice. Queued as Q126, whose
// recommended default is a source census asserting no module under `lib/admin/`
// imports the service-role client.
//
// -----------------------------------------------------------------------------
// WHAT THE TWO RED MUTATIONS PROVE, AND WHAT EACH DOES NOT
// -----------------------------------------------------------------------------
// `private.has_platform_permission()` is a conjunction of two terms. Dropping
// EITHER, in the running database only, is a mutation this suite is measured
// against -- and the two answers are different in a way that matters:
//
//   1. Drop `private.session_is_aal2()`, keeping the platform_admins term:
//      23 of 224 red. This can only move ONE of the seven principals -- a
//      caller who is on the allowlist and below aal2, i.e. `superuserAal1` --
//      so 21 of the 23 are that principal (12 RPC refusals, 8 table reads, 1
//      table write) and 2 are cascade. The GRANT layer necessarily goes 0 red,
//      because grants do not read that function. It says nothing about the
//      Owner rows, Read Only, no-org or anonymous.
//   2. Drop the `platform_admins` term, keeping `session_is_aal2()`:
//      53 of 224 red, ALL of them the three Owner principals (33 RPC refusals,
//      19 table reads, 1 table write). THIS is the mutation that proves the
//      plan's named case -- "unreachable by a non-superuser, EVEN AN ORG
//      OWNER" -- is a measurement and not an argument, and it proves as a side
//      effect that the Owner fixtures genuinely reach aal2: an aal1 Owner
//      would not have gone red at all.
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
  type RlsFixtures,
} from "../rls/support/fixtures";

// The SQLSTATEs a Phase 7 guard refuses with. 42501 is the house code for
// "caller is not the platform superuser at aal2" (every Phase 7 guard raises
// it), 28000 for "no session", and 42501 again for a missing EXECUTE grant.
// PGRST202 is PostgREST's "no such function in the exposed schema", which is
// what `anon` gets when a function it holds no grant on is not even in its
// schema cache view.
const REFUSAL_CODES = new Set(["42501", "28000", "PGRST202", "PGRST301", "P0001"]);

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
   * superuser, the guard is the only thing between the caller and success, and
   * the same mutation reds it.
   */
  acceptedImpersonationSessionId: "",
  billingOverrideId: "",
  featureOverrideId: "",
  feedbackId: "",
  incidentAlertId: "",
};

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
];

/**
 * RPCs Phase 7 added that are DELIBERATELY reachable by an ordinary member,
 * named here rather than omitted so the inventory assertion below can account
 * for every granted function and so the boundary is asserted rather than
 * skipped (the brief: "if a surface is deliberately member-reachable, the
 * expected value says so ... and the test asserts that boundary").
 */
const MEMBER_REACHABLE_RPCS: Record<string, string> = {
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

const PHASE7_TABLES = [
  "feedback",
  "impersonation_sessions",
  "incident_alerts",
  "organisation_billing_overrides",
  "organisation_feature_overrides",
  "rate_limit_counters",
  "rate_limit_policies",
] as const;

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
}, 180_000);

afterAll(async () => {
  if (!fx) return;
  await pool.query(`delete from public.incident_alerts where id = $1`, [
    ARGS.incidentAlertId,
  ]);
  await pool.query(
    `delete from public.audit_events where target_type = 'feedback' and target_id = $1`,
    [ARGS.feedbackId],
  );
  await pool.query(`delete from public.feedback where id = $1`, [ARGS.feedbackId]);
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
    const { rows } = await pool.query<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(p.proacl) ax
        where n.nspname = 'public'
          and ax.privilege_type = 'EXECUTE'
          and pg_get_userbyid(ax.grantee) = 'authenticated'`,
    );
    const granted = rows.map((r) => r.proname).sort();
    const accounted = [
      ...SUPERUSER_ONLY_RPCS.map((r) => r.fn),
      ...Object.keys(MEMBER_REACHABLE_RPCS),
      ...Object.keys(PRE_PHASE7_RPCS),
    ].sort();
    expect(
      granted,
      "a function `authenticated` may EXECUTE in `public` is on neither this " +
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

  it("every relation `authenticated` holds a grant on in `public` is accounted for", async () => {
    // The same census, at the read layer, and the half that was weakest:
    // `PHASE7_TABLES` was a hardcoded literal with nothing derived from
    // `pg_class` at all, so a Phase 8 table granted to `authenticated` was
    // invisible to this file entirely. Views are included deliberately --
    // `network_directory` is how Phase 6 exposes the network, so a view is
    // exactly as much of a read surface as a table.
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; relkind: string }>(
      `select c.relname, c.relrowsecurity, c.relkind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r','p','v','m')
          and exists (select 1 from aclexplode(c.relacl) ax
                       where pg_get_userbyid(ax.grantee) = 'authenticated')`,
    );
    const granted = rows.map((r) => r.relname).sort();
    expect(
      granted,
      "a relation `authenticated` holds a grant on in `public` is on neither " +
        "PHASE7_TABLES nor PRE_PHASE7_RELATIONS. A platform table added by a " +
        "later phase belongs in the first (and gets probed by every principal); " +
        "a tenant one belongs in the second with its reason.",
    ).toEqual([...PHASE7_TABLES, ...PRE_PHASE7_RELATIONS].sort());

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
  return table.startsWith("rate_limit_") ? "category" : "id";
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
