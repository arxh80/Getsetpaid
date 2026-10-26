// Phase 10 Task 21 (audit finding 4): Owners and Admins can remove a member,
// cancel an invitation and change a role.
//
// Drives the real `removeMemberAction` / `changeMemberRoleAction` against the
// real local stack. Only the Next request-context seams are mocked (the
// cookie-bound server client is swapped for a persona's signed-in client, and
// revalidatePath is a no-op); getCurrentOrg, the MFA gate, the policies, the
// keep-an-owner trigger and the audit triggers are all real. Each persona is
// the fixture's own signed-in client, so every refusal here is the database's.
//
// THE CONTROL IS THE DATABASE (coordinator decision 1). The actions write
// through the caller's RLS-bound client; a refused DELETE/UPDATE is matched
// either by 42501 or by ZERO ROWS (an Owner's row is filtered out of an
// Admin's USING clause, 20261106000000), and every refusal below also reads
// the row back as the Postgres superuser to prove nothing changed.
//
// MUTANTS (run 2026-10-23, recorded in the Task 21 ledger line). (1) Swapping
// the actions' client for the service-role client turns the five success
// cases red (5 failed / 4 passed), NOT the Booker case: service_role holds
// zero table grants on this schema (Task 4 design note (e)), so it fails
// closed for everyone. (2) Reading zero rows as success turns the Booker,
// foreign-id and Admin-vs-Owner cases red (3 failed / 6 passed): the zero-row
// refusal is the one piece of logic this file's actions own.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createFixtures,
  destroyFixtures,
  type Persona,
  type RlsFixtures,
} from "../rls/support/fixtures";
import { getLocalSupabaseStatus } from "../rls/support/env";

const current = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => current.client,
}));

import { changeMemberRoleAction, removeMemberAction } from "@/lib/org/actions";

const REFUSED = "You can’t change that member.";
const LAST_OWNER = "A workspace needs at least one active Owner.";

let fx: RlsFixtures;
let pool: Pool;

function as(p: Persona) {
  current.client = p.client;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function membership(orgId: string, userId: string) {
  const { rows } = await pool.query<{ id: string; role: string; status: string }>(
    `select id, role, status from public.organisation_memberships
      where organisation_id = $1 and user_id = $2`,
    [orgId, userId],
  );
  return rows[0] ?? null;
}

async function remove(p: Persona, slug: string, membershipId: string) {
  as(p);
  return removeMemberAction({}, form({ orgSlug: slug, membershipId }));
}

async function changeRole(p: Persona, slug: string, membershipId: string, role: string) {
  as(p);
  return changeMemberRoleAction({}, form({ orgSlug: slug, membershipId, role }));
}

async function contactsVisibleTo(client: SupabaseClient, orgId: string): Promise<number> {
  const { data, error } = await client.from("contacts").select("id").eq("organisation_id", orgId);
  expect(error).toBeNull();
  return data?.length ?? 0;
}

beforeAll(async () => {
  const status = getLocalSupabaseStatus();
  process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;

  fx = await createFixtures();
  pool = fx._pool;
  await pool.query(`insert into public.contacts (organisation_id, name) values ($1, 'Task 21 probe')`, [
    fx.orgA.id,
  ]);
}, 120_000);

afterAll(async () => {
  if (fx) await destroyFixtures(fx);
});

describe("member management (Task 21)", () => {
  it("a Booker calling either action is refused, with the row unchanged", async () => {
    const target = (await membership(fx.orgA.id, fx.activeByRole.marketing.userId))!;
    expect(target).toMatchObject({ role: "marketing", status: "active" });

    const removed = await remove(fx.activeByRole.booker, fx.orgA.slug, target.id);
    expect(removed.error).toBe(REFUSED);
    const changed = await changeRole(fx.activeByRole.booker, fx.orgA.slug, target.id, "read_only");
    expect(changed.error).toBe(REFUSED);

    expect(await membership(fx.orgA.id, fx.activeByRole.marketing.userId)).toEqual(target);
  });

  it("a foreign workspace's slug is refused, and so is a foreign membership id under one's own slug", async () => {
    const foreign = (await membership(fx.orgB.id, fx.ownerB.userId))!;
    expect(foreign.role).toBe("owner");

    // Org B's slug: ownerA is not a member, so the slug resolves to nothing.
    expect((await remove(fx.ownerA, fx.orgB.slug, foreign.id)).error).toBe(
      "That workspace isn’t available.",
    );
    // Org A's slug with org B's row: the organisation_id filter and the policy.
    expect((await remove(fx.ownerA, fx.orgA.slug, foreign.id)).error).toBe(REFUSED);
    expect((await changeRole(fx.ownerA, fx.orgA.slug, foreign.id, "read_only")).error).toBe(REFUSED);

    expect(await membership(fx.orgB.id, fx.ownerB.userId)).toEqual(foreign);
  });

  it("an Admin cannot remove or demote an Owner, nor promote anyone to Owner", async () => {
    const owner = (await membership(fx.orgA.id, fx.ownerA.userId))!;
    const admin = fx.activeByRole.admin;

    expect((await remove(admin, fx.orgA.slug, owner.id)).error).toBe(REFUSED);
    expect((await changeRole(admin, fx.orgA.slug, owner.id, "admin")).error).toBe(REFUSED);
    expect(await membership(fx.orgA.id, fx.ownerA.userId)).toEqual(owner);

    const self = (await membership(fx.orgA.id, admin.userId))!;
    expect((await changeRole(admin, fx.orgA.slug, self.id, "owner")).error).toBe(REFUSED);
    expect(await membership(fx.orgA.id, admin.userId)).toEqual(self);

    // Another member, not the Admin's own row: the refusal is the Owner term,
    // not a self-update guard. "An Owner may promote another member to Owner"
    // below is the positive control on the same kind of target.
    const other = (await membership(fx.orgA.id, fx.activeByRole.marketing.userId))!;
    expect((await changeRole(admin, fx.orgA.slug, other.id, "owner")).error).toBe(REFUSED);
    expect(await membership(fx.orgA.id, fx.activeByRole.marketing.userId)).toEqual(other);
  });

  it("the last active Owner cannot demote or remove themselves", async () => {
    const owner = (await membership(fx.orgA.id, fx.ownerA.userId))!;
    expect((await changeRole(fx.ownerA, fx.orgA.slug, owner.id, "admin")).error).toBe(LAST_OWNER);
    expect((await remove(fx.ownerA, fx.orgA.slug, owner.id)).error).toBe(LAST_OWNER);
    expect(await membership(fx.orgA.id, fx.ownerA.userId)).toEqual(owner);
  });

  it("a role outside the catalogue is refused before the database", async () => {
    const target = (await membership(fx.orgA.id, fx.activeByRole.marketing.userId))!;
    const result = await changeRole(fx.ownerA, fx.orgA.slug, target.id, "platform_superuser");
    expect(result.fieldErrors?.role).toBe("Choose a role.");
    expect(await membership(fx.orgA.id, fx.activeByRole.marketing.userId)).toEqual(target);
  });

  it("an Owner removes a Booker: the row is gone and the Booker then reads 0 contacts", async () => {
    const booker = fx.activeByRole.booker;
    expect(await contactsVisibleTo(booker.client, fx.orgA.id)).toBe(1);

    const row = (await membership(fx.orgA.id, booker.userId))!;
    const result = await remove(fx.ownerA, fx.orgA.slug, row.id);
    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();

    expect(await membership(fx.orgA.id, booker.userId)).toBeNull();
    expect(await contactsVisibleTo(booker.client, fx.orgA.id)).toBe(0);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.audit_events
        where organisation_id = $1 and action = 'membership.deleted' and target_id = $2`,
      [fx.orgA.id, row.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("an Admin changes a role, then removes that Booker", async () => {
    const admin = fx.activeByRole.admin;
    const target = (await membership(fx.orgA.id, fx.activeByRole.standard_user.userId))!;

    // A delta, not a total: the fixture's own setup already wrote one.
    const updates = async () =>
      (
        await pool.query<{ n: string }>(
          `select count(*)::text as n from public.audit_events
            where organisation_id = $1 and action = 'membership.updated' and target_id = $2`,
          [fx.orgA.id, target.id],
        )
      ).rows[0]?.n;
    const before = Number(await updates());

    const changed = await changeRole(admin, fx.orgA.slug, target.id, "booker");
    expect(changed.error).toBeUndefined();
    expect((await membership(fx.orgA.id, fx.activeByRole.standard_user.userId))?.role).toBe("booker");
    expect(Number(await updates())).toBe(before + 1);

    const removed = await remove(admin, fx.orgA.slug, target.id);
    expect(removed.error).toBeUndefined();
    expect(await membership(fx.orgA.id, fx.activeByRole.standard_user.userId)).toBeNull();
  });

  it("an Owner may promote another member to Owner", async () => {
    const venueManager = (await membership(fx.orgA.id, fx.activeByRole.venue_manager.userId))!;
    expect((await changeRole(fx.ownerA, fx.orgA.slug, venueManager.id, "owner")).error).toBeUndefined();
    expect((await membership(fx.orgA.id, fx.activeByRole.venue_manager.userId))?.role).toBe("owner");

    // Put it back so the last-owner case above stays the fixture's truth for
    // any test added after this one.
    expect((await changeRole(fx.ownerA, fx.orgA.slug, venueManager.id, "venue_manager")).error).toBeUndefined();
  });

  it("cancelling a pending invite deletes the row", async () => {
    const invite = (await membership(fx.orgA.id, fx.invitedAdminA.userId))!;
    expect(invite.status).toBe("invited");

    const result = await remove(fx.ownerA, fx.orgA.slug, invite.id);
    expect(result.error).toBeUndefined();
    expect(await membership(fx.orgA.id, fx.invitedAdminA.userId)).toBeNull();
  });
});
