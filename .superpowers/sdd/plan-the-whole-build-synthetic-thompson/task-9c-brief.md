# Task 9c — Founder ruling 2026-09-30: an Owner may close their own workspace

This is a founder ruling: Q176 and Q178 changed. It **reverses Q104's "no customer closure"**. CLAUDE.md already says "customer-initiated closure, if wanted, is a fourth audited RPC rather than a column write". This task builds that RPC.

Read these first:
- `progress.md` § "Standing lessons"
- the Phase 7 org-lifecycle RPCs and `private.organisation_lifecycle_guard()`
- the Task 4 export pipeline
- the 60-day purge (Q88)
- the Phase 7 superuser dashboard

## Requirements

1. **Add a fourth audited RPC that lets an Owner close their own workspace.** This is what lets an Owner delete their own account without first handing over ownership.
   - It requires aal2 step-up, a typed confirmation and a mandatory reason.
   - The lifecycle guard and the Owner-update policy stay as they are. The only way to close a workspace is through this RPC.
2. **Closing automatically takes a full workspace backup.**
   - Use the Task 4 export pipeline (bounded and async).
   - Retain the backup according to the retention function.
3. **Closing emails the superuser and adds an item to the superuser dashboard.** From that item the founder either **reassigns the workspace to a new Owner** or **deletes it permanently**. Both actions:
   - are gated by step-up
   - require a reason
   - are audited
   - notify the org's remaining admins
4. **A closed workspace is read-only for its members.**
   - Reads still work; the server refuses every write.
   - If the founder takes no action, the existing **60-day purge still applies**.
5. **Update CLAUDE.md's Q104 paragraph** as the correction of record.

## Discipline

- **Mutation-test every guard, and record what goes red in which layer.** The guards are:
  - the RPC's role check
  - the aal2 requirement
  - the write refusal while closed
  - the superuser gate on reassign and delete
- **Tenant-boundary tests:** RLS and tenant-breakout tests for the closed state.
- **e2e:** cover the Owner closure flow and the superuser's decision item. Axe-scan any new page.
- **Registries:** update the pinned totals, the matrix and the audit catalogue.
- **Gates:** run all five. Run the psql suite twice on the same database.
- **Commits:** one logical change per commit. Commit and push each one.
- **Report** to `task-9c-report.md`.
