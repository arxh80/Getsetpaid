### Task 21: Owners and Admins can remove a member and change a role (audit finding 4, High)

Added 2026-10-18 from the whole-repo audit the founder ran ("fix all"). It runs **after Task 2's fix phase**, because that phase fixes F2 (an Admin can grant or remove the Owner role). Shipping this UI before F2 would hand the takeover to every Admin.

**The gap:** `app/(app)/[orgSlug]/members/page.tsx` lists members and has an invite form, and nothing else. `lib/org/actions.ts` exports only `createOrganisationAction`, `inviteMemberAction` and `acceptInviteAction`. No screen removes a member, cancels an invitation or changes a role. A Booker who leaves the company keeps reading every contact and event until someone edits the database by hand. The PRD (§ roles) gives the Owner "user/role management", and `CLAUDE.md` gives the Owner/Admin "Manage users". The database half already exists: the UPDATE and DELETE policies on `organisation_memberships` (`20260828220000`, with Task 2's F2 terms), the keep-an-owner trigger (`20261001001000`, `20261003006000`) and the `membership.*` audit triggers (`20261006000000`).

**Files:**
- Modify: `lib/org/actions.ts` (two Server Actions), `app/(app)/[orgSlug]/members/page.tsx` (the controls, shown only to a caller holding `manage_members`), one small client component under `components/org/` for the row controls
- Test: `tests/integration/org/member-management.test.ts`, `tests/e2e/members.spec.ts` (with an axe scan of the members page as an Owner)
- Docs: `SECURITY.md` § 2 (member management as built), `docs/launch-gates.md` (new row **G33, High**, "Closed in <sha>")

**Coordinator decisions:**
1. Both actions write through the caller's RLS-bound client (`createClient()`), never service-role. The policies, the keep-an-owner trigger and the audit triggers are the control. The action only maps refusals to sentences: 42501 means "you can't change that member", and the keep-an-owner refusal means "a workspace needs at least one active Owner".
2. **Remove** is the existing hard `DELETE` (audited as `membership.deleted`). The same action cancels a pending invitation, which is a `DELETE` of a `status = 'invited'` row.
3. **Change role** offers `INVITABLE_ROLES` (`lib/org/roles.ts`), plus `owner` only when the caller is an Owner. The database refuses the rest whatever the form sends.
4. No step-up at MVP. Both roles that hold `manage_members` are MFA-required, so these actions already run at aal2. Queue the founder question "does removing a member or changing a role need step-up? (default: no, aal2 already required)" as the next free Q.
5. Removal takes effect on the removed person's next request, because every read re-checks membership in the database. Do not revoke their sessions: they may belong to other workspaces.
6. Not built (name them in the report): self-service "leave workspace", ownership transfer as a separate flow, bulk actions.

- [ ] **Step 1: Failing tests.** Integration, driving the actions directly with `orgSlug` (the house pattern, see `uploadDocumentAction`):
  - an Owner removes a Booker: the row is gone, and the Booker's own client then reads 0 contacts in that workspace
  - an Admin removes a Booker
  - an Admin cannot remove or demote an Owner (refused; relies on F2)
  - the last active Owner cannot demote or remove themselves (the keep-an-owner sentence)
  - a Booker calling either action is refused, with the row unchanged
  - a foreign workspace's slug is refused
  - cancelling a pending invite deletes the row

  e2e: an Owner removes a member through the UI, and that member's next page load in the workspace gets the streamed not-found contract (`DESIGN.md` § Error pages). Red first.
- [ ] **Step 2: The actions and the controls.** Follow `DESIGN.md`. The remove button uses the existing delete-confirmation pattern (focus round-trip, as in `keyboard.spec.ts`).
- [ ] **Step 3: Mutant.** Swap the action's client for the service-role client, and "a Booker calling either action is refused" goes red. Record it.
- [ ] **Step 4: Gates.** `pnpm lint`, `npx next typegen`, `pnpm typecheck`, `pnpm test`, the new e2e spec plus `tenant-breakout.spec.ts` and `accessibility.spec.ts` with `--workers=1`. Update the docs. Commit per logical change, push.

---

