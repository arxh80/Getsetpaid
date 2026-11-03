# Phase 8 Task 9a, fix round 1: SCOPED RE-REVIEW

Range `4940809..e29e4a0`, worktree `legal-phase`, 216 migrations. Read-only
on code. I ran no reset, no psql runner, no integration vitest, no Playwright
and no dev server. Every result below comes from reading the diff, the
migrations it touches, and the code that reads or writes the same objects.
The gate results are taken from the report.

**VERDICT: READY.** I1, m1, m2, m3 and m5 are all closed. Nothing new is
Critical, Important or Minor. Two informational notes follow.

## Per finding

- **I1: CLOSED.** The two code comments, the comment in
  `tests/unit/email/send.test.ts` and `docs/email-setup.md` are now
  host-neutral. I re-ran
  `git grep -niE "serverless|vercel|lambda"`, leaving out node_modules,
  `.agents` and the lockfiles. What is left:
  - `.gitignore` boilerplate;
  - tooling names: the `web-design-guidelines` mention in DESIGN.md, and
    `@vercel/analytics` on the storage-census deny list;
  - the two immutable migration comments that SECURITY.md § 15 names.

  So the new SECURITY.md sentence is true as written. It describes the
  deny-list entry loosely as a "tooling name", and that is fair.

- **m1: CLOSED.** `20261012000000` reissues only the `comment on function`.
  It names `20261003010000` as the base and records the correction. The
  function body is untouched. The shipped header stays immutable, and the
  report records that correction.

- **m2: CLOSED, and nothing else broke.** The checks:
  - **The writers.** There are exactly three, all read:
    - `set_retention_enabled()` SETs `enabled, audit_purge_enabled, reason,
      updated_at, updated_by`. The trigger still fires on it, and the RPC
      stamps `now()` explicitly anyway.
    - `release_audit_purge_ceiling()` SETs only `audit_ceiling_*`. Correctly,
      the trigger no longer fires.
    - The test-tidy writers (e2e `clearAuditCeilingRelease` and the matrix
      `finally`) also write only `audit_ceiling_*`. Correctly, nothing is
      stamped.

    `updated_by` and `reason` belong only to the switches. No other column on
    the table deserves a stamp: the table has `id`, the switches, `updated_at`
    and `audit_ceiling_*`.
  - **Firing semantics.** `UPDATE OF col-list` fires when ANY listed column
    appears in the SET target list, whatever else the statement also SETs. So
    a multi-column UPDATE that names one switch column is stamped. The
    `WHEN (old.* is distinct from new.*)` clause is unchanged, so a no-op
    write is still not stamped, as before.
  - **The audit of switch changes.** It is written by the RPC through
    `log_audit_event` from `v_before`/`v_after`. It does not depend on the
    trigger, so it is unaffected.
  - **Readers of `updated_at`.** The only one is `lib/admin/retention.ts:76/101`,
    which feeds the panel's "Last changed" line, and that line is the reading
    this fix makes true.
  - **The censuses.** L5 checks the trigger only by name (`tgname`), so the
    name is kept and it still passes. The clock-roll guard check (RK32a) reads
    column lists, but it applies only to classified clock columns.
    `retention_settings.updated_at` is not one: only the two
    `audit_ceiling_*` columns are classified, with no trigger guard. So
    narrowing this trigger changes no census.
  - **REL11b proves the positive case.** It writes `reason` (a switch column)
    after the value is pinned to 2001 and asserts `updated_at > 2001`. It
    goes red if the trigger is dropped, or if the column list stops naming
    `reason`. Mutant 19a (the plain trigger) covers the other direction: REL9a
    goes red because the pin is overwritten, and REL11a goes red because the
    release stamps the time. REL11b itself has no dedicated mutant, but the
    reasoning is direct.

    Its restore UPDATE puts `reason` back exactly, using a 13-character
    suffix strip, or `nullif` to null. It does leave `updated_at = now()`, but
    no later assertion reads `updated_at`.

- **m3: CLOSED.** Q197 is queued with the built scope as the default.

- **m5: CLOSED, and the test WOULD go red under per-(user, org) keying.**
  Counters are keyed `(category, subject_scope, subject_id, window_start)`.
  `uploads` is `subject_scope = 'user'`, so `subject_id = auth.uid()`.
  - **Per-org keying.** If the budget were keyed per organisation, or per
    (user, org) through any extra key part, the org-B upload would open a
    fresh counter and succeed. The test fails three ways:
    - `result.error` fails `toMatch` on the limiter sentence;
    - `objectsUnderOrg(orgB)` would be 1, not 0;
    - the B `documents` count would be 1, not 0.
  - **Org-subject keying.** `uploadCounter()` would also read 11, not 12.

  The denominator (an active Manager membership in B, and an empty B) rules
  out a permission refusal passing for the meter. So does the refusal's exact
  sentence. The test was not mutation-tested, but the reasoning is direct.

- **m4:** this round does nothing for it, as the report says. It belongs to
  the controller.

## New findings

None that are Critical, Important or Minor.

**Informational.**

- **n1. A possible false red at the hour boundary.** The limiter uses fixed,
  epoch-aligned hourly windows (`rate_limit_window_start`). The new twelfth
  upload adds one more chance for a run to straddle the top of the hour.
  If that happens, the 12th lands in a fresh window and succeeds, and the
  test goes falsely red. It can never go falsely green, and the 11th already
  had this exposure. No action needed. If it ever flakes, look here first.
- **n2. The 19a mutant does not isolate REL11b.** A "trigger dropped" mutant
  would be the direct one. It is not worth adding: REL11b's failure under a
  dropped trigger needs no measurement to see.
