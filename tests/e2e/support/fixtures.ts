// Fixtures for the Playwright suite: two organisations, five signed-in roles,
// and a tenant boundary between them.
//
// ===========================================================================
// WHY THIS BUILDS ITS OWN WORLD RATHER THAN READING THE psql SUITE'S
// ===========================================================================
// `supabase/tests/run-rls-tests.sh` leaves a rich fixture behind, and it is
// tempting to point a browser at it. Two reasons not to:
//
//   1. It refuses to run against a dirty database, so "run the psql suite
//      first" means "reset the database first", which means this suite could
//      never run beside a dev session someone is using.
//   2. Its fixtures are shaped for assertions, not for a walk -- contacts
//      named "Deleted Contact" that are not deleted, and merge rows in two
//      different shapes. THE SECOND HALF OF THAT SENTENCE USED TO READ "ten
//      merges written by hand rather than through `merge_records()`", and
//      Phase 3 Task 1 made it half false: § Z of `rls_phase2_crm.sql` now
//      plants five dedicated pairs and merges them through `merge_records()`
//      for real, so the suite holds hand-written rows (no `<side>.before`
//      snapshot) AND real ones (with it) side by side, on purpose. The
//      hand-written ones were left alone because ~680 assertions are built on
//      them. A golden-path test that depends on any of it is a test that
//      depends on another suite's incidental choices, which is still the
//      point.
//
// So this creates a disposable world with a unique slug per run and deletes it
// afterwards, and it can run against a database anybody is already using.
//
// ===========================================================================
// WHY MEMBERSHIPS ARE NOT WRITTEN THROUGH THE CLIENT PATH
// ===========================================================================
// The obvious path is the real one: `create_organisation()` as the owner, then
// invites, then `accept_invite()`. `tests/integration/rls/support/fixtures.ts`
// does exactly that and it is the right shape THERE, because that suite is
// about the client path.
//
// It cannot be the shape here. `create_organisation()` makes the caller an
// OWNER, MFA is required for owners (`CLAUDE.md` § Session security) and
// enforced in the database, so inviting anybody needs a TOTP enrolment and a
// challenge before the first fixture row exists. That is a lot of machinery in
// front of a test whose subject is a contacts page.
//
// ===========================================================================
// AND WHY SETUP IS `pg`, NOT THE SERVICE-ROLE KEY OVER PostgREST
// ===========================================================================
// The first draft of this file inserted through `/rest/v1/organisations` with
// the service-role key, on the usual assumption that service-role bypasses
// everything. It does not, here, and finding that out was worth the round trip:
//
//   insert organisations failed (403): {"code":"42501",
//     "message":"permission denied for table organisations",
//     "hint":"GRANT INSERT ON public.organisations TO service_role;"}
//
// The default-privileges baseline (`20260827232507`, asserted as invariant D7)
// revoked the stock grants, and `service_role` was never granted back on the
// tenant tables. RLS bypass is irrelevant when the GRANT is missing -- they are
// independent controls (SECURITY.md § 2), which is exactly what invariant D5
// says. So setup connects to Postgres directly as `postgres`, the same way
// `tests/integration/rls/support/fixtures.ts` does for the things no client
// role can perform.
//
// Everything the tests ASSERT on still goes through a real browser, a real
// password sign-in and a real anon-key session, which is where the policies
// actually apply.
//
// LOCAL ONLY. `localStack()` refuses anything that is not loopback.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface LocalStack {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
}

let cachedStack: LocalStack | undefined;

/**
 * Read the local stack's URL and keys from the Supabase CLI at run time.
 *
 * Duplicated from `tests/integration/rls/support/env.ts` rather than imported:
 * that module lives under a `@/` path alias resolved by vitest's config, and
 * Playwright loads its files with its own transform. Copying twelve lines is
 * cheaper than making two runners agree about module resolution, and the
 * loopback refusal below -- the part that matters -- is copied with it.
 */
export function localStack(): LocalStack {
  if (cachedStack) return cachedStack;
  let raw: string;
  try {
    raw = execSync("npx --yes supabase status -o json", { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      "Could not run `supabase status -o json`. Start the local stack " +
        `(\`npx supabase start\`) before running the e2e suite.\n${String(err)}`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, string>;
  const apiUrl = parsed.API_URL;
  const anonKey = parsed.ANON_KEY;
  const serviceRoleKey = parsed.SERVICE_ROLE_KEY;
  const dbUrl = parsed.DB_URL;
  if (!apiUrl || !anonKey || !serviceRoleKey || !dbUrl) {
    throw new Error("`supabase status -o json` returned no API_URL/keys/DB_URL.");
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error(
      `Refusing to run: API_URL "${apiUrl}" is not a local stack. This suite ` +
        "creates and deletes real auth users and must never touch a hosted project.",
    );
  }
  if (!/^postgres(?:ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):/.test(dbUrl)) {
    throw new Error("Refusing to run: DB_URL is not a local Postgres instance.");
  }
  cachedStack = { apiUrl, anonKey, serviceRoleKey, dbUrl };
  return cachedStack;
}

export const PASSWORD = "Test-Passw0rd!-e2e";

/** Roles this suite signs in as. */
export type E2eRole = "manager" | "standard_user" | "read_only";

export interface E2eUser {
  id: string;
  email: string;
}

export interface E2eWorld {
  /** Slug of the workspace the golden path is walked in. */
  orgSlug: string;
  orgId: string;
  /** A SECOND tenant, for the breakout run. Nobody in `users` belongs to it. */
  otherOrgSlug: string;
  otherOrgId: string;
  /** A contact in the OTHER tenant. Its id is a valid uuid that must 404. */
  otherOrgContactId: string;
  /** A contact in THIS tenant owned by the manager, which the standard user
   *  must not be able to open -- record scope, not tenant scope. */
  managerOwnedContactId: string;
  /** A contact carrying values that a `javascript:`-rejecting form would never
   *  have accepted, planted directly so the RENDER path is what is measured. */
  hostileContactId: string;
  users: Record<E2eRole, E2eUser>;
}

async function api(
  path: string,
  init: RequestInit & { key: string },
): Promise<Response> {
  const { apiUrl } = localStack();
  const { key, headers, ...rest } = init;
  return fetch(`${apiUrl}${path}`, {
    ...rest,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(headers as Record<string, string> | undefined),
    },
  });
}

async function createUser(email: string): Promise<E2eUser> {
  const { serviceRoleKey } = localStack();
  const res = await api("/auth/v1/admin/users", {
    key: serviceRoleKey,
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string; msg?: string };
  if (!body.id) {
    throw new Error(`Could not create ${email}: ${JSON.stringify(body)}`);
  }
  return { id: body.id, email };
}

let pool: Pool | undefined;

function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: localStack().dbUrl, max: 2 });
  return pool;
}

/**
 * Run one statement as `postgres`.
 *
 * Parameterised rather than interpolated even here, where every value is
 * generated by this file: `CLAUDE.md` § Non-negotiable rules says
 * "no string-concatenated SQL, anywhere", and a fixture that quietly exempts
 * itself is the template the next fixture copies.
 */
async function sql(text: string, params: unknown[] = []): Promise<void> {
  await db().query(text, params);
}

/** Close the pool, or the Playwright process will not exit. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Build the world. Returns everything a test needs to address it by id.
 *
 * The suffix is per-run rather than fixed, so a crashed run leaves rows that
 * cannot collide with the next one -- and `teardown` still removes them by
 * organisation, which cascades.
 */
export async function setUpWorld(): Promise<E2eWorld> {
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const orgSlug = `e2e-${suffix}`;
  const otherOrgSlug = `e2e-other-${suffix}`;

  const users: Record<E2eRole, E2eUser> = {
    manager: await createUser(`e2e-manager-${suffix}@test.local`),
    standard_user: await createUser(`e2e-std-${suffix}@test.local`),
    read_only: await createUser(`e2e-ro-${suffix}@test.local`),
  };
  // The other tenant's owner. Never signed in as -- they exist so the second
  // organisation has a member, which is what makes its rows real rather than
  // orphaned.
  const otherOwner = await createUser(`e2e-otherowner-${suffix}@test.local`);

  await sql(
    `insert into public.organisations (id, name, slug) values ($1,$2,$3), ($4,$5,$6)`,
    [orgId, `E2E ${suffix}`, orgSlug, otherOrgId, `E2E Other ${suffix}`, otherOrgSlug],
  );

  // NO organisation_subscriptions ROW ON PURPOSE.
  // `private.crm_write_organisations()` treats "no subscription" as "not yet
  // billed, not yet gated" (20260828140000). A Starter row would work too; no
  // row is the state a freshly created workspace is actually in today, so it is
  // the state the golden path should be walked in.
  await sql(
    `insert into public.organisation_memberships
       (organisation_id, user_id, role, status, joined_at)
     values ($1,$2,'manager','active',now()),
            ($1,$3,'standard_user','active',now()),
            ($1,$4,'read_only','active',now()),
            ($5,$6,'owner','active',now())`,
    [
      orgId,
      users.manager.id,
      users.standard_user.id,
      users.read_only.id,
      otherOrgId,
      otherOwner.id,
    ],
  );

  const otherOrgContactId = randomUUID();
  const managerOwnedContactId = randomUUID();
  const hostileContactId = randomUUID();

  await sql(
    `insert into public.contacts (id, organisation_id, owner_user_id, name, email)
     values ($1,$2,$3,'Other Tenant Secret','secret@other.test'),
            ($4,$5,$6,'Manager Only Contact', null)`,
    [
      otherOrgContactId,
      otherOrgId,
      otherOwner.id,
      managerOwnedContactId,
      orgId,
      users.manager.id,
    ],
  );

  // THE VALUES A FORM WOULD REFUSE, WRITTEN PAST THE FORM.
  //
  // `lib/crm/validate.ts` rejects a `javascript:` website on the way IN, and
  // the browser walk confirms it does. That is the wrong control to rely on:
  // rows predating the validator, rows written by a migration, and rows written
  // by any future admin path all skip it. What has to hold is that the RENDER
  // refuses them -- `safeHref()`, per CLAUDE.md § Non-negotiable rules -- so
  // they go in through Postgres, which is the only way to get them in at all.
  await sql(
    `insert into public.contacts
       (id, organisation_id, owner_user_id, name, website, socials)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      hostileContactId,
      orgId,
      users.manager.id,
      `Hostile Values <img src=x onerror="document.title='XSS-FIRED'">`,
      `javascript:document.title='HREF-FIRED'`,
      JSON.stringify({
        instagram: "javascript:document.title='SOCIAL-FIRED'",
        spotify: "data:text/html,<script>document.title='DATA-FIRED'</script>",
        x: "https://x.com/legitimate",
      }),
    ],
  );

  return {
    orgSlug,
    orgId,
    otherOrgSlug,
    otherOrgId,
    otherOrgContactId,
    managerOwnedContactId,
    hostileContactId,
    users,
  };
}

/**
 * Delete the world.
 *
 * Deleting the two organisations cascades to every tenant row -- contacts,
 * companies, artists, venues, rooms, links, custom field values. Auth users are
 * removed separately, through the Admin API, because nothing cascades into
 * `auth.users` and this suite must not be the thing that teaches the codebase
 * to delete from it by hand.
 */
export async function tearDownWorld(world: E2eWorld): Promise<void> {
  const { serviceRoleKey } = localStack();
  await sql(`delete from public.organisations where id = any($1::uuid[])`, [
    [world.orgId, world.otherOrgId],
  ]);
  for (const user of Object.values(world.users)) {
    await api(`/auth/v1/admin/users/${user.id}`, {
      key: serviceRoleKey,
      method: "DELETE",
    });
  }
  // The other tenant's owner is not in `users` (nothing signs in as them), so
  // they are removed by the pattern their email was created with. Scoped to
  // THIS run's suffix, so a concurrent run's users are never touched.
  const suffix = world.orgSlug.replace(/^e2e-/, "");
  const listed = await api("/auth/v1/admin/users?per_page=1000", {
    key: serviceRoleKey,
  });
  const { users = [] } = (await listed.json()) as {
    users?: { id: string; email: string }[];
  };
  for (const u of users) {
    if (u.email === `e2e-otherowner-${suffix}@test.local`) {
      await api(`/auth/v1/admin/users/${u.id}`, {
        key: serviceRoleKey,
        method: "DELETE",
      });
    }
  }
  await closeDb();
}
