import { defineConfig, devices } from "@playwright/test";

// PLAYWRIGHT, LOCAL STACK ONLY.
//
// Added by Phase 2 Task 8 (the phase exit gate). `CLAUDE.md` § Testing gates
// asks for "e2e-testing-patterns for Playwright golden-path and tenant-breakout
// runs"; until this file there were none, and every UI defect in Phase 2 was
// found by a human walking a browser and by nothing else. Four of them
// (Task 3's three, Task 7's "we couldn't load this contact's activity") were
// green across 800+ unit tests, 850 psql assertions and 174 HTTP checks at the
// moment they were found. This suite is the executable half of that walk, so
// Phase 3 inherits it rather than a description of it.
//
// ===========================================================================
// WHY `reuseExistingServer` IS TRUE EVEN IN CI
// ===========================================================================
// There is no CI (Task 8 § "dependency and secret scanning"), so `process.env.CI`
// is never set here today and the distinction is theoretical. It is written
// this way deliberately: `pnpm dev` runs `scripts/dev-env.mjs` first, which
// REFUSES to start unless the local Supabase stack is up, so a reused server is
// a server that already passed that check. `pnpm build`/`pnpm start` are
// forbidden in this worktree (CLAUDE.md § Current state -- they resolve to the
// HOSTED project), which is also why there is no production-build project here.
//
// ===========================================================================
// ONE WORKER, NO RETRIES
// ===========================================================================
// The fixtures create real auth users and a real organisation per run and
// delete them afterwards; two workers would race on the shared local stack and
// on the dev server's module cache. Retries are off because a retry that passes
// hides exactly the intermittency this suite exists to catch -- these tests are
// meant to be read when they fail, not re-rolled.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The app sets a 30-minute idle timeout and stores activity in
    // sessionStorage; nothing here runs long enough to hit it.
    actionTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
