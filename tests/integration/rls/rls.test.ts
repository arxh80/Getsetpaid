// Foundation-phase RLS / permission-engine integration suite -- the durable
// regression counterpart to Task 4's one-off psql harness
// (supabase/tests/rls_foundation.sql + run-rls-tests.sh, left untouched as
// historical record).
//
// WHERE THIS SUITE DIFFERS ON PURPOSE
//   The psql suite proves the policies are correct at the database layer.
//   This suite proves the SAME guarantees hold through the path the real
//   application actually uses: @supabase/supabase-js signed in as a real
//   auth.users session, talking HTTP to the local PostgREST instance. It is
//   not a re-run of the SQL assertions -- see tests/integration/rls/support/
//   fixtures.ts for how personas/orgs are built through real RPC/INSERT
//   calls wherever a client path exists at all.
//
// A NOTE ON "DENIED" VS "EMPTY"
//   Exactly like rls_foundation.sql's harness.try/val distinction: a
//   statement can fail two structurally different ways under RLS --
//     - denied: the GRANT layer or a WITH CHECK/USING violation rejects the
//       statement outright (Postgres error, surfaced by PostgREST as
//       `error.code` -- almost always '42501' here).
//     - filtered-empty: the statement is accepted (grant exists) but RLS's
//       USING clause matches zero rows, so a SELECT returns `[]` and an
//       UPDATE/DELETE reports 0 affected rows, with `error` null both times.
//   Both are secure outcomes but they are different mechanisms, and getting
//   the expectation backwards is exactly the kind of thing that turns into a
//   silent false pass (a broken query that "happens" to return nothing looks
//   identical to a correctly-denied one unless you assert on the RIGHT
//   thing). Every assertion below is explicit about which one it expects,
//   and every "returns nothing" assertion has a same-table positive control
//   nearby proving the query mechanism itself works.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_ROLES,
  createFixtures,
  destroyFixtures,
  type Persona,
  type RlsFixtures,
  type RoleKey,
} from "./support/fixtures";

let fx: RlsFixtures;

beforeAll(async () => {
  fx = await createFixtures();
}, 60_000);

afterAll(async () => {
  await destroyFixtures(fx);
}, 60_000);

/** role_permissions seeded in 20260826202023_reference_data.sql: only owner
 * and admin hold manage_members/manage_organisation. No role holds
 * manage_billing or view_audit_log -- those are platform-only, checked via
 * has_platform_permission(), never granted through an org role. */
const ORG_PERMISSION_GRANTS: Record<RoleKey, { manage_members: boolean; manage_organisation: boolean }> = {
  owner: { manage_members: true, manage_organisation: true },
  admin: { manage_members: true, manage_organisation: true },
  manager: { manage_members: false, manage_organisation: false },
  booker: { manage_members: false, manage_organisation: false },
  venue_manager: { manage_members: false, manage_organisation: false },
  finance: { manage_members: false, manage_organisation: false },
  marketing: { manage_members: false, manage_organisation: false },
  standard_user: { manage_members: false, manage_organisation: false },
  read_only: { manage_members: false, manage_organisation: false },
};

function personaFor(role: RoleKey): Persona {
  return role === "owner" ? fx.ownerA : fx.activeByRole[role];
}

// ---------------------------------------------------------------------------
// A. Cross-tenant denial across every Task 3/4 tenant-owned table
// ---------------------------------------------------------------------------
describe("A. cross-tenant denial", () => {
  describe("organisations", () => {
    it("A1 org A owner cannot SELECT org B by id (filtered empty)", async () => {
      const { data, error } = await fx.ownerA.client
        .from("organisations")
        .select("id")
        .eq("id", fx.orgB.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("A1p positive control: org A owner CAN select her own org by id", async () => {
      const { data, error } = await fx.ownerA.client
        .from("organisations")
        .select("id")
        .eq("id", fx.orgA.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("A2 no client INSERT into organisations at all (denied, not merely cross-tenant)", async () => {
      const { error } = await fx.ownerA.client
        .from("organisations")
        .insert({ name: "Sneaky", slug: `sneaky-${fx.runId}` });
      expect(error?.code).toBe("42501");
    });

    it("A3 org A owner's UPDATE of org B's row matches 0 rows (RLS-filtered, not an error)", async () => {
      const { data, error, count } = await fx.ownerA.client
        .from("organisations")
        .update({ name: "Pwned" }, { count: "exact" })
        .eq("id", fx.orgB.id)
        .select();
      expect(error).toBeNull();
      expect(count).toBe(0);
      expect(data).toEqual([]);
    });

    it("A3p positive control: org A owner CAN rename her own org", async () => {
      const { data, error, count } = await fx.ownerA.client
        .from("organisations")
        .update({ name: `Org A renamed ${fx.runId}` }, { count: "exact" })
        .eq("id", fx.orgA.id)
        .select();
      expect(error).toBeNull();
      expect(count).toBe(1);
      expect(data?.[0]?.name).toBe(`Org A renamed ${fx.runId}`);
    });

    it("A4 no DELETE grant on organisations for anyone, own org or not", async () => {
      const { error } = await fx.ownerA.client
        .from("organisations")
        .delete({ count: "exact" })
        .eq("id", fx.orgB.id);
      expect(error?.code).toBe("42501");
    });
  });

  describe("organisation_memberships", () => {
    it("B1 org A owner's SELECT scoped to org B returns nothing", async () => {
      const { data, error } = await fx.ownerA.client
        .from("organisation_memberships")
        .select("id")
        .eq("organisation_id", fx.orgB.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("B2 org A admin cannot INSERT a membership into org B (denied)", async () => {
      const admin = fx.activeByRole.admin;
      const { error } = await admin.client.from("organisation_memberships").insert({
        organisation_id: fx.orgB.id,
        user_id: fx.ownerA.userId,
        role: "standard_user",
        status: "invited",
      });
      expect(error?.code).toBe("42501");
    });

    it("B3 org A admin's UPDATE targeting org B's owner membership matches 0 rows", async () => {
      const admin = fx.activeByRole.admin;
      const { error, count } = await admin.client
        .from("organisation_memberships")
        .update({ role: "read_only" }, { count: "exact" })
        .eq("user_id", fx.ownerB.userId);
      expect(error).toBeNull();
      expect(count).toBe(0);
    });

    it("B4 org A admin's DELETE targeting org B's owner membership matches 0 rows", async () => {
      const admin = fx.activeByRole.admin;
      const { error, count } = await admin.client
        .from("organisation_memberships")
        .delete({ count: "exact" })
        .eq("user_id", fx.ownerB.userId);
      expect(error).toBeNull();
      expect(count).toBe(0);
      // OUTCOME check, not just "the statement claimed 0" -- confirm from
      // org B's own owner session that the row genuinely survived.
      const { data: stillThere } = await fx.ownerB.client
        .from("organisation_memberships")
        .select("id")
        .eq("user_id", fx.ownerB.userId);
      expect(stillThere).toHaveLength(1);
    });
  });

  describe("organisation_subscriptions", () => {
    it("C1 org A owner's SELECT scoped to org B's subscription returns nothing", async () => {
      const { data, error } = await fx.ownerA.client
        .from("organisation_subscriptions")
        .select("id")
        .eq("organisation_id", fx.orgB.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("C1p positive control: org A owner CAN read her own org's subscription", async () => {
      const { data, error } = await fx.ownerA.client
        .from("organisation_subscriptions")
        .select("plan_id")
        .eq("organisation_id", fx.orgA.id);
      expect(error).toBeNull();
      expect(data).toEqual([{ plan_id: "pro" }]);
    });

    it("C2 org A owner cannot INSERT a subscription for org B (platform-only write, denied)", async () => {
      const { error } = await fx.ownerA.client.from("organisation_subscriptions").insert({
        organisation_id: fx.orgB.id,
        plan_id: "pro",
        billing_cycle: "monthly",
        seat_count: 1,
        status: "active",
        current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(error?.code).toBe("42501");
    });

    it("C3 org A owner's UPDATE targeting org B's subscription matches 0 rows (not platform admin)", async () => {
      const { error, count } = await fx.ownerA.client
        .from("organisation_subscriptions")
        .update({ seat_count: 99 }, { count: "exact" })
        .eq("organisation_id", fx.orgB.id);
      expect(error).toBeNull();
      expect(count).toBe(0);
    });

    it("C4 no DELETE grant on organisation_subscriptions for anyone", async () => {
      const { error } = await fx.ownerA.client
        .from("organisation_subscriptions")
        .delete({ count: "exact" })
        .eq("organisation_id", fx.orgB.id);
      expect(error?.code).toBe("42501");
    });
  });

  describe("profiles (identity boundary: own row + fellow-active-member only)", () => {
    it("D1 org B owner cannot see an org-A-only member's profile (no shared active org)", async () => {
      const { data, error } = await fx.ownerB.client
        .from("profiles")
        .select("id")
        .eq("id", fx.activeByRole.finance.userId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("D1p positive control: org A owner sees a fellow ACTIVE org A member's profile", async () => {
      const { data, error } = await fx.ownerA.client
        .from("profiles")
        .select("id")
        .eq("id", fx.activeByRole.finance.userId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("D2 cross-user UPDATE matches 0 rows (own-row-only policy, unrelated to org sharing)", async () => {
      const { error, count } = await fx.ownerB.client
        .from("profiles")
        .update({ full_name: "Owned" }, { count: "exact" })
        .eq("id", fx.activeByRole.finance.userId);
      expect(error).toBeNull();
      expect(count).toBe(0);
    });

    it("D3 no client INSERT into profiles", async () => {
      const { error } = await fx.ownerA.client
        .from("profiles")
        .insert({ id: fx.ownerA.userId, full_name: "Ghost" });
      expect(error?.code).toBe("42501");
    });

    it("D4 no client DELETE from profiles, even own row", async () => {
      const { error } = await fx.ownerA.client
        .from("profiles")
        .delete({ count: "exact" })
        .eq("id", fx.ownerA.userId);
      expect(error?.code).toBe("42501");
    });
  });
});

// ---------------------------------------------------------------------------
// B. Full role x permission matrix
// ---------------------------------------------------------------------------
describe("B. role x permission matrix (has_permission)", () => {
  for (const role of ALL_ROLES) {
    const persona = () => personaFor(role);

    it(`${role}: manage_members = ${ORG_PERMISSION_GRANTS[role].manage_members}`, async () => {
      const { data, error, status } = await persona().client.rpc("has_permission", {
        p_org_id: fx.orgA.id,
        p_permission: "manage_members",
      });
      expect(error).toBeNull();
      expect(status).toBe(200);
      expect(data).toBe(ORG_PERMISSION_GRANTS[role].manage_members);
    });

    it(`${role}: manage_organisation = ${ORG_PERMISSION_GRANTS[role].manage_organisation}`, async () => {
      const { data, error } = await persona().client.rpc("has_permission", {
        p_org_id: fx.orgA.id,
        p_permission: "manage_organisation",
      });
      expect(error).toBeNull();
      expect(data).toBe(ORG_PERMISSION_GRANTS[role].manage_organisation);
    });

    // manage_billing and view_audit_log are NOT org-role permissions at all
    // (no role_permissions row grants either key to any role -- they are
    // platform-only, gated by has_platform_permission()). Every role,
    // including owner and admin, must get `false` from the org-scoped path.
    it(`${role}: manage_billing = false (platform-only key, no org role ever grants it)`, async () => {
      const { data, error } = await persona().client.rpc("has_permission", {
        p_org_id: fx.orgA.id,
        p_permission: "manage_billing",
      });
      expect(error).toBeNull();
      expect(data).toBe(false);
    });

    it(`${role}: view_audit_log = false (platform-only key, no org role ever grants it)`, async () => {
      const { data, error } = await persona().client.rpc("has_permission", {
        p_org_id: fx.orgA.id,
        p_permission: "view_audit_log",
      });
      expect(error).toBeNull();
      expect(data).toBe(false);
    });
  }

  it("NULL org id never means platform level, fail-closed for every caller", async () => {
    const { data, error } = await fx.ownerA.client.rpc("has_permission", {
      p_org_id: null,
      p_permission: "manage_members",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("a permission held in org A does not satisfy a check against org B", async () => {
    const { data, error } = await fx.ownerA.client.rpc("has_permission", {
      p_org_id: fx.orgB.id,
      p_permission: "manage_members",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. Membership status gating: invited must never pass what active passes
// ---------------------------------------------------------------------------
describe("C. membership status gating (invited vs active)", () => {
  // Same role (admin) on both sides, isolating STATUS as the only variable:
  // fx.invitedAdminA (role=admin, status='invited', never activated) vs
  // fx.activeByRole.admin (role=admin, status='active').
  it("invited admin: manage_members is false despite admin normally granting it", async () => {
    const { data, error } = await fx.invitedAdminA.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_members",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("invited admin: manage_organisation is false despite admin normally granting it", async () => {
    const { data, error } = await fx.invitedAdminA.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_organisation",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("active admin (same role, active status): manage_members is true (positive control)", async () => {
    const { data, error } = await fx.activeByRole.admin.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_members",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("active admin (same role, active status): manage_organisation is true (positive control)", async () => {
    const { data, error } = await fx.activeByRole.admin.client.rpc("has_permission", {
      p_org_id: fx.orgA.id,
      p_permission: "manage_organisation",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("invited admin sees 0 organisations (RLS keys off active status, not role)", async () => {
    const { data, error } = await fx.invitedAdminA.client.from("organisations").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("invited admin still sees her own membership row (pending invite is visible to the invitee)", async () => {
    const { data, error } = await fx.invitedAdminA.client
      .from("organisation_memberships")
      .select("status")
      .eq("user_id", fx.invitedAdminA.userId);
    expect(error).toBeNull();
    expect(data).toEqual([{ status: "invited" }]);
  });

  it("invited admin cannot self-activate (Task 6's accept-invite flow doesn't exist yet)", async () => {
    const { error, count } = await fx.invitedAdminA.client
      .from("organisation_memberships")
      .update({ status: "active", joined_at: new Date().toISOString() }, { count: "exact" })
      .eq("user_id", fx.invitedAdminA.userId);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D. Superuser-only tables/paths
// ---------------------------------------------------------------------------
describe("D. superuser-only tables", () => {
  it("audit_events: an org OWNER (highest org role) sees 0 rows, RLS-filtered not denied", async () => {
    const { data, error } = await fx.ownerA.client.from("audit_events").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("audit_events: an active admin also sees 0 rows", async () => {
    const { data, error } = await fx.activeByRole.admin.client
      .from("audit_events")
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("audit_events: platform superuser CAN read rows across BOTH orgs (positive control, proves the owner-sees-0 result above is real denial, not a broken query)", async () => {
    const { data, error } = await fx.superuser.client
      .from("audit_events")
      .select("organisation_id, action")
      .eq("action", "organisation.created");
    expect(error).toBeNull();
    const orgIds = new Set((data ?? []).map((r: { organisation_id: string }) => r.organisation_id));
    expect(orgIds.has(fx.orgA.id)).toBe(true);
    expect(orgIds.has(fx.orgB.id)).toBe(true);
  });

  it("organisation_subscriptions: org owner cannot write even her own org's subscription (platform-only, not org-scoped)", async () => {
    const { error, count } = await fx.ownerA.client
      .from("organisation_subscriptions")
      .update({ seat_count: 42 }, { count: "exact" })
      .eq("organisation_id", fx.orgA.id);
    // USING requires has_platform_permission -> false -> RLS filters the row
    // (0 rows), it does not raise, because UPDATE is GRANTed to authenticated.
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it("organisation_subscriptions: platform superuser's writes during fixture setup actually landed (positive control)", async () => {
    const { data, error } = await fx.superuser.client
      .from("organisation_subscriptions")
      .select("organisation_id, plan_id")
      .in("organisation_id", [fx.orgA.id, fx.orgB.id]);
    expect(error).toBeNull();
    const byOrg = Object.fromEntries((data ?? []).map((r: { organisation_id: string; plan_id: string }) => [r.organisation_id, r.plan_id]));
    expect(byOrg[fx.orgA.id]).toBe("pro");
    expect(byOrg[fx.orgB.id]).toBe("starter");
  });

  it("platform_admins: totally unreachable via the client for an ordinary owner", async () => {
    const { error } = await fx.ownerA.client.from("platform_admins").select("*");
    expect(error?.code).toBe("42501");
  });

  it("platform_admins: unreachable even for the superuser's OWN client session (DBA-only table, zero client policies)", async () => {
    const { error } = await fx.superuser.client.from("platform_admins").select("*");
    expect(error?.code).toBe("42501");
  });

  it("platform_admins: superuser cannot self-add another row via the client either", async () => {
    const { error } = await fx.superuser.client
      .from("platform_admins")
      .insert({ user_id: fx.ownerA.userId });
    expect(error?.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// E. audit_events is insert-only via the client path, for every role tested
// ---------------------------------------------------------------------------
describe("E. audit_events is insert-only (no client write path at all)", () => {
  const writers: Array<[string, () => Persona]> = [
    ["org owner", () => fx.ownerA],
    ["org admin", () => fx.activeByRole.admin],
    ["platform superuser", () => fx.superuser],
  ];

  for (const [label, getPersona] of writers) {
    it(`${label} cannot INSERT into audit_events directly (no INSERT grant)`, async () => {
      const persona = getPersona();
      const { error } = await persona.client.from("audit_events").insert({
        organisation_id: fx.orgA.id,
        actor_user_id: persona.userId,
        action: "forged.action",
        target_type: "organisation",
        correlation_id: fx.orgA.id, // any uuid; not validated client-side
      });
      expect(error?.code).toBe("42501");
    });

    // Filtered by organisation_id (a real row -- the fixture-setup
    // organisation.created audit event -- so this is a genuinely TARGETED
    // attempt, not a no-op). An unfiltered update/delete is intercepted by
    // PostgREST's own "requires a WHERE clause" safety net (SQLSTATE 21000)
    // before it ever reaches Postgres, which would test the wrong layer.
    it(`${label} cannot UPDATE audit_events (append-only, no UPDATE grant)`, async () => {
      const { error } = await getPersona().client
        .from("audit_events")
        .update({ action: "tampered" }, { count: "exact" })
        .eq("organisation_id", fx.orgA.id);
      expect(error?.code).toBe("42501");
    });

    it(`${label} cannot DELETE from audit_events (append-only, no DELETE grant)`, async () => {
      const { error } = await getPersona().client
        .from("audit_events")
        .delete({ count: "exact" })
        .eq("organisation_id", fx.orgA.id);
      expect(error?.code).toBe("42501");
    });
  }

  it("log_audit_event is not reachable as a client RPC at all (private schema, no EXECUTE grant)", async () => {
    const { error, status } = await fx.ownerA.client.rpc("log_audit_event", {
      p_action: "forged.action",
      p_target_type: "organisation",
    });
    expect(status).toBe(404);
    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F. private-schema SECURITY DEFINER helpers are unreachable as RPCs
// ---------------------------------------------------------------------------
describe("F. private schema helpers are not routable HTTP endpoints", () => {
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";
  const privateRpcs: Array<[string, Record<string, unknown>]> = [
    ["membership_update_is_permitted", {
      p_id: NIL_UUID,
      p_organisation_id: NIL_UUID,
      p_user_id: NIL_UUID,
      p_status: "active",
      p_joined_at: null,
    }],
    ["has_platform_permission", { p_permission: "view_audit_log" }],
    ["is_active_member", { p_org_id: "00000000-0000-0000-0000-000000000000" }],
    ["shares_active_organisation", { p_user_id: "00000000-0000-0000-0000-000000000000" }],
    ["log_audit_event", { p_action: "x", p_target_type: "y" }],
  ];

  for (const [fn, args] of privateRpcs) {
    it(`${fn} is 404 (not in an exposed schema) for an authenticated caller`, async () => {
      const { status } = await fx.ownerA.client.rpc(fn, args);
      expect(status).toBe(404);
    });

    it(`${fn} is 404 for anon too (schema exposure, not a permission check)`, async () => {
      const { status } = await fx.anonClient.rpc(fn, args);
      expect(status).toBe(404);
    });
  }

  it("POSITIVE CONTROL: create_organisation IS routable (400 on an invalid slug, not 404)", async () => {
    const { status, error } = await fx.ownerA.client.rpc("create_organisation", {
      p_name: "X",
      p_slug: "!",
    });
    expect(status).toBe(400);
    expect(error).not.toBeNull();
  });

  it("POSITIVE CONTROL: has_permission IS routable (200, SECURITY INVOKER + self-scoped)", async () => {
    const { status, data, error } = await fx.ownerA.client.rpc("has_permission", {
      p_org_id: null,
      p_permission: "manage_members",
    });
    expect(status).toBe(200);
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});
