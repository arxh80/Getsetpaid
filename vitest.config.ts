import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test config. Two kinds of suite live under tests/ and they are deliberately
// different in nature:
//
//   tests/integration/rls  -- real stack, no mocking (Task 5). See below.
//   tests/unit             -- pure functions only, for properties an
//                             integration test could only assert by waiting
//                             (session age). See tests/unit/auth/step-up.test.ts
//                             for why that exception is drawn where it is.
//
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
  resolve: {
    alias: {
      // tsconfig's "@/*" -> "./*". Vitest does not read tsconfig paths.
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `import "server-only"` is a build-time guard: the package's default
      // export is a bare `throw`, and only Next's `react-server` condition
      // resolves it to the empty module. Vitest resolves the default, so any
      // server module imported here would explode on import.
      //
      // Stubbing it out is safe and does NOT weaken the guarantee: the guard's
      // whole job is to fail the NEXT BUILD when a Client Component reaches a
      // server module, and that check still runs untouched (verified in Task 6
      // by making a Client Component import lib/supabase/admin.ts -- the build
      // failed hard). Nothing about a Node test process is a client bundle.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
