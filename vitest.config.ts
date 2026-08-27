import { defineConfig } from "vitest/config";

// Integration-test config for the RLS/permission-engine suite (Task 5).
//
// These tests talk to a REAL local Supabase stack over HTTP
// (@supabase/supabase-js against 127.0.0.1:54321) plus a direct Postgres
// connection for fixture setup/teardown that no client role can perform
// (activating memberships, granting platform_admins) -- see
// tests/integration/rls/support/*.ts for why.
//
// Not unit tests: no mocking, environment is "node", and timeouts are
// generous because every assertion is a real network round trip against the
// local stack, and beforeAll/afterAll create and tear down ~12 real
// auth.users + two organisations.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // The RLS suite mutates shared reference-independent fixtures (its own
    // orgs/users) but must not run two fixture lifecycles concurrently
    // against the same local Postgres instance.
    fileParallelism: false,
    reporters: ["default"],
  },
});
