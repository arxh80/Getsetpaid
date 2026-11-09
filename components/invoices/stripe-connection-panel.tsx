"use client";

import { useActionState } from "react";
import { disconnectStripeAction, startStripeLinkAction } from "@/lib/invoices/stripe-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { formatDate } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { useReportedAction } from "@/components/ui/action-outcome";

// THE WORKSPACE'S STRIPE LINK (Invoices part 2). Four states: Stripe not set up
// on this server; not linked; linked; ended. Disconnecting revalidates the page
// into the "ended" view, which unmounts the Disconnect form, so neither form
// renders a message of its own: both hand their outcome to the page's
// <ActionOutcome> region through useReportedAction (the rule
// tests/unit/forms/action-outcome-census.test.ts holds this file to). The
// page puts the whole panel behind <StepUpGate>, as it does the settings form.
// The account id is never a prop: the page does not have it.

const HEADING = "Card payments";

export function StripeConnectionPanel({
  orgSlug,
  configured,
  account,
  feeBps,
  disabledReason,
}: {
  orgSlug: string;
  /** False when this server has no Stripe keys (or the fake is refused). */
  configured: boolean;
  account: { live: boolean; chargesEnabled: boolean; linkedAt: string | null; endedAt: string | null } | null;
  /** The application fee in basis points, or null when it could not be read. */
  feeBps: number | null;
  /** Why this person cannot change it (the disabled form's own sentence), or null. */
  disabledReason: string | null;
}) {
  const startReported = useReportedAction(startStripeLinkAction);
  const [, startAction, starting] = useActionState(startReported, EMPTY_FORM_STATE);
  const endReported = useReportedAction(disconnectStripeAction);
  const [, endAction, ending] = useActionState(endReported, EMPTY_FORM_STATE);

  const heading = <h2 className="text-xl font-bold text-ink">{HEADING}</h2>;

  if (!configured) {
    return (
      <section className="flex max-w-prose flex-col gap-3 border-t border-rule pt-6" aria-label={HEADING}>
        {heading}
        <p className="text-base text-ink-muted">Card payments aren’t set up on this server yet.</p>
      </section>
    );
  }

  const note = disabledReason ? (
    <p className="border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
      <span className="font-semibold text-ink">Read-only.</span> {disabledReason}
    </p>
  ) : null;

  if (account?.live) {
    return (
      <section className="flex max-w-prose flex-col gap-4 border-t border-rule pt-6" aria-label={HEADING}>
        {heading}
        <p className="text-base text-ink">
          Connected on <span className="tabular-nums">{account.linkedAt ? formatDate(account.linkedAt) : "an earlier date"}</span>.
        </p>
        {!account.chargesEnabled ? (
          <p className="border border-rule bg-surface px-3 py-3 text-sm text-ink">
            Stripe hasn’t enabled card payments on this account yet. Finish setting it up in Stripe.
          </p>
        ) : null}
        {note}
        {disabledReason === null ? (
          <form action={endAction}>
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <Button type="submit" variant="secondary" pending={ending} pendingLabel="Disconnecting…">
              Disconnect
            </Button>
          </form>
        ) : null}
      </section>
    );
  }

  return (
    <section className="flex max-w-prose flex-col gap-4 border-t border-rule pt-6" aria-label={HEADING}>
      {heading}
      {account?.endedAt ? (
        <p className="text-base text-ink">
          Disconnected on <span className="tabular-nums">{formatDate(account.endedAt)}</span>.
        </p>
      ) : null}
      <p className="text-base text-ink-muted">
        Link your existing Stripe account to add a Pay by card link to your invoices.{" "}
        {feeBps === null
          ? "Stripe’s own fees are charged to your account."
          : `GetSetPaid takes ${feeBps / 100}% of each card payment; Stripe’s own fees are charged to your account.`}
      </p>
      {note}
      {disabledReason === null ? (
        <form action={startAction}>
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <Button type="submit" pending={starting} pendingLabel="Opening Stripe…">
            Connect Stripe
          </Button>
        </form>
      ) : null}
    </section>
  );
}
