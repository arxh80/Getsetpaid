// PHASE 8 TASK 2 -- THE SENDER'S CONSENT CHECK, AGAINST THE REAL DATABASE.
//
// lib/consent/marketing.ts is what every future marketing sender must call.
// This drives it the way a sender will: with a service-role client and a user
// id, while a real user records grants and withdrawals through the real RPC
// under their own session. The ledger's own rules are proved in
// supabase/tests/rls_phase8_consents.sql; this proves the helper reads them
// right, fails closed, and cannot be used from a user session.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import {
  MarketingConsentMissingError,
  assertMarketingConsent,
  hasMarketingConsent,
} from "@/lib/consent/marketing";
import { MARKETING_EMAIL } from "@/lib/consent/catalogue";

const env = getLocalSupabaseStatus();
const pool = new Pool({ connectionString: env.dbUrl, max: 2 });
const PASSWORD = "Test-Passw0rd!-consent-it";
const noSession = { auth: { autoRefreshToken: false, persistSession: false } };

let service: SupabaseClient;
let alice: { id: string; client: SupabaseClient };
let bob: { id: string; client: SupabaseClient };
let currentVersion = 0;
let publishedV3Id: string | null = null;

async function person(label: string): Promise<{ id: string; client: SupabaseClient }> {
  const email = `consent-it-${label}-${randomUUID()}@test.local`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  const client = createClient(env.apiUrl, env.anonKey, noSession);
  const signed = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signed.error) throw new Error(`sign in ${label}: ${signed.error.message}`);
  return { id: data.user.id, client };
}

async function record(who: { client: SupabaseClient }, action: "granted" | "withdrawn", version: number | null) {
  return who.client.rpc("record_consent", {
    p_purpose: MARKETING_EMAIL.purpose,
    p_action: action,
    p_policy_version: version,
    p_statement: MARKETING_EMAIL.statementId,
  });
}

beforeAll(async () => {
  service = createClient(env.apiUrl, env.serviceRoleKey, noSession);
  alice = await person("alice");
  bob = await person("bob");
  const { rows } = await pool.query<{ version: number }>(
    `select version from public.legal_documents where slug = $1 and status = 'published'`,
    [MARKETING_EMAIL.policySlug],
  );
  currentVersion = rows[0].version;
});

afterAll(async () => {
  const ids = [alice?.id, bob?.id].filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`delete from public.audit_events where target_type = 'consent' and actor_user_id = any($1::uuid[])`, [ids]);
    await client.query(`delete from public.consents where user_id = any($1::uuid[])`, [ids]);
    if (publishedV3Id) {
      await client.query(`delete from public.legal_documents where id = $1`, [publishedV3Id]);
      await client.query(
        `update public.legal_documents set status = 'published', superseded_at = null
          where slug = $1 and version = $2`,
        [MARKETING_EMAIL.policySlug, currentVersion],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  await pool.query(`delete from public.rate_limit_counters where category = 'consent_grant' and subject_id = any($1::uuid[])`, [ids]);
  for (const id of ids) await service.auth.admin.deleteUser(id as string);
  await pool.end();
});

describe("hasMarketingConsent -- what a marketing sender asks", () => {
  it("DENOMINATOR: the marketing page is published, so a grant has a version to point at", () => {
    expect(currentVersion).toBeGreaterThanOrEqual(2);
  });

  it("is false with no record", async () => {
    expect(await hasMarketingConsent(service, alice.id)).toBe(false);
    await expect(assertMarketingConsent(service, alice.id)).rejects.toBeInstanceOf(MarketingConsentMissingError);
  });

  it("is false after a grant against a version the person was not shown -- the grant never lands", async () => {
    const stale = await record(alice, "granted", currentVersion - 1);
    expect(stale.error?.code).toBe("22023");
    expect(stale.error?.hint).toBe("stale_policy_version");
    const invented = await record(alice, "granted", currentVersion + 7);
    expect(invented.error?.hint).toBe("stale_policy_version");
    expect(await hasMarketingConsent(service, alice.id)).toBe(false);
  });

  it("is true after a grant", async () => {
    const { data, error } = await record(alice, "granted", currentVersion);
    expect(error, error?.message).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({ recorded_action: "granted", recorded_version: currentVersion }),
    ]);
    expect(await hasMarketingConsent(service, alice.id)).toBe(true);
    await expect(assertMarketingConsent(service, alice.id)).resolves.toBeUndefined();
  });

  it("is about that person only", async () => {
    expect(await hasMarketingConsent(service, bob.id)).toBe(false);
  });

  it("is false after a withdrawal -- one call, no version needed", async () => {
    const { error } = await record(alice, "withdrawn", null);
    expect(error, error?.message).toBeNull();
    expect(await hasMarketingConsent(service, alice.id)).toBe(false);
  });

  it("is true again after a re-grant, and the ledger holds all three events in order", async () => {
    expect((await record(alice, "granted", currentVersion)).error).toBeNull();
    expect(await hasMarketingConsent(service, alice.id)).toBe(true);
    const { rows } = await pool.query<{ action: string }>(
      `select action from public.consents where user_id = $1 order by seq`,
      [alice.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["granted", "withdrawn", "granted"]);
  });

  it("STAYS true when a new version of the marketing page is published (queued default: no automatic re-consent)", async () => {
    // Published the way the seed and the corrections migrations do it, as
    // postgres: an unreviewed draft, then supersede, then publish.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ id: string }>(
        `insert into public.legal_documents (slug, version, title, effective_date, body)
         select slug, version + 1, title, effective_date, body || E'\n\nIntegration test change.'
           from public.legal_documents where slug = $1 and status = 'published'
         returning id`,
        [MARKETING_EMAIL.policySlug],
      );
      publishedV3Id = rows[0].id;
      await client.query(
        `update public.legal_documents set status = 'superseded', superseded_at = now()
          where slug = $1 and status = 'published'`,
        [MARKETING_EMAIL.policySlug],
      );
      await client.query(`update public.legal_documents set status = 'published', published_at = now() where id = $1`, [
        publishedV3Id,
      ]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    expect(await hasMarketingConsent(service, alice.id)).toBe(true);
    // ...and bob, who never agreed, cannot agree to the old version now.
    const stale = await record(bob, "granted", currentVersion);
    expect(stale.error?.hint).toBe("stale_policy_version");
    expect(await hasMarketingConsent(service, bob.id)).toBe(false);
  });

  it("fails closed: a user session cannot run the check, and gets false rather than an answer", async () => {
    const { error } = await alice.client.rpc("consent_is_granted", {
      p_user_id: alice.id,
      p_purpose: MARKETING_EMAIL.purpose,
    });
    expect(error?.code).toBe("42501");
    expect(await hasMarketingConsent(alice.client, alice.id)).toBe(false);
  });

  it("fails closed with no credentials at all", async () => {
    const anon = createClient(env.apiUrl, env.anonKey, noSession);
    expect(await hasMarketingConsent(anon, alice.id)).toBe(false);
  });

  it("the grant attribution is the session's: alice's rows are alice's, bob has none", async () => {
    const { rows } = await pool.query<{ user_id: string; n: string }>(
      `select user_id, count(*)::text as n from public.consents
        where user_id = any($1::uuid[]) group by user_id`,
      [[alice.id, bob.id]],
    );
    expect(rows).toEqual([{ user_id: alice.id, n: "3" }]);
  });
});
