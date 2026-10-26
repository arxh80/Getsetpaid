import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// THIS WORKTREE'S DEV-SERVER PORT, NOT A CONSTANT.
//
// `scripts/stack.mjs claim` gives a worktree its own Supabase stack and its own
// app port (3000 + slot), written to `.supabase-slot/slot.json`. Reading that
// file directly -- rather than importing scripts/stack.mjs -- keeps this config
// free of a module-resolution dependency it does not otherwise have, for four
// lines. No slot claimed means 3000, exactly as before.
function appPort(): number {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    if (existsSync("./.supabase-slot/slot.json")) {
      const meta = JSON.parse(readFileSync("./.supabase-slot/slot.json", "utf8")) as {
        appPort?: number;
      };
      if (meta.appPort) return meta.appPort;
    }
  } catch {
    // A corrupt slot file is not a reason to refuse to run; 3000 is the
    // documented default and the webServer check below fails loudly anyway.
  }
  return 3000;
}

const APP_ORIGIN = `http://localhost:${appPort()}`;

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
// WHY `reuseExistingServer` IS OPT-IN, NOT DEFAULT
// ===========================================================================
// It used to be `true` unconditionally, on the argument that `pnpm dev` runs
// `scripts/dev-env.mjs` first and REFUSES to start unless the local Supabase
// stack is up, "so a reused server is a server that already passed that check".
// That argument is about the STACK, not about the CODE. A dev server started
// before the last checkout, or one whose Turbopack module graph was invalidated
// by a `node_modules` change, passes the stack check and serves stale modules.
// Task 8's own report records exactly that happening mid-task: installing
// @playwright/test invalidated the running server's graph and every test failed
// with a locator timeout that looked precisely like a selector bug.
//
// A timeout is the LUCKY version. The unlucky version is an orphaned server on
// the PREVIOUS commit answering every request, and the e2e gate going green
// over code that is no longer in the tree -- the one outcome this whole suite
// exists to prevent.
//
// So the default is `false`: Playwright starts its own server and fails fast if
// port 3000 is already taken, which is the signal you want. Setting
// PLAYWRIGHT_REUSE_SERVER=1 reuses whatever is on port 3000, and IS THE
// DEVELOPER'S ASSERTION THAT IT IS CURRENT -- that it was started after the
// last checkout and after the last `node_modules` change. Nothing in this file
// can check that for you.
//
// `pnpm build`/`pnpm start` are forbidden in this worktree (CLAUDE.md
// § Current state -- they resolve to the HOSTED project), which is why there is
// no production-build project here either.
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
    baseURL: APP_ORIGIN,
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
    url: `${APP_ORIGIN}/login`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
