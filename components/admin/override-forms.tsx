"use client";

import { useActionState, useState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { useRevealFocus } from "@/components/ui/use-reveal-focus";
import {
  grantBillingOverrideAction,
  grantFeatureOverrideAction,
  revokeBillingOverrideAction,
  revokeFeatureOverrideAction,
} from "@/lib/admin/overrides";
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_LABELS,
  OVERRIDE_TIER_CHOICES,
  TIER_CHOICE_LABELS,
} from "@/lib/admin/overrides-contract";
import { Field, TextAreaField, SelectField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The two grant forms, and the two revoke-capable lists.
//
// TYPED GRANT FORMS, A REVEAL-CONFIRM REVOKE -- the same split
// components/admin/organisation-lifecycle-forms.tsx draws and for the same
// reason: granting is already a deliberate act several fields deep (slug,
// tier/seats or flag, reason, an explicit future expiry), so a second
// are-you-sure beat would guard against a mis-click that cannot happen.
// Revoking is a ROW BUTTON in a list of similar rows -- exactly the shape
// components/ui/use-reveal-focus.tsx's reveal exists for.
//
// EVERY REASON HINT CARRIES THE Q103 DISCLOSURE WARNING (fix round 1, review
// I2): organisation_billing_overrides_select_member /
// organisation_feature_overrides_select_member give ANY active member of the
// target workspace SELECT over the full row -- reason and revoked_reason
// included, revoked/expired history rows included (RLS filters rows, not
// columns) -- so what the operator types here is readable by the workspace's
// own people through PostgREST even though no in-app surface renders it to
// them today. Same wording precedent as
// components/admin/organisation-lifecycle-forms.tsx's lifecycle forms.

export function GrantBillingOverrideForm() {
  const [state, formAction, pending] = useActionState(
    grantBillingOverrideAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <h3 className="text-base font-bold text-ink">Grant a billing override</h3>
      <p className="max-w-prose text-sm text-ink-muted">
        Overrides the workspace’s EFFECTIVE tier and/or seat count for a
        bounded window — its real subscription is untouched, and the
        override auto-reverts the moment it expires. A second grant replaces
        an existing active one rather than stacking.
      </p>

      <Field
        label="Workspace URL name"
        name="organisationSlug"
        required
        defaultValue={state.values?.organisationSlug ?? ""}
        error={state.fieldErrors?.organisationSlug}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        hint="The slug from the workspace’s URL — the part after the first slash."
      />

      <SelectField
        label="Override tier"
        name="overrideTier"
        defaultValue={state.values?.overrideTier ?? ""}
        error={state.fieldErrors?.overrideTier}
        hint="Leave as “No change” to override only the seat count."
      >
        <option value="">No change</option>
        {OVERRIDE_TIER_CHOICES.map((tier) => (
          <option key={tier} value={tier}>
            {TIER_CHOICE_LABELS[tier]}
          </option>
        ))}
      </SelectField>

      <Field
        label="Override seat count"
        name="overrideSeats"
        type="number"
        min={1}
        step={1}
        defaultValue={state.values?.overrideSeats ?? ""}
        error={state.fieldErrors?.overrideSeats}
        hint="Leave blank to override only the tier."
      />

      <Field
        label="Expires"
        name="expiresAt"
        type="datetime-local"
        required
        defaultValue={state.values?.expiresAt ?? ""}
        error={state.fieldErrors?.expiresAt}
        hint="Mandatory — there is no open-ended override. It reverts to the workspace’s real plan the instant this passes, with nothing further to do."
      />

      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={3}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint="THE WORKSPACE'S OWN PEOPLE CAN READ THIS — any member of the workspace can read the override row, this reason included — and it goes on the permanent audit record. Write the sentence you would say to them — name the invoice, the negotiation or the incident — not an internal shorthand."
      />

      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Granting…">
          Grant billing override
        </Button>
      </div>
    </form>
  );
}

export function GrantFeatureOverrideForm() {
  const [state, formAction, pending] = useActionState(
    grantFeatureOverrideAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <h3 className="text-base font-bold text-ink">Grant a feature override</h3>
      <p className="max-w-prose text-sm text-ink-muted">
        Turns on one named feature flag for one workspace, for a bounded
        window. At MVP this only lights up the “Early access preview” badge
        on the workspace’s own home — it gates nothing else yet.
      </p>

      <Field
        label="Workspace URL name"
        name="organisationSlug"
        required
        defaultValue={state.values?.organisationSlug ?? ""}
        error={state.fieldErrors?.organisationSlug}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        hint="The slug from the workspace’s URL — the part after the first slash."
      />

      <SelectField
        label="Feature flag"
        name="flagKey"
        required
        defaultValue={state.values?.flagKey ?? FEATURE_FLAG_KEYS[0]}
        error={state.fieldErrors?.flagKey}
      >
        {FEATURE_FLAG_KEYS.map((key) => (
          <option key={key} value={key}>
            {FEATURE_FLAG_LABELS[key]}
          </option>
        ))}
      </SelectField>

      <Field
        label="Expires"
        name="expiresAt"
        type="datetime-local"
        required
        defaultValue={state.values?.expiresAt ?? ""}
        error={state.fieldErrors?.expiresAt}
        hint="Mandatory — there is no open-ended override."
      />

      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={3}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint="THE WORKSPACE'S OWN PEOPLE CAN READ THIS — any member of the workspace can read the override row, this reason included — and it goes on the permanent audit record. Write the sentence you would say to them."
      />

      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Granting…">
          Grant feature override
        </Button>
      </div>
    </form>
  );
}

interface OverrideRowBase {
  id: string;
  organisationName: string;
  organisationSlug: string;
  reason: string;
  expiresAtLabel: string;
  daysRemaining: number | null;
}

/**
 * The shared revoke-capable list shell. Same "action state lives ABOVE the
 * rows" shape as components/admin/organisation-lifecycle-forms.tsx's
 * WoundDownOrganisationsList, and for the identical reason (found in a
 * browser, that file's own header explains at length): revoking removes the
 * row that would otherwise carry the success message, so the confirmation
 * has to live somewhere the re-render does not unmount.
 */
function OverrideList<T extends OverrideRowBase>({
  rows,
  limit,
  emptyLabel,
  revokeAction,
  renderDetail,
}: {
  rows: readonly T[];
  limit: number;
  emptyLabel: string;
  revokeAction: (prev: FormState, data: FormData) => Promise<FormState>;
  renderDetail: (row: T) => React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(revokeAction, EMPTY_FORM_STATE);
  const [askingId, setAskingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">{emptyLabel}</p>
      ) : (
        <>
          <ul className="flex flex-col border-t border-rule">
            {rows.map((row) => (
              <OverrideRow
                key={row.id}
                row={row}
                asking={askingId === row.id}
                pending={pending}
                fieldError={state.fieldErrors?.reason}
                formAction={formAction}
                onAsk={() => setAskingId(row.id)}
                onCancel={() => setAskingId(null)}
                renderDetail={renderDetail}
              />
            ))}
          </ul>
          {rows.length === limit ? (
            <p className="max-w-prose text-sm text-ink-muted">
              Showing the <span className="tabular-nums">{limit}</span> most
              recent active. The complete history of every grant and revoke
              is in the audit log.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function OverrideRow<T extends OverrideRowBase>({
  row,
  asking,
  pending,
  fieldError,
  formAction,
  onAsk,
  onCancel,
  renderDetail,
}: {
  row: T;
  asking: boolean;
  pending: boolean;
  fieldError: string | undefined;
  formAction: (data: FormData) => void;
  onAsk: () => void;
  onCancel: () => void;
  renderDetail: (row: T) => React.ReactNode;
}) {
  const { triggerRef, revealRef, onRevealKeyDown } = useRevealFocus<
    HTMLParagraphElement,
    HTMLButtonElement
  >(asking, onCancel);

  return (
    <li className="flex flex-col gap-3 border-b border-rule py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-semibold text-ink">{row.organisationName}</span>
        <span className="text-sm text-ink-muted">/{row.organisationSlug}</span>
        {renderDetail(row)}
      </div>

      <p className="max-w-prose text-base text-ink">{row.reason}</p>

      <p className="text-sm text-ink-muted">
        Expires <span className="tabular-nums">{row.expiresAtLabel}</span>
        {row.daysRemaining !== null ? (
          <>
            {" "}
            (<span className="tabular-nums">{row.daysRemaining}</span>{" "}
            {row.daysRemaining === 1 ? "day" : "days"})
          </>
        ) : null}
        .
      </p>

      {!asking ? (
        <div>
          <Button ref={triggerRef} type="button" variant="secondary" onClick={onAsk}>
            Revoke
            <span className="sr-only"> — {row.organisationName}</span>
          </Button>
        </div>
      ) : (
        <form
          action={formAction}
          onKeyDown={onRevealKeyDown}
          className="flex max-w-prose flex-col gap-3"
        >
          <input type="hidden" name="overrideId" value={row.id} />
          <p
            ref={revealRef}
            tabIndex={-1}
            role="status"
            className="max-w-prose text-base text-ink"
          >
            Revoke this override for {row.organisationName}? It reverts to the
            workspace’s real plan immediately.
          </p>
          <TextAreaField
            label="Reason"
            name="reason"
            required
            rows={2}
            error={fieldError}
            hint="THE WORKSPACE'S OWN PEOPLE CAN READ THIS — revoked override rows stay readable to any member of the workspace, this reason included — and it goes on the permanent audit record beside the grant it ends. Write the sentence you would say to them."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="danger"
              pending={pending}
              pendingLabel="Revoking…"
            >
              Yes, revoke
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              Leave it active
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function ActiveBillingOverridesList({
  rows,
  limit,
}: {
  rows: readonly (OverrideRowBase & {
    overrideTierLabel: string | null;
    overrideSeats: number | null;
  })[];
  limit: number;
}) {
  return (
    <OverrideList
      rows={rows}
      limit={limit}
      emptyLabel="No workspace has an active billing override."
      revokeAction={revokeBillingOverrideAction}
      renderDetail={(row) => (
        // text-primary, NOT text-accent -- DESIGN.md's two-blue rule: --accent
        // is a border/focus-rail/active-state colour and fails AA at 4.5:1 on
        // text (measured: axe flagged it, 3.23:1). --primary is the only blue
        // permitted on text.
        <span className="text-sm font-semibold text-primary">
          {row.overrideTierLabel ? `→ ${row.overrideTierLabel}` : null}
          {row.overrideTierLabel && row.overrideSeats !== null ? ", " : null}
          {row.overrideSeats !== null ? `${row.overrideSeats} seats` : null}
        </span>
      )}
    />
  );
}

export function ActiveFeatureOverridesList({
  rows,
  limit,
}: {
  rows: readonly (OverrideRowBase & { flagLabel: string })[];
  limit: number;
}) {
  return (
    <OverrideList
      rows={rows}
      limit={limit}
      emptyLabel="No workspace has an active feature override."
      revokeAction={revokeFeatureOverrideAction}
      renderDetail={(row) => (
        <span className="text-sm font-semibold text-primary">{row.flagLabel}</span>
      )}
    />
  );
}
