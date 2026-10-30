// Point `pnpm dev` at the LOCAL Supabase stack, always.
//
// WHY THIS EXISTS. `.env.local` holds the hosted project's URL and keys, and
// `supabase start` does not change them, so `next dev` on its own runs the
// application against production. Phase 2 Task 3 found this in the worst way:
// the first step of its browser walkthrough was a sign-up, and it created a
// real account on the hosted project before anything looked wrong. Nothing in
// the repo warned about it, and every "open it in a browser" instruction issued
// during that phase would have done the same thing.
//
// HOW IT WORKS. Next.js loads `.env.development.local` ahead of `.env.local` in
// development, so writing the local stack's values there wins for `next dev`
// and leaves `.env.local` untouched for every other purpose (production builds,
// scripts, the Supabase CLI itself). The file is gitignored and per-machine,
// which is why it is generated rather than committed.
//
// WHY IT FAILS LOUDLY. If the local stack is not running there is no safe value
// to write, and falling back to `.env.local` is precisely the behaviour this
// script exists to prevent. Refusing to start is the correct outcome: a dev
// server that quietly talks to production is worse than one that will not boot.
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkdir, resolveAppPort } from "./stack.mjs";

const TARGET = join(process.cwd(), ".env.development.local");

// WHICH STACK. Slot 0 (the committed supabase/config.toml, shared by every
// worktree) unless this worktree ran `node scripts/stack.mjs claim`, in which
// case it is the generated `.supabase-slot/` overlay. See scripts/stack.mjs.
const WORKDIR = resolveWorkdir();
const APP_PORT = resolveAppPort();

// Keys are read out of `supabase status -o env` rather than hardcoded. They are
// the CLI's well-known local demo keys today, but a CLI upgrade may rotate them
// and a stale hardcoded key fails in a confusing way rather than an obvious one.
function readLocalStack() {
  let raw;
  try {
    // execSync with one literal string, rather than execFileSync: on Windows
    // `npx` is a .cmd shim, which execFileSync cannot spawn directly -- it
    // fails with ENOENT, which this script would then report as "the stack is
    // not running", sending the reader to fix the wrong thing. Nothing here is
    // interpolated, so there is nothing for a shell to expand.
    // A `supabase` ALREADY ON PATH IS PREFERRED, and this is not a
    // micro-optimisation: on a CI runner the CLI is installed by
    // supabase/setup-cli and `npx --yes supabase` would download a SECOND,
    // possibly different version of it before every dev-server start. On a
    // developer machine there is usually no `supabase` on PATH and the npx
    // fallback is what has always run.
    const status = `status -o env --workdir "${WORKDIR}"`;
    try {
      raw = execSync(`supabase ${status}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      raw = execSync(`npx --yes supabase ${status}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch {
    return null;
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- key is one of three literals below
  const pick = (key) => raw.match(new RegExp(`^${key}="?([^"\\r\\n]+)"?`, "m"))?.[1];
  const apiUrl = pick("API_URL");
  const anonKey = pick("ANON_KEY");
  const serviceKey = pick("SERVICE_ROLE_KEY");
  return apiUrl && anonKey && serviceKey ? { apiUrl, anonKey, serviceKey } : null;
}

// site_url in supabase/config.toml is the source of truth for the redirect
// allowlist, and GoTrue treats localhost and 127.0.0.1 as different origins --
// PR #2 fixed a hosted-auth bug caused by exactly that distinction. Read it
// rather than assuming, so the two cannot drift.
function readSiteUrl() {
  const configPath = join(WORKDIR, "supabase", "config.toml");
  if (!existsSync(configPath)) return "http://localhost:3000";
  const match = readFileSync(configPath, "utf8").match(/^site_url\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? "http://localhost:3000";
}

// `pnpm dev:hosted` is the deliberate escape hatch, and it did not work: this
// script writes .env.development.local, Next loads that file ahead of
// .env.local in development, and nothing removed it -- so once `pnpm dev` had
// run once, `dev:hosted` kept talking to the local stack no matter what it was
// asked for. Found by the Task 3 review. Removing the generated file is the
// whole fix, because .env.local is what Next falls back to.
if (process.argv.includes("--hosted")) {
  if (existsSync(TARGET)) rmSync(TARGET);
  console.log(
    "dev-env: generated override removed -- the app will use .env.local, " +
      "which points at the HOSTED project. This is not a drill.",
  );
  process.exit(0);
}

// The local server-only request mark (Phase 10 Task 5): the one value
// .env.example documents and supabase/seed.sql hashes.
function readLocalServerMark() {
  const raw = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const value = raw.match(/^GETSETPAID_SERVER_REQUEST_SECRET=(\S+)/m)?.[1];
  if (!value) throw new Error("dev-env: .env.example has no GETSETPAID_SERVER_REQUEST_SECRET value");
  return value;
}

const stack = readLocalStack();

if (!stack) {
  console.error(
    [
      "",
      "  REFUSING TO START THE DEV SERVER: the local Supabase stack is not running.",
      "",
      "  Without it there is no local URL to point the app at, and .env.local holds",
      "  the HOSTED project's credentials -- so `next dev` would run against",
      "  production. That has already happened once (a real account was created on",
      "  the hosted project during a browser walkthrough), which is why this script",
      "  fails instead of falling back.",
      "",
      "  Start it, then try again:",
      "      npx supabase start",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

writeFileSync(
  TARGET,
  [
    "# GENERATED by scripts/dev-env.mjs on every `pnpm dev`. Do not edit; edits",
    "# are overwritten. Gitignored and per-machine by design.",
    "#",
    "# These are the local stack's values, read from `supabase status -o env`.",
    "# They are the Supabase CLI's well-known demo keys -- not secrets, and they",
    "# reach nothing but a container on this machine.",
    "#",
    "# This file exists because .env.local points at the HOSTED project and",
    "# Next.js loads .env.development.local ahead of it in development.",
    "",
    `NEXT_PUBLIC_SUPABASE_URL=${stack.apiUrl}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${stack.anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${stack.serviceKey}`,
    "",
    "# The LOCAL server-only request mark, copied from .env.example (whose digest",
    "# supabase/seed.sql seeds). Not a secret. SECURITY.md § 15.",
    `GETSETPAID_SERVER_REQUEST_SECRET=${readLocalServerMark()}`,
    "",
    "# Mirrors supabase/config.toml site_url. GoTrue's redirect allowlist treats",
    "# localhost and 127.0.0.1 as different origins.",
    `NEXT_PUBLIC_SITE_URL=${readSiteUrl()}`,
    "",
    "# The dev-server port this worktree owns. 3000 on the shared default stack;",
    "# 3000+slot once `node scripts/stack.mjs claim` has run. scripts/dev.mjs",
    "# passes it to `next dev`; this line is here so anything else reading the",
    "# generated env sees the same number.",
    `PORT=${APP_PORT}`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `dev-env: app pointed at the local stack (${stack.apiUrl}), dev server on ${APP_PORT}.`,
);
