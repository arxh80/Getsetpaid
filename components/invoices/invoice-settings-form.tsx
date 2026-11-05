"use client";

import { useActionState } from "react";
import { saveInvoiceSettingsAction } from "@/lib/invoices/settings-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import type { InvoiceSettingsRow } from "@/lib/invoices/queries";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

const NOTE_ID = "invoice-settings-blocked";

export function InvoiceSettingsForm({
  orgSlug,
  settings,
  disabledReason,
}: {
  orgSlug: string;
  settings: InvoiceSettingsRow | null;
  disabledReason: string | null;
}) {
  const [state, action, pending] = useActionState(saveInvoiceSettingsAction, EMPTY_FORM_STATE);
  const v = (name: string, stored: string | number | null | undefined) =>
    state.values?.[name] ?? (stored === null || stored === undefined ? "" : String(stored));
  const e = (name: string) => state.fieldErrors?.[name];
  const disabled = disabledReason !== null;

  return (
    <form action={action} className="flex max-w-prose flex-col gap-6" aria-describedby={disabled ? NOTE_ID : undefined}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {disabled ? (
        <p id={NOTE_ID} className="border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
          <span className="font-semibold text-ink">Read-only.</span> {disabledReason}
        </p>
      ) : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <fieldset disabled={disabled} className="flex flex-col gap-5">
        <legend className="text-xl font-bold text-ink">Your business</legend>
        <Field label="Business name" name="businessName" required defaultValue={v("businessName", settings?.businessName)} error={e("businessName")} maxLength={200} />
        <TextAreaField label="Business address" name="businessAddress" required rows={4} defaultValue={v("businessAddress", settings?.businessAddress)} error={e("businessAddress")} maxLength={500} />
        <Field label="VAT number" name="vatNumber" defaultValue={v("vatNumber", settings?.vatNumber)} error={e("vatNumber")} hint="Leave blank if you are not VAT registered: your invoices then charge no VAT and show no VAT column." autoComplete="off" />
      </fieldset>

      <fieldset disabled={disabled} className="flex flex-col gap-5 border-t border-rule pt-6">
        <legend className="text-xl font-bold text-ink">Where you are paid</legend>
        <p className="text-sm text-ink-muted">
          Printed on every invoice. Changing them emails every Owner and Admin of this workspace, so a change nobody expected is noticed.
        </p>
        <Field label="Account name" name="bankAccountName" defaultValue={v("bankAccountName", settings?.bankAccountName)} error={e("bankAccountName")} autoComplete="off" />
        <Field label="Sort code" name="bankSortCode" inputMode="numeric" defaultValue={v("bankSortCode", settings?.bankSortCode)} error={e("bankSortCode")} autoComplete="off" className="tabular-nums" />
        <Field label="Account number" name="bankAccountNumber" inputMode="numeric" defaultValue={v("bankAccountNumber", settings?.bankAccountNumber)} error={e("bankAccountNumber")} autoComplete="off" className="tabular-nums" />
      </fieldset>

      <fieldset disabled={disabled} className="flex flex-col gap-5 border-t border-rule pt-6">
        <legend className="text-xl font-bold text-ink">Numbering and terms</legend>
        <Field label="Number prefix" name="numberPrefix" required defaultValue={v("numberPrefix", settings?.numberPrefix ?? "INV-")} error={e("numberPrefix")} hint={`The next invoice is number ${settings?.nextNumber ?? 1}. Numbers never repeat and never skip.`} />
        <Field label="Payment terms (days)" name="paymentTermsDays" required inputMode="numeric" defaultValue={v("paymentTermsDays", settings?.paymentTermsDays ?? 30)} error={e("paymentTermsDays")} className="tabular-nums" />
      </fieldset>

      <div>
        <Button type="submit" disabled={disabled} pending={pending} pendingLabel="Saving…" aria-describedby={disabled ? NOTE_ID : undefined}>
          Save invoice settings
        </Button>
      </div>
    </form>
  );
}
