// `pnpm dev` -- generate the local env, then start Next on THIS worktree's port.
//
// This file exists because the port is no longer a constant. A worktree that
// has run `node scripts/stack.mjs claim` owns 3000+slot, not 3000, and
// `next dev` takes its port from an argument or `process.env.PORT` at process
// start -- it does NOT read `.env.development.local` early enough to pick one
// up from there. A shell snippet in package.json would have done it on POSIX
// and not on Windows, which is what this project is developed on.
//
// Behaviour on the shared default stack is unchanged: no slot claimed means
// port 3000 and `next dev` with no extra argument's worth of difference.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppPort } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

// dev-env.mjs refuses to start when the local stack is down, on purpose --
// falling back to `.env.local` would point the dev server at the HOSTED
// project. Propagate that refusal rather than starting Next anyway.
const args = process.argv.slice(2);
const envStep = spawnSync(process.execPath, [join(here, "dev-env.mjs"), ...args], {
  stdio: "inherit",
  cwd: repo,
});
if (envStep.status !== 0) process.exit(envStep.status ?? 1);

// Next's own entry point under this Node, not `npx.cmd`: Node >= 20.12 refuses
// to spawn a .cmd without a shell (CVE-2024-27980), which failed silently here.
const port = String(resolveAppPort());
const next = spawnSync(
  process.execPath,
  [join(repo, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", port],
  { stdio: "inherit", cwd: repo, env: { ...process.env, PORT: port } },
);
if (next.error) console.error(`dev: could not start next dev: ${next.error.message}`);
process.exit(next.status ?? 1);
