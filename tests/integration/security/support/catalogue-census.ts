// =============================================================================
// PHASE 8 TASK 8 -- THE CATALOGUE CENSUSES, AS FUNCTIONS OF A CONNECTION
// =============================================================================
// Every census the permission matrix runs is a query over the live catalogue.
// They live here, as functions that take a connection rather than as inline
// SQL, for exactly one reason: so the SAME query can be run on a connection
// that has just PLANTED something inside a transaction it is about to roll
// back. That is how "prove the denominator" is measured rather than argued --
// plant an unregistered RPC, table, column grant, overload, bucket or cron
// job, run the census on the planting connection, and require the difference
// against the declared lists to be EXACTLY the plant, by name. A census that
// cannot see its own plant is the finding.
//
// Nothing in this file declares what is allowed. The declared lists live in
// the test files that assert against them (the matrix's RPC and relation
// lists, `DECLARED_PRIVILEGES` in ./privilege-census.ts), so adding a surface
// is a reviewable edit to a declaration and never an edit to a query.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Anything with pg's `query` -- a Pool, or a PoolClient holding a transaction. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** The roles a browser can be. PUBLIC is the pseudo-role (`grantee = 0`),
 *  which every role -- `anon` included -- inherits. */
export const API_GRANTEES = ["anon", "authenticated"] as const;

/**
 * The schemas PostgREST exposes, READ FROM supabase/config.toml rather than
 * written down here. The RPC census used to hardcode `public`, which is the
 * only schema a function a browser can call USUALLY lives in; `graphql_public`
 * is the other one config.toml exposes, and a function granted to `anon` there
 * is exactly as callable. Deriving the list means a third exposed schema
 * lands in every census the day config.toml names it.
 */
export function exposedSchemas(root = process.cwd()): string[] {
  const toml = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const api = toml.split(/^\[/m).find((s) => s.startsWith("api]"));
  if (!api) throw new Error("supabase/config.toml has no [api] section");
  const m = api.match(/^schemas\s*=\s*\[([^\]]*)\]/m);
  if (!m) throw new Error("supabase/config.toml [api] declares no `schemas`");
  const schemas = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (schemas.length === 0) throw new Error("supabase/config.toml [api].schemas is empty");
  return schemas.sort();
}

const GRANTEE_IS_API = `(ax.grantee = 0 or pg_catalog.pg_get_userbyid(ax.grantee) in ('anon','authenticated'))`;

/** How a SECURITY DEFINER function in `public` or `private` is reached. */
export type DefinerClass = "trigger" | "api" | "service-role" | "no-api-grant";

/**
 * Phase 10 Task 12 (G26). Every SECURITY DEFINER function in `public` and
 * `private`, by signature (`schema.name(args)`), with how it can be reached:
 * a trigger; EXECUTE for a browser role (`anon`, `authenticated` or PUBLIC,
 * a null ACL counting as PUBLIC's default); EXECUTE for `service_role` only;
 * or no API role at all. definer-register.test.ts asserts the classes.
 */
export async function definerClasses(q: Queryable): Promise<{ sig: string; cls: DefinerClass }[]> {
  const { rows } = await q.query<{ sig: string; cls: DefinerClass }>(
    `select n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig,
            case
              when p.prorettype in ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype) then 'trigger'
              when exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) ax
                            where ax.privilege_type = 'EXECUTE' and ${GRANTEE_IS_API}) then 'api'
              when exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) ax
                            where ax.privilege_type = 'EXECUTE' and pg_catalog.pg_get_userbyid(ax.grantee) = 'service_role') then 'service-role'
              else 'no-api-grant'
            end as cls
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in ('public', 'private')
      order by 1`,
  );
  return rows;
}

/** Function NAMES in `public` a browser may EXECUTE -- the matrix's original
 *  census, unchanged in meaning, now callable on any connection. */
export async function publicRpcNames(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ proname: string }>(
    `select distinct p.proname
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(p.proacl) ax
      where n.nspname = 'public'
        and ax.privilege_type = 'EXECUTE'
        and ${GRANTEE_IS_API}`,
  );
  return rows.map((r) => r.proname).sort();
}

/**
 * Function SIGNATURES a browser may EXECUTE, in EVERY exposed schema.
 *
 * THE NAME CENSUS ABOVE CANNOT SEE AN OVERLOAD, and that is the denominator
 * hole this task found in it: `create function public.record_consent(p_user_id
 * uuid, ...)` beside the real one is a second, forgeable entry point with a
 * name the census already accounts for, so the name set does not move and the
 * equality stays green. PostgREST resolves an RPC by its argument NAMES, so an
 * overload is a separately callable surface. This census keys on the identity
 * signature, so an overload is a new entry.
 */
export async function exposedRpcSignatures(q: Queryable, schemas: string[]): Promise<string[]> {
  const { rows } = await q.query<{ sig: string }>(
    `select distinct n.nspname || '.' || p.proname
                  || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(p.proacl) ax
      where n.nspname = any($1::text[])
        and ax.privilege_type = 'EXECUTE'
        and ${GRANTEE_IS_API}`,
    [schemas],
  );
  return rows.map((r) => r.sig).sort();
}

/** Names in an exposed schema that carry more than one overload. */
export async function exposedOverloads(q: Queryable, schemas: string[]): Promise<string[]> {
  const { rows } = await q.query<{ name: string }>(
    `select n.nspname || '.' || p.proname as name
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1::text[]) and p.prokind in ('f','p')
      group by 1 having count(*) > 1`,
    [schemas],
  );
  return rows.map((r) => r.name).sort();
}

/** Functions in an exposed schema with NO ACL -- world-executable, and
 *  invisible to every aclexplode-based census (aclexplode(NULL) is empty). */
export async function exposedNullAclFunctions(q: Queryable, schemas: string[]): Promise<string[]> {
  const { rows } = await q.query<{ name: string }>(
    `select n.nspname || '.' || p.proname as name
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1::text[]) and p.prokind in ('f','p') and p.proacl is null
      order by 1`,
    [schemas],
  );
  return rows.map((r) => r.name);
}

/** Relations in `public` a browser holds ANY grant on, table- or
 *  column-level -- the matrix's relation census. */
export async function publicRelationsGranted(
  q: Queryable,
): Promise<{ relname: string; relrowsecurity: boolean; relkind: string }[]> {
  const { rows } = await q.query<{ relname: string; relrowsecurity: boolean; relkind: string }>(
    `select c.relname, c.relrowsecurity, c.relkind
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r','p','v','m')
        and (exists (select 1 from pg_catalog.aclexplode(c.relacl) ax where ${GRANTEE_IS_API})
             or exists (select 1 from pg_catalog.pg_attribute a
                          cross join lateral pg_catalog.aclexplode(a.attacl) ax
                         where a.attrelid = c.oid and a.attacl is not null
                           and ${GRANTEE_IS_API}))
      order by c.relname`,
  );
  return rows;
}

/**
 * EVERY privilege an API role or `service_role` holds on a relation in
 * `public`, one entry per (relation, grantee, privilege, column), where a
 * table-level grant is column `*`.
 *
 * THE RELATION CENSUS ABOVE ANSWERS "IS THIS RELATION REACHABLE AT ALL", AND
 * NOTHING ELSE -- the second denominator hole this task found. Once a table is
 * on its list, a NEW privilege on it is invisible: `grant update (status) on
 * public.consents to authenticated` leaves the relation set unchanged and the
 * equality green, while making the one append-only ledger in the product
 * writable column by column. Phase 8 lives on column-level grants
 * (`legal_documents`' eight-column anon read, `export_jobs`' two-column
 * INSERT, the DSR seam's two-column service_role UPDATE, `documents`'
 * retention-clock narrowing), so a census that cannot see a column grant
 * cannot see Phase 8. This one reads `pg_attribute.attacl` as well as
 * `pg_class.relacl`, and pins the whole set.
 *
 * `service_role` is included deliberately: it is not a browser role, but it
 * BYPASSES RLS, so its grants are the entire control on what a leaked key or
 * a server-side bug can reach (Task 5's I3). Sequences (`S`) are included
 * because a USAGE/UPDATE grant on one is a write.
 */
export async function publicPrivileges(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `with t as (
       select c.relname rel,
              case when ax.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(ax.grantee) end g,
              ax.privilege_type p, '*'::text col
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        cross join lateral pg_catalog.aclexplode(c.relacl) ax
        where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S')
       union all
       select c.relname,
              case when ax.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(ax.grantee) end,
              ax.privilege_type, a.attname::text
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_attribute a
           on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
        cross join lateral pg_catalog.aclexplode(a.attacl) ax
        where n.nspname = 'public')
     select rel || '|' || g || '|' || p || '|' || col as entry
       from t where g in ('anon','authenticated','service_role','PUBLIC')
      order by 1`,
  );
  return rows.map((r) => r.entry);
}

/** Functions in `public` the server role may EXECUTE: the runners' surface. */
export async function serviceRoleRpcSignatures(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ sig: string }>(
    `select distinct p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(p.proacl) ax
      where n.nspname = 'public'
        and ax.privilege_type = 'EXECUTE'
        and pg_catalog.pg_get_userbyid(ax.grantee) = 'service_role'`,
  );
  return rows.map((r) => r.sig).sort();
}

/**
 * The DESTRUCTIVE PRIMITIVES and who may execute each one directly.
 *
 * Derived by name, not listed: every `private` function whose name says it
 * deletes (`erase_*`, `purge_*`, `sweep_*`, and the retention sweep body).
 * Each must be executable by `postgres` alone -- they are reached only through
 * the guarded definer entry points (`run_erasure_job`, `run_retention_sweep`),
 * whose gates are what the rest of the suite proves. A grant of one of these
 * to ANY other role, `service_role` included, is a path around those gates.
 */
export async function destructivePrimitiveAcl(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `select p.proname || '|' || coalesce(
              (select pg_catalog.string_agg(
                        case when ax.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(ax.grantee) end,
                        ',' order by 1)
                 from pg_catalog.aclexplode(p.proacl) ax where ax.privilege_type = 'EXECUTE'),
              'NULL-ACL') as entry
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private'
        and (p.proname ~ '^(erase|purge|sweep)_' or p.proname = 'retention_sweep_body')
      order by 1`,
  );
  return rows.map((r) => r.entry);
}

/** Storage buckets as `id|public=<bool>`. */
export async function storageBuckets(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `select id || '|public=' || public::text as entry from storage.buckets order by id`,
  );
  return rows.map((r) => r.entry);
}

/**
 * PERMISSIVE policies on any `storage` table. There must be none: storage has
 * RLS on and NO permissive policy, which is what makes it deny-all to every
 * client role (the RESTRICTIVE per-bucket fences are defence in depth). One
 * permissive policy for `authenticated` would open every bucket at once --
 * including `exports`, which holds whole-workspace archives.
 */
export async function storagePermissivePolicies(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `select tablename || '|' || policyname as entry from pg_catalog.pg_policies
      where schemaname = 'storage' and permissive = 'PERMISSIVE' order by 1`,
  );
  return rows.map((r) => r.entry);
}

/** The per-bucket RESTRICTIVE fences, as `bucket|cmd`. */
export async function storageFences(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `select pg_catalog.substring(coalesce(qual, with_check), $$bucket_id <> '([^']+)'$$)
              || '|' || cmd as entry
       from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects' and permissive = 'RESTRICTIVE'
        and roles @> array['anon','authenticated']::name[]
      order by 1`,
  );
  return rows.map((r) => r.entry);
}

/** Every scheduled job, as `jobname|schedule|command`. */
export async function cronJobs(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ entry: string }>(
    `select jobname || '|' || schedule || '|' || command as entry from cron.job order by jobname`,
  );
  return rows.map((r) => r.entry);
}

/**
 * The private functions the ONE tick calls, read out of its own body. The
 * product has exactly one clock (`run_incident_alert_tick`), and Phase 8 added
 * three halves to it (export delivery, erasure delivery, the retention sweep)
 * alongside Phase 7's two. A sixth half is a new scheduled behaviour that no
 * cron census would see, because the cron row itself does not change.
 */
export async function tickCallees(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ src: string }>(
    `select p.prosrc as src from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'run_incident_alert_tick'`,
  );
  if (rows.length !== 1) throw new Error(`expected one private.run_incident_alert_tick, found ${rows.length}`);
  const body = rows[0].src.replace(/--[^\n]*/g, "");
  return [...new Set([...body.matchAll(/private\.([a-z_0-9]+)\s*\(/g)].map((m) => m[1]))].sort();
}

/** `declared` vs `actual`, as the two lists a reader needs. */
export function difference(actual: readonly string[], declared: readonly string[]) {
  const a = new Set(actual);
  const d = new Set(declared);
  return {
    unaccounted: [...a].filter((x) => !d.has(x)).sort(),
    missing: [...d].filter((x) => !a.has(x)).sort(),
  };
}
