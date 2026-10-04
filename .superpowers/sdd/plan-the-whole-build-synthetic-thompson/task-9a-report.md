# Task 9a report

## Job 1 (req 1-3)

Founder rulings 2026-09-30, Q142 / Q145, plus Q187's clause. Tip before: 1302fc3 (210 migrations). Commits (pushed): 2ee09fd, 8cc0688, 8ec4a3a, and this report.

**What changed**
- **Q142:** IONOS SE (Germany) is now in `docs/sub-processors.md` AND `lib/legal/sub-processors.ts`. Its location is "Incorporated in Germany (EU); server region PENDING — the server has not been set up yet". The DPA is not signed, and the transfer basis says "Not yet confirmed". The binding is `tests/unit/legal/sub-processors-drift.test.ts`, which already compared location and DPA status. It gained one test that requires the IONOS row in both lists with PENDING. Mutation: naming a region in the register's IONOS cell turns "gives each the same location" red.
- **Host assumptions removed** (8cc0688): "Vercel box" in `lib/format/date.ts`, "Vercel builds" in `scripts/dev-env.mjs`, "edge/serverless runtime this app deploys to" in `lib/email/send.ts`, and "so Vercel" in FOLLOW-UPS.md. Left alone: shipped migration comments (immutable) and tooling mentions (`.vercel/`, the vercel-* skills, the `@vercel/analytics` tracker pattern).
- **SECURITY.md § 15:** the "Project region" item now reads Ireland (eu-west-1). Verifying it is now what makes the published sentence true. A new item covers the IONOS host, region PENDING, and what must happen when the server is bought.
- **Q145:** the Supabase row now reads "data hosted in Ireland (eu-west-1)", and the "(deployment setting)" marker is gone.
- **CLAUDE.md:** the sub-processor and legal paragraphs, and the psql total, were corrected.

**Versions published** (migration `20261008000000_legal_pages_name_the_hosts.sql`, 210 -> 211). Each version is built by exact replacement and published by id. The migration refuses to run if any of these pages has already moved past the version shown. None of the new versions is reviewed.
- privacy 3 -> 4
- data-processing-addendum 4 -> 5
- security 2 -> 3: drops only the region marker and keeps the other 7 markers.
- subprocessors 2 -> 3
- data-retention 6 -> 7: Q187's "judged when the document is deleted". The sentence `rls_phase8_retention.sql` § RL binds is kept verbatim.

**Pins moved (old -> new)**
- Legal psql suite: `run_suite` 168 -> 171. The 3 new checks are LF2o, LF2p and LF2q: the hosts are named, the 4 superseded versions serve as the denominator, and Q187 is covered.
- LF1: 32 -> 37 rows. LO1: 34 -> 39. LF2: `1=8,2=3,3=1,4=1,5=1,6=1` -> `1=8,2=1,3=2,4=1,5=2,7=1`.
- LF2i: DPA 4 -> 5 and retention 6 -> 7. LF2l: retention 6 -> 7. LF2b: superseded list gains dpa:4, retention:6, privacy:3, security:2, subprocessors:2.
- HTTP block: the version map for "15 current rows intact".
- psql total: 3858 -> 3861.
- `seed-matches-catalogue.test.ts`:
  - The walk's denominator gains the new migration.
  - The hosting rule is stricter. A hosting line must name "Ireland (eu-west-1)" with no marker, and any line naming IONOS must say "pending".
  - It gains a new Task 9a describe block (16 tests).
  - Mutations: an IONOS host "in London" turns 2 tests red, and so does a page that goes back to "UK/EU region".
- `legal.spec.ts`: the Subprocessors table now asserts Ireland, IONOS SE, PENDING, and no "(deployment setting)".

**Results**
- lint and typecheck (after `next typegen`): clean.
- RLS run 1 after a reset: 1 red, LO1, an unmoved pin, fixed.
- RLS run 2 after a fresh reset: all suites passed, HTTP "all checks passed". Migrations 211 -> 211 on both runs.
- vitest `tests/unit` + `tests/integration/legal`: 104 files, 2348 passed.
- e2e `legal.spec.ts` after a fresh reset: 7 passed, 211 migrations.
- The stack was reset at the end.

**Questions:** Q193 is new in DECISIONS-QUEUE.md: "Ireland (eu-west-1)" is now stated as a fact that nothing automated checks. Default: the § 15 pre-launch check covers it.
