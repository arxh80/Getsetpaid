# Parallel stacks, and which gate to run when

Two things live here, because they are the same problem seen twice: a change
that should take a minute to check costs twenty.

1. **Parallel stacks** — how a worktree claims its own local Supabase stack so
   two sessions stop serialising behind one database and one port 3000.
2. **Tiered gates** — which gate to run while iterating, and the rule that the
   full five-gate sweep is still mandatory before any handback or review.

It is `docs/parallel-stacks.md` rather than a section of `DESIGN.md` on
purpose: `DESIGN.md` is the colour/type/spacing token contract that every UI
change is read against, and a local-development recipe in the middle of it
would make that document harder to use for the thing it exists for. `CLAUDE.md`
points here instead.

---

## 1. Parallel stacks

### The problem

`supabase/config.toml` is committed with one `project_id` and one fixed port
range. The CLI names every container after `project_id`
(`supabase_db_getsetpaid`, …) and binds the ports that file names, so two
worktrees cannot both run a stack: the second `supabase start` either adopts
the first one's containers or fails on a bound port.

The consequence is not theoretical and is in `MEMORY.md`: every worktree on
this machine shares one database and one port 3000, every test run is
exclusive, and a `db reset` in one worktree wipes another session's fixtures
mid-run. The "flaky container" was always this.

### What the Supabase CLI actually supports

Measured against **2.116.0** on 2026-09-21 by probing, not by reading blog
posts. The answers decided the design, so they are written down:

| Probe | Result |
|---|---|
| `port = "env(GSP_API_PORT)"` | **Works.** `env()` substitution is not limited to string fields; an integer field takes it. |
| `env(VAR:-54321)`, `env(VAR:54321)`, `${VAR:-54321}` | **All fail** with `CliConfigParseError`. There is no default syntax. |
| `env(VAR)` in an integer field, variable **unset** | **Fails** with `CliConfigParseError`. |
| `project_id = "env(VAR)"`, variable **unset** | **Does not fail.** It silently becomes the literal `env_VAR_` — a whole separate, empty stack. Worse than a crash. |
| `--workdir <dir>` and `SUPABASE_WORKDIR=<dir>` | **Both honoured.** With `SUPABASE_WORKDIR` pointed elsewhere, `supabase status` run from inside this worktree reported the *other* project's containers. |
| A `.env` in the **workdir** | **Read** by the CLI for `env()` substitution. |

Rows 2 and 4 are why `env()` does **not** go into the committed
`config.toml`: it would break the stack for anyone who has not set the
variables, and in the `project_id` case it would break it silently.

Row 5 is the mechanism.

### The design

The committed `supabase/config.toml` is never touched, never rewritten in
place, and keeps working byte-for-byte for anyone who does nothing. That is
**slot 0**: project `getsetpaid`, ports 5432x, app on 3000.

A worktree **opts in** by generating `.supabase-slot/` — gitignored — a small
overlay Supabase project directory:

```
.supabase-slot/
  slot.json          what was claimed (ports, app port, project id)
  .env               copied from the repo root's .env if one exists
  supabase/
    config.toml      the committed file with project_id and all 8 ports shifted
    migrations/  ->  link to ../../supabase/migrations
    templates/   ->  link to ../../supabase/templates
    tests/       ->  link to ../../supabase/tests
    seed.sql         a copy, refreshed on every claim
```

The links are real directory links (a junction on Windows, which needs no
elevation; a symlink elsewhere), so the migrations a slot applies **cannot**
drift from the ones in the tree. `seed.sql` is a file and Windows junctions
cannot point at one, so it is copied — and re-copied on every `claim`.

Slot *N* (1–9) shifts every port by `N*100` and the app port by `N`:

| slot | project_id | API | db | studio | mailpit | app |
|---|---|---|---|---|---|---|
| 0 | `getsetpaid` | 54321 | 54322 | 54323 | 54324 | 3000 |
| 1 | `getsetpaid_s1` | 54421 | 54422 | 54423 | 54424 | 3001 |
| 2 | `getsetpaid_s2` | 54521 | 54522 | 54523 | 54524 | 3002 |

`shadow_port`, `db.pooler.port`, `analytics.port` and
`edge_runtime.inspector_port` move by the same stride. The CLI's block is
54320–54329, so a 100-wide stride keeps slots disjoint with room to spare.

`scripts/stack.mjs` asserts that every literal it expects to rewrite was
actually found, so a future edit that renames a port turns into a loud failure
in the generator rather than a stack that half-collides.

### Claiming a stack

```bash
pnpm stack:claim            # lowest free slot
pnpm stack:claim -- --slot 2
```

It refuses a slot whose containers already exist for another worktree, and a
slot any of whose ports are already bound.

Then **export the variable it prints**:

```bash
export SUPABASE_WORKDIR="…/worktrees/<name>/.supabase-slot"     # bash
$env:SUPABASE_WORKDIR = "…\worktrees\<name>\.supabase-slot"     # pwsh
```

```bash
npx supabase start
npx supabase db reset
pnpm dev                    # serves on 3000+slot
```

### What follows the slot, and what does not

**Automatically, with no export** — because they auto-detect `.supabase-slot/`:

- `pnpm dev` (`scripts/dev.mjs` → `scripts/dev-env.mjs`): writes
  `.env.development.local` with that stack's `NEXT_PUBLIC_SUPABASE_URL`, anon
  key, service-role key, `NEXT_PUBLIC_SITE_URL` and `PORT`, and passes the port
  to `next dev`.
- `playwright.config.ts`: `baseURL` and the `webServer` url read
  `.supabase-slot/slot.json`.
- `supabase/tests/run-rls-tests.sh` and `run-one.sh`: container name and API
  URL, both of which used to be constants.

**Only if `SUPABASE_WORKDIR` is exported** — because they shell out to
`supabase status` and inherit the environment:

- `pnpm test` / `pnpm test:rls` (`tests/integration/rls/support/env.ts`)
- `pnpm test:e2e`'s fixtures (`tests/e2e/support/fixtures.ts`)
- **any bare `npx supabase …` you type**

That last one is the sharpest edge in this whole design, so it is stated
rather than implied: **in a claimed worktree with `SUPABASE_WORKDIR` unset, a
bare `npx supabase db reset` resets the SHARED stack** — exactly the accident
this change exists to prevent. Export the variable in the shell you work in.
`pnpm stack:info` tells you whether it is set.

### Tearing one down

```bash
pnpm stack:release
```

`supabase stop` for that project, then delete `.supabase-slot/`. If the stop
fails, the containers are named after the project and can be removed by hand:
`docker rm -f $(docker ps -aq --filter name=getsetpaid_s1)`.

### What it costs

Measured for slot 1 on this machine, idle, right after `supabase start`:

```
analytics 583 MiB   realtime 249   storage 241   studio 189   db 169
kong 93   pg_meta 85   edge_runtime 26   rest 19   auth 12   inbucket 7
                                                      ≈ 1.6 GiB per stack
```

Plus a few hundred MB per `next dev`. On an 8 GiB machine that is realistically
**two stacks, three at a squeeze** — the second one is cheap in disk (the
images are shared) and expensive in RAM. `analytics` is the biggest single
consumer and is excludable with `supabase start -x logflare` if a slot is
short of memory and nobody needs the logs.

### What still cannot be parallelised

- **Docker itself.** One daemon, one image cache. Two `supabase start`s at the
  same moment contend on it; run them one after the other.
- **Anything hosted.** `pnpm build`, `pnpm start` and `supabase link`/`config
  push` resolve to the one hosted project. Unchanged, and still forbidden from
  a worktree deliberately unlinked from it.
- **The `.env.development.local` in each worktree** is per-worktree already, so
  it is fine — but `pnpm dev` regenerates it every run, so a slot change takes
  effect only on the next `pnpm dev`.
- **Slot 0.** Nothing here claims it, stops it or reconfigures it. If two
  worktrees both decline to claim, they are back to sharing.
- **Ports outside the CLI's range** that something else on the machine binds.
  `claim` checks the eight it is about to use and refuses if any is taken; it
  cannot check ports it does not know about.

---

## 2. Tiered gates

### The rule

**The five gates are the gate.** `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:rls` and `pnpm test:e2e`, plus the psql/HTTP suite after a reset,
all of them, before **any** handback, review request, PR or "this is done".
The tiering below is for the **iteration loop only** — the ten minutes between
"I think I see the bug" and "I think I have fixed it". It is never the
evidence for a claim.

Two reasons that line is absolute here. The suites are not independent: an
earlier psql suite builds the fixtures a later one reads, and a change that
breaks the earlier one passes a single-suite re-run and fails the gate. And
this project's own history is that the defects which mattered were found by
the browser suite and by nothing else — four Phase 2 UI defects were green
across 800+ unit tests, 850 psql assertions and 174 HTTP checks at the moment
a human found them.

### While iterating

| You changed | Run this |
|---|---|
| One `.sql` test file | `bash supabase/tests/run-one.sh rls_phase8_exports.sql` |
| A migration | the psql suites that touch it, then the full runner after a reset |
| One unit test / the function under it | `pnpm exec vitest run --project unit tests/unit/<path>.test.ts` |
| One integration test | `pnpm exec vitest run --project integration tests/integration/<path>.test.ts` |
| One Playwright spec | `npx playwright test tests/e2e/<name>.spec.ts` |
| One test inside a spec | `npx playwright test tests/e2e/<name>.spec.ts -g "<title fragment>"` |
| Types only | `npx next typegen && pnpm typecheck` |

All six commands were run or listed against this repo rather than guessed:

- `vitest.config.ts` defines exactly two projects, **`unit`** and
  **`integration`**, so `--project` takes one of those two names and nothing
  else. `pnpm exec vitest run --project unit tests/unit/legal/sub-processors-drift.test.ts`
  reports `1 passed (1) / 5 passed (5)`.
- `npx playwright test tests/e2e/brand.spec.ts --list` lists that file's three
  tests, so the same command without `--list` runs them. `-g` is Playwright's
  own title filter.
- `supabase/tests/run-one.sh` is new, because there was no way to run one psql
  suite: `run-rls-tests.sh` hands each suite a `-v` array of fixture user uuids
  and session claims it mints over the Auth admin API, and nothing could
  reconstruct them afterwards. The runner now writes each array to
  `supabase/tests/.last-run-vars.sh` (gitignored) as it builds it, and
  `run-one.sh` replays it.

### What `run-one.sh` deliberately is not

It needs a completed full run first (that is where the fixtures come from). It
does **not** reset the database, does **not** run the HTTP sections, and does
**not** run the suites before the one named. Most of these suites are not
idempotent — that is exactly why the full runner refuses to run twice without a
reset — so a second `run-one.sh` of the same file sees its own previous rows.
Read it as "did my edit compile and say what I meant", never as "this suite
passes".

### Before handback — the sweep, in order

```bash
pnpm lint
npx next typegen && pnpm typecheck      # typegen only if routes changed, harmless otherwise
pnpm test                               # unit + integration; includes test:rls
npx supabase db reset && bash supabase/tests/run-rls-tests.sh
pnpm test:e2e
```

On a claimed slot, `SUPABASE_WORKDIR` must be exported for the third, fourth
and fifth of those. On slot 0, announce the run to whoever else is on this
machine first — the `MEMORY.md` claim/release protocol still applies to the
shared stack, and is precisely what claiming a slot lets you stop doing.
