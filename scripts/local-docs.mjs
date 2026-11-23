// Keep the gitignored working docs present in every checkout, and backed up.
//
// SECURITY.md, FOLLOW-UPS.md and the decisions queue stay out of git on
// purpose, so a fresh worktree lacks them: the security-md-checklist tests
// fail there, and founder rulings that lived only in a removed worktree were
// lost. `sync` copies the newest copy found in any checkout into one that
// lacks it (it never overwrites); `backup` copies the newest of each outside
// the repo.
//
//   node scripts/local-docs.mjs sync      # into the current checkout
//   node scripts/local-docs.mjs backup    # to ~/.config/getsetpaid/local-docs/<date>/
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LOCAL_DOCS = [
  "SECURITY.md",
  "FOLLOW-UPS.md",
  ".superpowers/sdd/plan-the-whole-build-synthetic-thompson/DECISIONS-QUEUE.md",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function checkouts(cwd = process.cwd()) {
  return git(["worktree", "list", "--porcelain"], cwd)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}

function newestCopy(doc, roots) {
  let best = null;
  for (const root of roots) {
    const path = join(root, doc);
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

/** Copies each missing doc into `target`; returns what it copied and what no checkout has. */
export function syncLocalDocs(target = git(["rev-parse", "--show-toplevel"])) {
  const roots = checkouts(target);
  const copied = [];
  const missingEverywhere = [];
  for (const doc of LOCAL_DOCS) {
    const dest = join(target, doc);
    if (existsSync(dest)) continue;
    const source = newestCopy(doc, roots);
    if (!source) {
      missingEverywhere.push(doc);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    copied.push(doc);
  }
  return { copied, missingEverywhere };
}

function backup() {
  const roots = checkouts();
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(homedir(), ".config", "getsetpaid", "local-docs", day);
  for (const doc of LOCAL_DOCS) {
    const source = newestCopy(doc, roots);
    if (!source) {
      process.stdout.write(`  missing everywhere: ${doc}\n`);
      continue;
    }
    const dest = join(dir, doc);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    process.stdout.write(`  ${doc} <- ${source}\n`);
  }
  process.stdout.write(`  backed up to ${dir}\n`);
}

if (process.argv[1]?.endsWith("local-docs.mjs")) {
  const command = process.argv[2];
  if (command === "sync") {
    const { copied, missingEverywhere } = syncLocalDocs();
    for (const doc of copied) process.stdout.write(`  copied ${doc}\n`);
    for (const doc of missingEverywhere) process.stdout.write(`  missing everywhere: ${doc}\n`);
    if (!copied.length && !missingEverywhere.length) process.stdout.write("  all local docs present\n");
  } else if (command === "backup") {
    backup();
  } else {
    process.stdout.write("usage: node scripts/local-docs.mjs <sync | backup>\n");
    process.exitCode = command ? 1 : 0;
  }
}
