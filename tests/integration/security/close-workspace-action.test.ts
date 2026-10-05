// closeMyWorkspaceAction against a REAL database (Phase 8 Task 9c job 3b).
//
// The unit suite proves the action's own refusals with the RPC stubbed. This
// file proves the layer BELOW it: when the app-side Owner check is LIED TO --
// getCurrentOrg() mocked to say "owner", step-up and aal2 mocked fresh -- the
// real public.close_my_workspace() still refuses a non-Owner, through the
// action, and the workspace row, its closure backup and its audit trail are
// all unchanged. That is "hiding UI is not enforcement" measured, and it is
// the forged-POST half of the e2e walk without a browser.
//
// DENOMINATOR: the refused callers are a real Admin at aal2 (the strongest
// non-Owner there is -- `manage_organisation`, MFA satisfied) and a Manager at
// aal1. The positive half -- the same action reaching the RPC and closing a
// workspace for its real Owner -- is tests/e2e/workspace-closure.spec.ts, so
// the refusals here are the RPC's own and not an unwired call: each one is
// asserted to carry the RPC's HINT-mapped sentence, which only a round trip
// that reached the function can produce.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createFixtures, destroyFixtures, type RlsFixtures } from "../rls/support/fixtures";
import { getLocalSupabaseStatus } from "../rls/support/env";

const current = vi.hoisted(() => ({
  userId: "",
  client: null as unknown,
  org: null as null | {
    id: string;
    name: string;
    slug: string;
    role: string;
    isSuspended: boolean;
    isImpersonated: boolean;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => (current.userId ? { id: current.userId } : null),
  // THE LIE: whoever is signed in, the app layer is told they are the Owner.
  getCurrentOrg: async (slug: string) => (current.org && current.org.slug === slug ? current.org : null),
}));
vi.mock("@/lib/auth/step-up-gate", () => ({
  checkStepUp: async () => true,
  sessionIsAal2: async () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

import { closeMyWorkspaceAction } from "@/lib/org/closure-actions";
import { CLOSE_MESSAGES } from "@/lib/org/closure-contract";
import { EMPTY_FORM_STATE } from "@/lib/forms";

let fx: RlsFixtures;
let pool: Pool;

async function snapshot(orgId: string) {
  const { rows } = await pool.query<{ state: string; deleted: boolean; backups: string; audits: string }>(
    `select o.lifecycle_state as state,
            o.deleted_at is not null as deleted,
            (select count(*)::text from public.export_jobs j
              where j.organisation_id = o.id and j.closure_backup) as backups,
            (select count(*)::text from public.audit_events a
              where a.organisation_id = o.id and a.action = 'organisation.closed_by_owner') as audits
       from public.organisations o where o.id = $1`,
    [orgId],
  );
  return rows[0];
}

function form(slug: string): FormData {
  const data = new FormData();
  data.set("orgSlug", slug);
  data.set("confirmSlug", slug);
  data.set("reason", "Integration: a forged close by a non-Owner");
  return data;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
  fx = await createFixtures();
  pool = fx._pool;
  current.org = {
    id: fx.orgA.id,
    name: fx.orgA.slug,
    slug: fx.orgA.slug,
    role: "owner",
    isSuspended: false,
    isImpersonated: false,
  };
}, 120_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

describe("closeMyWorkspaceAction with the app-side Owner check lied to", () => {
  it("DENOMINATOR: org A starts active, with no closure backup and no closure audit row", async () => {
    expect(await snapshot(fx.orgA.id)).toEqual({ state: "active", deleted: false, backups: "0", audits: "0" });
  });

  it("an Admin at aal2 is refused BY THE RPC (close_needs_an_owner) and nothing changes", async () => {
    current.userId = fx.activeByRole.admin.userId;
    current.client = fx.activeByRole.admin.client;
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(fx.orgA.slug));
    expect(out.error).toBe(CLOSE_MESSAGES.notOwner);
    expect(out.message).toBeUndefined();
    expect(await snapshot(fx.orgA.id)).toEqual({ state: "active", deleted: false, backups: "0", audits: "0" });
  });

  it("a Manager at aal1 is refused BY THE RPC (close_needs_step_up) and nothing changes", async () => {
    current.userId = fx.activeByRole.manager.userId;
    current.client = fx.activeByRole.manager.client;
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(fx.orgA.slug));
    // aal2 is checked before the Owner row (20261021000000), so an aal1
    // non-Owner reads the two-step sentence -- the RPC's answer, not ours,
    // because sessionIsAal2 is mocked true above.
    expect(out.error).toBe(CLOSE_MESSAGES.aal2);
    expect(await snapshot(fx.orgA.id)).toEqual({ state: "active", deleted: false, backups: "0", audits: "0" });
  });

  it("org B's Owner at aal2, aimed at org A, is refused and org A is unchanged", async () => {
    current.userId = fx.ownerB.userId;
    current.client = fx.ownerB.client;
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(fx.orgA.slug));
    expect(out.error).toBe(CLOSE_MESSAGES.notOwner);
    expect(await snapshot(fx.orgA.id)).toEqual({ state: "active", deleted: false, backups: "0", audits: "0" });
  });
});
