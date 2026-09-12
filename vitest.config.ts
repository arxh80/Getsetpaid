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
// ===========================================================================
// TWO PROJECTS, BECAUSE ONE OF THESE CONSTRAINTS IS NOT THE OTHER'S
// ===========================================================================
// `fileParallelism: false` and the generous timeouts below used to sit at the
// ROOT of this config, where they governed every file under tests/. Read the
// comment that justified them: every word is about the RLS suite -- a real
// stack, real round trips, fixture lifecycles that must not overlap on one
// Postgres instance. None of it is true of tests/unit, which is 47 files of
// pure functions that share nothing and touch no socket.
//
// The cost was paid on every run and hardest in CI, which runs ONLY
// `vitest run tests/unit` (.github/workflows/ci.yml): 47 independent files
// executed strictly one at a time to protect a database none of them opens,
// with a 20s default timeout so a hung pure-function test takes twenty
// seconds to tell you.
//
// Splitting into projects scopes each constraint to the suite that earns it.
// `pnpm test` still runs BOTH -- the meaning of the documented gate is
// unchanged, and this is deliberately not the place to quietly narrow it.
export default defineConfig({
  test: {
    reporters: ["default"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // `.tsx` TOO, AND THE OMISSION WAS A TRAP RATHER THAN A CHOICE.
          // The pattern was `*.test.ts` only, so a test file written as
          // `.tsx` -- which is what a test that RENDERS a component has to
          // be -- was matched by nothing and silently never ran. Vitest
          // reports "No test files found" only when the filter names it
          // directly; in a full run it is simply absent, which is the same
          // failure mode as an untested size limit: it looks covered.
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          environment: "node",
          globals: false,
          // Pure functions: nothing shared, so nothing to serialise, and a
          // test that has not finished in five seconds is hung rather than
          // slow.
          testTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          environment: "node",
          globals: false,
          // KNOWN FLAKE, BY DESIGN, AND THE REASON THIS IS 20 s RATHER THAN
          // 5 s: under the full `pnpm test` load a window-waiting limiter
          // test (tests/integration/security/rate-limit-network-discovery,
          // or feedback-budget's "allows exactly ten raw inserts")
          // occasionally exceeds even this; each passes in <10 s alone and a
          // second full run is clean. Not a product defect -- re-run before
          // chasing it.
          testTimeout: 20_000,
          hookTimeout: 60_000,
          // The RLS suite mutates shared reference-independent fixtures (its
          // own orgs/users) but must not run two fixture lifecycles
          // concurrently against the same local Postgres instance.
          //
          // `singleFork`, NOT `fileParallelism: false`: the latter is honoured
          // only at the root of the config, so expressing it here silently
          // bought nothing -- measured, the suite went from 4 failures to 18
          // with files overlapping (summed test time exceeded wall clock).
          // Forcing this project into ONE worker is the per-project spelling
          // of the same constraint.
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
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
