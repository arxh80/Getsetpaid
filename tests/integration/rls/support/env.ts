// Reads connection details for the LOCAL Supabase stack at test-run time,
// the same way supabase/tests/run-rls-tests.sh does -- never hardcoded, never
// committed. `supabase status -o json` is the single source of truth for the
// local anon key, service-role key and Postgres connection string, all of
// which are regenerated per-machine/per-project by the Supabase CLI.
//
// LOCAL ONLY. This suite must never be pointed at a hosted project -- see
// CLAUDE.md, "Never commit ... Supabase service-role keys", and the same
// warning in run-rls-tests.sh.
import { execSync } from "node:child_process";

export interface LocalSupabaseStatus {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
}

let cached: LocalSupabaseStatus | undefined;

export function getLocalSupabaseStatus(): LocalSupabaseStatus {
  if (cached) return cached;

  let raw: string;
  try {
    // execSync always goes through a shell, so `supabase` resolves via PATH
    // the same way it does when the run-rls-tests.sh bash script invokes it.
    // The command is a fixed literal (no interpolated input), so there is no
    // injection surface despite the shell hop.
    raw = execSync("supabase status -o json", { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      "Could not run `supabase status -o json`. Is the local Supabase stack " +
        "up? Run `supabase start` (or `supabase db reset --local` for a " +
        `clean schema) before running this suite.\n${String(err)}`,
    );
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not parse \`supabase status -o json\` output as JSON:\n${raw}`,
    );
  }

  const apiUrl = parsed.API_URL;
  const anonKey = parsed.ANON_KEY;
  const serviceRoleKey = parsed.SERVICE_ROLE_KEY;
  const dbUrl = parsed.DB_URL;

  if (!apiUrl || !anonKey || !serviceRoleKey || !dbUrl) {
    throw new Error(
      "`supabase status -o json` did not return API_URL/ANON_KEY/" +
        "SERVICE_ROLE_KEY/DB_URL. Is the local stack fully started?",
    );
  }

  // Refuse anything that doesn't look like the standard local loopback
  // stack. This suite creates and deletes real auth.users rows and runs
  // superuser SQL -- it must never touch anything but a local instance.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error(
      `Refusing to run: API_URL "${apiUrl}" does not look like a local ` +
        "Supabase instance (expected 127.0.0.1/localhost). This suite must " +
        "never run against a hosted project.",
    );
  }
  if (!/^postgres(?:ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):/.test(dbUrl)) {
    throw new Error(
      `Refusing to run: DB_URL does not look like a local Postgres instance ` +
        "(expected 127.0.0.1/localhost host).",
    );
  }

  cached = { apiUrl, anonKey, serviceRoleKey, dbUrl };
  return cached;
}
