"use client";

import { useActionState } from "react";
import Link from "next/link";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import {
  deleteClosedWorkspaceAction,
  reassignClosedWorkspaceAction,
} from "@/lib/admin/closures";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The /super/closures decision list (Phase 8 Task 9c job 3a).
//
// THE ACTION STATE LIVES ABOVE THE ROWS, for the reason
// components/admin/organisation-lifecycle-forms.tsx's WoundDownOrganisationsList
// found in a browser: a successful decision revalidates the page, the server
// re-renders the list WITHOUT the decided workspace, and a confirmation that
// lived inside that row would unmount with it -- a silent success on an
// audited, privileged action. Hoisted here, the confirmation survives.
//
// Field errors are routed to the ONE row whose slug the failed submission
// carried, so a mistake on one workspace does not paint every row red.

export interface ClosureRowView {
  readonly organisationId: string;
  readonly name: string;
  readonly slug: string;
  readonly closedAt: string | null;
  readonly purgeDueAt: string | null;
  readonly purgeDays: number | null;
  readonly activeMembers: number;
  readonly backupLabel: string;
  readonly candidates: readonly { userId: string; label: string }[];
  /** The picker's next page of members, when this page was full (Q224). */
  readonly membersNextHref: string | null;
  /** Back to the picker's first page, when this is a later one. */
  readonly membersFirstHref: string | null;
}

export function ClosedWorkspaceDecisions({ rows }: { rows: readonly ClosureRowView[] }) {
  const [reassign, reassignAction, reassigning] = useActionState(
    reassignClosedWorkspaceAction,
    EMPTY_FORM_STATE,
  );
  const [remove, removeAction, removing] = useActionState(
    deleteClosedWorkspaceAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="flex flex-col gap-4">
      {reassign.error ? <Alert tone="error">{reassign.error}</Alert> : null}
      {reassign.message ? <Alert tone="success">{reassign.message}</Alert> : null}
      {remove.error ? <Alert tone="error">{remove.error}</Alert> : null}
      {remove.message ? <Alert tone="success">{remove.message}</Alert> : null}

      {rows.length === 0 ? (
        <div className="flex max-w-prose flex-col gap-2 border-t border-rule pt-4">
          <p className="text-base font-semibold text-ink">
            No workspace is waiting for a decision.
          </p>
          <p className="text-base text-ink-muted">
            When an Owner closes their own workspace from its settings, it
            appears here and you are emailed. It is read-only for its members
            from that moment, a full backup is taken automatically, and you
            then either hand it to one of its active members as the new Owner
            — which reopens it — or delete it permanently. If nobody decides,
            the standard retention purge removes it when its clock runs out.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {rows.map((row) => (
            <ClosureRow
              key={row.organisationId}
              row={row}
              reassignAction={reassignAction}
              removeAction={removeAction}
              reassigning={reassigning}
              removing={removing}
              reassignState={reassign.values?.organisationSlug === row.slug ? reassign : EMPTY_FORM_STATE}
              removeState={remove.values?.organisationSlug === row.slug ? remove : EMPTY_FORM_STATE}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClosureRow({
  row,
  reassignAction,
  removeAction,
  reassigning,
  removing,
  reassignState,
  removeState,
}: {
  row: ClosureRowView;
  reassignAction: (data: FormData) => void;
  removeAction: (data: FormData) => void;
  reassigning: boolean;
  removing: boolean;
  reassignState: FormState;
  removeState: FormState;
}) {
  const headingId = `closure-${row.organisationId}`;
  return (
    <li className="flex flex-col gap-5 border-b border-rule py-6" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-lg font-bold text-ink">
          {row.name}
        </h3>
        <span className="text-sm text-ink-muted">/{row.slug}</span>
      </div>

      <dl className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Closed</dt>
          <dd className="text-ink tabular-nums">{row.closedAt ?? "—"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Purge due</dt>
          <dd className="text-ink tabular-nums">
            {row.purgeDueAt ?? "—"}
            {row.purgeDays !== null ? (
              <span className="text-ink-muted">
                {" "}
                (<span className="tabular-nums">{row.purgeDays}</span>{" "}
                {row.purgeDays === 1 ? "day" : "days"})
              </span>
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Active members</dt>
          <dd className="text-ink tabular-nums">{row.activeMembers}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">Backup</dt>
          <dd className="text-ink">{row.backupLabel}</dd>
        </div>
      </dl>

      <div className="grid gap-8 lg:grid-cols-2">
        <form action={reassignAction} className="flex flex-col gap-4">
          <input type="hidden" name="organisationSlug" value={row.slug} />
          <h4 className="text-base font-bold text-ink">Reassign to a new Owner</h4>
          <p className="text-sm text-ink-muted">
            Makes the member you pick an Owner and reopens the workspace
            immediately. Nothing is lost; the purge clock is cancelled.
          </p>
          {row.candidates.length === 0 ? (
            <p className="text-sm font-semibold text-ink">
              No active member is left to take it over, so it can only be
              deleted — or left to the retention purge.
            </p>
          ) : (
            <>
              <SelectField
                label="New Owner"
                name="newOwnerUserId"
                required
                defaultValue={reassignState.values?.newOwnerUserId ?? ""}
                error={reassignState.fieldErrors?.newOwnerUserId}
              >
                <option value="" disabled>
                  Pick an active member
                </option>
                {row.candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.label}
                  </option>
                ))}
              </SelectField>
              {row.membersNextHref || row.membersFirstHref ? (
                <nav aria-label={`More members of ${row.name}`} className="flex flex-wrap gap-6 text-sm">
                  {row.membersFirstHref ? (
                    <Link
                      href={row.membersFirstHref}
                      className="text-primary underline underline-offset-4 hover:text-ink"
                    >
                      First members
                    </Link>
                  ) : null}
                  {row.membersNextHref ? (
                    <Link
                      href={row.membersNextHref}
                      className="text-primary underline underline-offset-4 hover:text-ink"
                    >
                      More members
                    </Link>
                  ) : null}
                </nav>
              ) : null}
              <TextAreaField
                label="Reason"
                name="reason"
                required
                rows={2}
                maxLength={500}
                defaultValue={reassignState.values?.reason ?? ""}
                error={reassignState.fieldErrors?.reason}
                hint="Goes on the permanent audit record. Not shown to the workspace."
              />
              <div>
                <Button type="submit" variant="primary" pending={reassigning} pendingLabel="Reassigning…">
                  Reassign and reopen
                  <span className="sr-only"> — {row.name}</span>
                </Button>
              </div>
            </>
          )}
        </form>

        <form action={removeAction} className="flex flex-col gap-4">
          <input type="hidden" name="organisationSlug" value={row.slug} />
          <h4 className="text-base font-bold text-ink">Delete permanently</h4>
          <p className="text-sm text-ink-muted">
            The next hourly sweep removes its files and then every record.
            This cannot be undone once the sweep has run.
          </p>
          <Field
            label="Type the URL name to confirm"
            name="confirmSlug"
            required
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            autoComplete="off"
            defaultValue={removeState.values?.confirmSlug ?? ""}
            error={removeState.fieldErrors?.confirmSlug}
            hint={`Exactly: ${row.slug}`}
          />
          <TextAreaField
            label="Reason"
            name="reason"
            required
            rows={2}
            maxLength={500}
            defaultValue={removeState.values?.reason ?? ""}
            error={removeState.fieldErrors?.reason}
            hint="Goes on the permanent audit record. Not shown to the workspace."
          />
          <div>
            <Button type="submit" variant="danger" pending={removing} pendingLabel="Deleting…">
              Delete permanently
              <span className="sr-only"> — {row.name}</span>
            </Button>
          </div>
        </form>
      </div>
    </li>
  );
}
