// Give a worktree its OWN local Supabase stack, on its own ports.
//
// ===========================================================================
// THE PROBLEM
// ===========================================================================
// `supabase/config.toml` is committed with ONE `project_id` and ONE fixed port
// range. The Supabase CLI names every container after `project_id`
// (`supabase_db_getsetpaid`, ...) and binds the ports the file names, so two
// worktrees cannot both run a stack: the second `supabase start` either
// adopts the first one's containers or fails on a bound port. Every worktree
// on this machine therefore shares one database and one port 3000, which makes
// every test run exclusive -- and a `db reset` in one worktree wipes another
// session's fixtures mid-run. MEMORY.md has carried that warning for weeks.
//
// ===========================================================================
// WHAT THE CLI ACTUALLY SUPPORTS (measured against 2.116.0, not assumed)
// ===========================================================================
// Four things were probed directly, because the answer decides the design:
//
//   1. `env(VAR)` substitution WORKS FOR PORTS, not just strings.
//      `port = "env(GSP_API_PORT)"` parses and the value is used.
//   2. ...but there is NO DEFAULT SYNTAX. `env(VAR:-54321)`, `env(VAR:54321)`
//      and `${VAR:-54321}` all fail with `CliConfigParseError`, and so does an
//      UNSET variable in an integer field. So putting `env()` into the
//      committed config.toml would break the stack for anyone who has not set
//      the variables -- which the brief forbids.
//   3. `project_id = "env(VAR)"` with the variable UNSET does NOT fail. It
//      silently becomes the literal `env_VAR_`, i.e. a whole separate,
//      empty stack. That is a worse failure than a crash and is the second
//      reason `env()` does not go in the committed file.
//   4. `--workdir <dir>` AND the environment variable `SUPABASE_WORKDIR` are
//      both honoured, and the CLI reads `.env` from THAT directory. Verified:
//      with `SUPABASE_WORKDIR` pointed elsewhere, a `supabase status` run from
//      inside this worktree reported the OTHER project's containers.
//
// (4) is the whole mechanism. The committed `supabase/config.toml` is never
// touched, never rewritten in place, and keeps working byte-for-byte for
// anyone who does nothing. A worktree OPTS IN by generating a small overlay
// project directory -- `.supabase-slot/`, gitignored -- whose `config.toml` is
// the committed one with the project id and every port rewritten, and whose
// `migrations/`, `templates/` and `tests/` are directory links back to the
// real ones so they cannot drift.
//
// ===========================================================================
// SLOTS
// ===========================================================================
// Slot 0 is the committed default: project `getsetpaid`, ports 5432x, app on
// 3000. This script never claims it and never touches it -- that stack stays
// exactly where it is for whoever is already using it.
//
// Slot N (1..9) shifts every port by N*100 and the app port by N:
//
//   slot  project_id        api     db    studio  mailpit  app
//   0     getsetpaid        54321  54322  54323   54324    3000   (committed)
//   1     getsetpaid_s1     54421  54422  54423   54424    3001
//   2     getsetpaid_s2     54521  54522  54523   54524    3002
//
// The 5432x block the CLI uses is 54320-54329, so a 100-wide stride keeps
// slots disjoint with room to spare. `edge_runtime.inspector_port` (8083)
// moves by the same stride.
//
// ===========================================================================
// USAGE
// ===========================================================================
//   node scripts/stack.mjs claim [--slot N]   generate the overlay
//   node scripts/stack.mjs release            stop that stack and delete it
//   node scripts/stack.mjs info               print this worktree's slot
//   node scripts/stack.mjs env                print the shell export lines
//
// After `claim`, EXPORT `SUPABASE_WORKDIR` as the command prints. That single
// variable is what makes a bare `npx supabase db reset`, `supabase status`,
// the vitest integration suite and the Playwright suite all follow this
// worktree's stack instead of the shared one -- they all shell out to
// `supabase status` and inherit the environment. Without the export, the repo
// scripts still auto-detect `.supabase-slot/` (see resolveWorkdir below), but
// a bare `npx supabase ...` typed by hand will hit the SHARED stack. That is
// the sharpest remaining edge and docs/parallel-stacks.md says so out loud.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY = join(REPO, ".supabase-slot");
const SLOT_FILE = join(OVERLAY, "slot.json");

/** Slot 0's literals, exactly as the committed config.toml spells them. */
const BASE_PORTS = {
  api: 54321,
  db: 54322,
  shadow: 54320,
  pooler: 54329,
  studio: 54323,
  smtp: 54324,
  analytics: 54327,
  inspector: 8083,
};
const BASE_APP_PORT = 3000;
const STRIDE = 100;
const MAX_SLOT = 9;

export function portsForSlot(slot) {
  const out = {};
  for (const [name, base] of Object.entries(BASE_PORTS)) {
    out[name] = base + slot * STRIDE;
  }
  return out;
}

export function appPortForSlot(slot) {
  return BASE_APP_PORT + slot;
}

/**
 * The Supabase project directory the repo's own scripts should talk to.
 *
 * `SUPABASE_WORKDIR` wins if it is set (that is the CLI's own variable, so
 * honouring it here keeps one source of truth). Otherwise a generated
 * `.supabase-slot/` in this worktree wins. Otherwise the repo root -- the
 * committed config, slot 0, unchanged behaviour for anyone who never ran
 * `claim`.
 */
export function resolveWorkdir() {
  if (process.env.SUPABASE_WORKDIR) return process.env.SUPABASE_WORKDIR;
  if (existsSync(join(OVERLAY, "supabase", "config.toml"))) return OVERLAY;
  return REPO;
}

/** The claimed slot's metadata, or null when this worktree is on slot 0. */
export function readSlot() {
  if (!existsSync(SLOT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SLOT_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** The dev-server port this worktree owns. 3000 unless a slot is claimed. */
export function resolveAppPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  return readSlot()?.appPort ?? BASE_APP_PORT;
}

function isPortFree(port) {
  // node:net is async-only and a claim has to make this decision before it
  // writes anything, so the bind happens in a throwaway child process whose
  // exit code is the answer. A claim is a human-speed operation; eight
  // 20-millisecond node starts are not worth a callback-shaped refactor.
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `const s=require('net').createServer();s.once('error',()=>process.exit(1));` +
          `s.listen(${port},'127.0.0.1',()=>{s.close(()=>process.exit(0))});`,
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function dockerProjectsInUse() {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "-a", "--format", "{{.Names}}", "--filter", "name=supabase_db_"],
      { encoding: "utf8" },
    );
    return new Set(
      out
        .split(/\r?\n/)
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => n.replace(/^supabase_db_/, "")),
    );
  } catch {
    // No docker, or it is not running. `claim` only writes files, so this is
    // not fatal -- but the caller loses the collision check, and says so.
    return null;
  }
}

function chooseSlot(requested) {
  const taken = dockerProjectsInUse();
  if (requested !== undefined) {
    assertSlotUsable(requested, taken);
    return requested;
  }
  for (let slot = 1; slot <= MAX_SLOT; slot += 1) {
    if (taken && taken.has(`getsetpaid_s${slot}`)) continue;
    if (Object.values(portsForSlot(slot)).every(isPortFree)) return slot;
  }
  throw new Error(
    `No free slot in 1..${MAX_SLOT}. Release one with \`node scripts/stack.mjs release\` ` +
      "in the worktree that owns it.",
  );
}

function assertSlotUsable(slot, taken) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    throw new Error(
      `Slot must be an integer 1..${MAX_SLOT}. Slot 0 is the committed default ` +
        "stack and is deliberately not claimable -- another worktree is almost " +
        "certainly using it.",
    );
  }
  const mine = readSlot()?.slot;
  if (taken && taken.has(`getsetpaid_s${slot}`) && mine !== slot) {
    throw new Error(
      `REFUSING: containers for project getsetpaid_s${slot} already exist, and this ` +
        "worktree does not own that slot. Another worktree claimed it; pick another " +
        "slot or release it there.",
    );
  }
  const busy = Object.entries(portsForSlot(slot)).filter(([, p]) => !isPortFree(p));
  if (busy.length && mine !== slot) {
    throw new Error(
      `REFUSING: slot ${slot} wants ports that are already bound: ` +
        busy.map(([n, p]) => `${n}=${p}`).join(", ") +
        ". Something else owns them; pick another slot.",
    );
  }
}

/**
 * Rewrite the committed config for a slot.
 *
 * Literal-for-literal replacement of the eight port numbers and the app
 * origin, plus `project_id`. Every replacement is ASSERTED to have matched at
 * least once, so a future edit that renames a port or drops a line turns into
 * a loud failure here rather than a stack that silently half-collides. Some
 * of the literals also appear inside comments (`http://127.0.0.1:54321/auth/v1/callback`);
 * rewriting those too is correct -- a reader of the generated file should see
 * the ports that file actually uses.
 */
function renderConfig(source, slot) {
  const ports = portsForSlot(slot);
  const appPort = appPortForSlot(slot);
  let out = source;

  const replace = (pattern, replacement, label) => {
    const before = out;
    out = out.replace(pattern, replacement);
    if (out === before) {
      throw new Error(
        `stack.mjs: expected to rewrite ${label} in supabase/config.toml and found ` +
          "nothing to change. The committed config has drifted from this script -- " +
          "fix scripts/stack.mjs rather than editing .supabase-slot/ by hand.",
      );
    }
  };

  replace(/^project_id = ".*"$/m, `project_id = "getsetpaid_s${slot}"`, "project_id");
  for (const [name, base] of Object.entries(BASE_PORTS)) {
    replace(new RegExp(String(base), "g"), String(ports[name]), `port ${name} (${base})`);
  }
  replace(/:3000\b/g, `:${appPort}`, "app origin port 3000");

  return (
    "# GENERATED by scripts/stack.mjs -- DO NOT EDIT.\n" +
    `# Slot ${slot} of the committed supabase/config.toml, with project_id and every\n` +
    "# port shifted. Edit ../../supabase/config.toml and re-run `claim` instead.\n" +
    "#\n" +
    "# migrations/, templates/ and tests/ beside this file are directory LINKS to\n" +
    "# the real ones in the repo, so they cannot drift. seed.sql is a copy and is\n" +
    "# refreshed on every `claim`.\n" +
    "\n" +
    out
  );
}

function linkDir(target, linkPath) {
  if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  // "junction" is the only link type Windows grants without Developer Mode or
  // an elevated shell; on POSIX node ignores the hint and makes a symlink.
  symlinkSync(target, linkPath, "junction");
}

function claim(requested) {
  const slot = chooseSlot(requested);
  const ports = portsForSlot(slot);
  const appPort = appPortForSlot(slot);

  const overlaySupabase = join(OVERLAY, "supabase");
  mkdirSync(overlaySupabase, { recursive: true });

  const source = readFileSync(join(REPO, "supabase", "config.toml"), "utf8");
  writeFileSync(join(overlaySupabase, "config.toml"), renderConfig(source, slot), "utf8");

  for (const dir of ["migrations", "templates", "tests"]) {
    linkDir(join(REPO, "supabase", dir), join(overlaySupabase, dir));
  }
  // A file, not a directory: Windows junctions cannot point at one and a true
  // file symlink needs privileges, so this is copied and re-copied on claim.
  copyFileSync(join(REPO, "supabase", "seed.sql"), join(overlaySupabase, "seed.sql"));

  // The CLI resolves `env(...)` in config.toml against process env plus a
  // `.env` in the WORKDIR. Carrying the repo's own `.env` across keeps
  // whatever the developer had configured (Google OAuth client id, etc.)
  // working. Both locations are gitignored; nothing new is exposed.
  const rootEnv = join(REPO, ".env");
  if (existsSync(rootEnv)) copyFileSync(rootEnv, join(OVERLAY, ".env"));

  writeFileSync(
    SLOT_FILE,
    `${JSON.stringify({ slot, projectId: `getsetpaid_s${slot}`, ports, appPort }, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    [
      "",
      `  Claimed slot ${slot} for this worktree.`,
      "",
      `    project_id   getsetpaid_s${slot}`,
      `    API          http://127.0.0.1:${ports.api}`,
      `    Postgres     127.0.0.1:${ports.db}`,
      `    Studio       http://127.0.0.1:${ports.studio}`,
      `    Mailpit      http://127.0.0.1:${ports.smtp}`,
      `    dev server   http://localhost:${appPort}`,
      "",
      "  Now export SUPABASE_WORKDIR so the CLI, the vitest integration suite and",
      "  Playwright all follow this stack instead of the shared one:",
      "",
      ...exportLines(),
      "",
      "  Then:  npx supabase start   &&   npx supabase db reset",
      "",
    ].join("\n"),
  );
}

function exportLines() {
  return [
    `    bash   export SUPABASE_WORKDIR="${OVERLAY}"`,
    `    pwsh   $env:SUPABASE_WORKDIR = "${OVERLAY}"`,
  ];
}

function release() {
  const meta = readSlot();
  if (!meta) {
    process.stdout.write("  No slot claimed in this worktree; nothing to release.\n");
    return;
  }
  try {
    // `npx.cmd` rather than `npx` with `shell: true`: node deprecates the
    // latter (DEP0190) because the arguments are concatenated into a command
    // line rather than escaped, and OVERLAY is a path that can contain spaces.
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--yes", "supabase", "stop", "--workdir", OVERLAY],
      { stdio: "inherit" },
    );
  } catch {
    process.stderr.write(
      `  \`supabase stop\` failed for slot ${meta.slot}. Removing the overlay anyway; ` +
        `if containers survive, remove them with \`docker rm -f $(docker ps -aq --filter name=${meta.projectId})\`.\n`,
    );
  }
  rmSync(OVERLAY, { recursive: true, force: true });
  process.stdout.write(`  Released slot ${meta.slot}.\n`);
}

function info() {
  const meta = readSlot();
  if (!meta) {
    process.stdout.write(
      "  Slot 0 (the committed default): project getsetpaid, API 54321, app 3000.\n" +
        "  This worktree SHARES that stack with every other one. `claim` to stop.\n",
    );
    return;
  }
  process.stdout.write(
    `  Slot ${meta.slot}  project ${meta.projectId}  API ${meta.ports.api}  app ${meta.appPort}\n` +
      `  workdir ${OVERLAY}\n` +
      `  SUPABASE_WORKDIR is ${process.env.SUPABASE_WORKDIR ? "set" : "NOT set in this shell"}\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("stack.mjs")) {
  try {
    switch (command) {
      case "claim": {
        const i = rest.indexOf("--slot");
        claim(i === -1 ? undefined : Number(rest[i + 1]));
        break;
      }
      case "release":
        release();
        break;
      case "info":
        info();
        break;
      case "env":
        process.stdout.write(`${exportLines().join("\n")}\n`);
        break;
      default:
        process.stdout.write(
          "usage: node scripts/stack.mjs <claim [--slot N] | release | info | env>\n",
        );
        process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  }
}
