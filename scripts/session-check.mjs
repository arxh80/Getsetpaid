// Start-of-session check, run by the SessionStart hook in .claude/settings.json.
//
// Every recurring cross-session accident on this machine had a cheap early
// signal: fixes left uncommitted or unpushed in a worktree, PRs sitting red,
// a worktree on the shared slot-0 stack, another session's dev server or test
// run already holding the DB. This prints those signals in one block before
// any work starts. It only reads, except that it copies a missing gitignored
// doc into this checkout (scripts/local-docs.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkouts, syncLocalDocs } from "./local-docs.mjs";

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

const top = run("git", ["rev-parse", "--show-toplevel"]) ?? process.cwd();
const out = [];

out.push(`Branch: ${run("git", ["branch", "--show-current"]) || "(detached)"} in ${basename(top)}`);

for (const root of checkouts(top)) {
  const status = run("git", ["-C", root, "status", "--porcelain"]) ?? "";
  const dirty = status.split("\n").filter(Boolean).length;
  const ahead = run("git", ["-C", root, "rev-list", "--count", "@{u}..HEAD"]);
  const branch = run("git", ["-C", root, "branch", "--show-current"]) || "(detached)";
  const flags = [
    dirty ? `${dirty} uncommitted` : null,
    ahead === null ? "no upstream" : Number(ahead) > 0 ? `${ahead} unpushed` : null,
  ].filter(Boolean);
  if (flags.length) out.push(`Worktree ${basename(root)} [${branch}]: ${flags.join(", ")}`);
}

const prs = run("gh", ["pr", "list", "--json", "number,title,statusCheckRollup"], { timeout: 5000 });
if (prs === null) {
  out.push("Open PRs: gh unavailable or slow (not checked)");
} else {
  const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"];
  for (const pr of JSON.parse(prs)) {
    // "Supabase Preview" fails on the hosted plan, not the code; it is not a gate.
    const gates = (pr.statusCheckRollup ?? []).filter(
      (c) => !/supabase preview/i.test(c.name ?? c.context ?? ""),
    );
    const failing = gates.filter((c) => FAILED.includes(c.conclusion ?? c.state)).length;
    const running = gates.filter((c) => c.status && c.status !== "COMPLETED").length;
    const state = failing ? `${failing} failing` : running ? `${running} running` : "green";
    out.push(`PR #${pr.number} ${state}: ${pr.title}`);
  }
}

const slotFile = join(top, ".supabase-slot", "slot.json");
if (existsSync(slotFile)) {
  const slot = JSON.parse(readFileSync(slotFile, "utf8"));
  out.push(
    `Stack: slot ${slot.slot} (API ${slot.ports?.api}, app ${slot.appPort}); export SUPABASE_WORKDIR before a raw supabase command`,
  );
} else {
  out.push("Stack: slot 0 (shared, Archie's). Run `pnpm stack:claim` before any db reset or e2e.");
}

if (process.platform === "win32") {
  const listNode =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "ForEach-Object { [string]$_.ProcessId + '~' + $_.CommandLine }";
  const procs = run("powershell", ["-NoProfile", "-Command", listNode], { timeout: 8000 });
  for (const line of (procs ?? "").split("\n")) {
    const [pid, cmd = ""] = line.split("~");
    if (!/Getsetpaid/i.test(cmd) || !/next|playwright|vitest/i.test(cmd)) continue;
    const worktree = cmd.match(/worktrees[\\/]([^\\/]+)/i)?.[1] ?? "main checkout";
    const kind = /playwright/i.test(cmd) ? "playwright" : /vitest/i.test(cmd) ? "vitest" : "next";
    out.push(`Live ${kind} pid ${pid.trim()} from ${worktree}`);
  }
}

const { copied, missingEverywhere } = syncLocalDocs(top);
for (const doc of copied) out.push(`Copied missing local doc: ${doc}`);
for (const doc of missingEverywhere) out.push(`Local doc missing in every checkout: ${doc}`);

process.stdout.write(`GetSetPaid session check\n${out.map((l) => `- ${l}`).join("\n")}\n`);
