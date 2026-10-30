"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { saveInvoiceDraftAction } from "@/lib/invoices/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { VAT_RATES, VAT_RATE_LABELS, invoiceTotals, lineAmounts, parseQuantity, type LineAmounts, type VatRate } from "@/lib/invoices/arithmetic";
import { formatGbp, parseGbpToMinor } from "@/lib/format/money";
import { BLOCKED_NOTE_ID, EMPTY_LINE, MAX_LINES, type EditorInitial, type EditorLine } from "@/lib/invoices/draft-form";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// THE DRAFT EDITOR. The line rows are CONTROLLED (state), because adding and
// removing rows and the live totals need JavaScript anyway, and controlled
// rows survive React 19's post-action form reset. The live totals use the
// TypeScript port of the database's arithmetic (lib/invoices/arithmetic.ts);
// the numbers that are stored are the database's.

export interface PickerOption { id: string; name: string }

interface Row extends EditorLine { key: number }

const CONTROL =
  "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink disabled:cursor-not-allowed disabled:opacity-55 ";
const ok = "border-rule hover:border-ink focus:border-accent";
const bad = "border-danger";


export function InvoiceEditor({
  orgSlug,
  invoiceId,
  companies,
  contacts,
  events,
  vatRegistered,
  initial,
  disabledReason,
}: {
  orgSlug: string;
  invoiceId: string | null;
  companies: readonly PickerOption[];
  contacts: readonly PickerOption[];
  events: readonly PickerOption[];
  vatRegistered: boolean;
  initial: EditorInitial;
  disabledReason: string | null;
}) {
  const [state, action, pending] = useActionState(saveInvoiceDraftAction, EMPTY_FORM_STATE);
  const nextKey = useRef(initial.lines.length);
  const [rows, setRows] = useState<Row[]>(() => initial.lines.map((l, i) => ({ ...l, key: i })));
  const focusKey = useRef<number | null>(null);
  const disabled = disabledReason !== null;
  const echo = (name: string, fallback: string) => state.values?.[name] ?? fallback;
  const err = (name: string) => state.fieldErrors?.[name];

  useEffect(() => {
    if (focusKey.current === null) return;
    document.getElementById(`line-${focusKey.current}-description`)?.focus();
    focusKey.current = null;
  }, [rows]);

  const amounts: (LineAmounts | null)[] = useMemo(
    () =>
      rows.map((r) => {
        const q = parseQuantity(r.quantity);
        const p = parseGbpToMinor(r.unitPrice);
        if (q === null || p === null) return null;
        try {
          return lineAmounts(q, p, vatRegistered ? r.vatRate : "none");
        } catch {
          return null;
        }
      }),
    [rows, vatRegistered],
  );
  const totals = invoiceTotals(amounts.filter((a): a is LineAmounts => a !== null));

  const update = (key: number, patch: Partial<EditorLine>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addLine = () => {
    const key = nextKey.current++;
    focusKey.current = key;
    setRows((current) => [...current, { ...EMPTY_LINE, vatRate: vatRegistered ? "standard_20" : "none", key }]);
  };
  const removeLine = (key: number) => setRows((current) => current.filter((r) => r.key !== key));

  const recipientIds = new Set([...companies.map((c) => `company:${c.id}`), ...contacts.map((c) => `contact:${c.id}`)]);
  const eventIds = new Set(events.map((e) => e.id));

  return (
    <form action={action} className="flex flex-col gap-8" aria-describedby={disabled ? BLOCKED_NOTE_ID : undefined}>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {invoiceId ? <input type="hidden" name="invoiceId" value={invoiceId} /> : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      {err("lines") ? <Alert tone="error">{err("lines")}</Alert> : null}

      <fieldset disabled={disabled} className="grid gap-5 sm:grid-cols-2">
        <legend className="sr-only">Who and what for</legend>
        <SelectField label="Recipient" name="recipient" defaultValue={echo("recipient", initial.recipient)} error={err("recipient")} key={`r-${echo("recipient", initial.recipient)}`}>
          <option value="">Choose later</option>
          {initial.recipient && !recipientIds.has(initial.recipient) ? (
            <option value={initial.recipient}>Current recipient (no longer in the list)</option>
          ) : null}
          <optgroup label="Companies">
            {companies.map((c) => <option key={c.id} value={`company:${c.id}`}>{c.name}</option>)}
          </optgroup>
          <optgroup label="Contacts">
            {contacts.map((c) => <option key={c.id} value={`contact:${c.id}`}>{c.name}</option>)}
          </optgroup>
        </SelectField>
        <SelectField label="Event" name="eventId" defaultValue={echo("eventId", initial.eventId)} error={err("eventId")} key={`e-${echo("eventId", initial.eventId)}`}>
          <option value="">No event</option>
          {initial.eventId && !eventIds.has(initial.eventId) ? (
            <option value={initial.eventId}>Current event (no longer in the list)</option>
          ) : null}
          {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </SelectField>
        <TextAreaField label="Recipient address" name="recipientAddress" rows={3} maxLength={500} defaultValue={echo("recipientAddress", initial.recipientAddress)} error={err("recipientAddress")} hint="Required before issuing: a VAT invoice shows the customer’s address." />
        <Field label="Supply date" name="supplyDate" type="date" defaultValue={echo("supplyDate", initial.supplyDate)} error={err("supplyDate")} hint="Leave blank if it is the issue date." />
      </fieldset>

      <fieldset disabled={disabled} className="flex flex-col gap-3 border-t border-rule pt-6">
        <legend className="text-xl font-bold text-ink">Lines</legend>
        {!vatRegistered ? (
          <p className="text-sm text-ink-muted">No VAT is charged: this workspace has no VAT number in Invoice settings.</p>
        ) : null}
        <ol className="flex flex-col">
          {rows.map((row, index) => {
            const n = index + 1;
            const a = amounts[index];
            return (
              <li key={row.key} className="grid gap-2 border-b border-rule py-3 sm:grid-cols-[1fr_6rem_8rem_10rem_7rem_auto] sm:items-start">
                <input type="hidden" name="line_entry_id" value={row.entryId} />
                <div className="flex flex-col gap-1">
                  <input id={`line-${row.key}-description`} name="line_description" aria-label={`Line ${n} description`} value={row.description} maxLength={500}
                    onChange={(e) => update(row.key, { description: e.target.value })}
                    aria-invalid={err(`line_${index}_description`) ? true : undefined}
                    className={CONTROL + (err(`line_${index}_description`) ? bad : ok)} />
                  {row.entryId ? <span className="text-xs text-ink-muted">From event finance</span> : null}
                  {err(`line_${index}_description`) ? <p role="alert" className="text-sm font-semibold text-danger">{err(`line_${index}_description`)}</p> : null}
                </div>
                <div className="flex flex-col gap-1">
                  <input name="line_quantity" aria-label={`Line ${n} quantity`} inputMode="decimal" value={row.quantity}
                    onChange={(e) => update(row.key, { quantity: e.target.value })}
                    aria-invalid={err(`line_${index}_quantity`) ? true : undefined}
                    className={CONTROL + "tabular-nums " + (err(`line_${index}_quantity`) ? bad : ok)} />
                  {err(`line_${index}_quantity`) ? <p role="alert" className="text-sm font-semibold text-danger">{err(`line_${index}_quantity`)}</p> : null}
                </div>
                <div className="flex flex-col gap-1">
                  <input name="line_unit_price" aria-label={`Line ${n} unit price`} inputMode="decimal" value={row.unitPrice}
                    onChange={(e) => update(row.key, { unitPrice: e.target.value })}
                    aria-invalid={err(`line_${index}_unit_price`) ? true : undefined}
                    className={CONTROL + "tabular-nums " + (err(`line_${index}_unit_price`) ? bad : ok)} />
                  {err(`line_${index}_unit_price`) ? <p role="alert" className="text-sm font-semibold text-danger">{err(`line_${index}_unit_price`)}</p> : null}
                </div>
                {vatRegistered ? (
                  <select name="line_vat_rate" aria-label={`Line ${n} VAT`} value={row.vatRate}
                    onChange={(e) => update(row.key, { vatRate: e.target.value as VatRate })}
                    className={CONTROL + (err(`line_${index}_vat_rate`) ? bad : ok)}>
                    {VAT_RATES.map((r) => <option key={r} value={r}>{VAT_RATE_LABELS[r]}</option>)}
                  </select>
                ) : (
                  <input type="hidden" name="line_vat_rate" value="none" />
                )}
                <p className="h-11 content-center text-right text-base text-ink tabular-nums" aria-label={`Line ${n} net`}>
                  {a ? formatGbp(a.netMinor) : "—"}
                </p>
                <Button type="button" variant="secondary" onClick={() => removeLine(row.key)} aria-label={`Remove line ${n}`}>
                  Remove
                </Button>
              </li>
            );
          })}
        </ol>
        <div>
          <Button type="button" variant="secondary" onClick={addLine} disabled={rows.length >= MAX_LINES}>
            Add line
          </Button>
        </div>
      </fieldset>

      <section aria-label="Totals" aria-live="polite" className="ml-auto w-full max-w-xs border-t border-rule pt-4">
        <dl className="grid grid-cols-2 gap-y-1 text-base tabular-nums">
          <dt className="text-ink-muted">Net</dt>
          <dd className="text-right text-ink">{formatGbp(totals.netMinor)}</dd>
          {vatRegistered ? (
            <>
              <dt className="text-ink-muted">VAT</dt>
              <dd className="text-right text-ink">{formatGbp(totals.vatMinor)}</dd>
            </>
          ) : null}
          <dt className="font-bold text-ink">Total</dt>
          <dd className="text-right font-bold text-ink">{formatGbp(totals.grossMinor)}</dd>
        </dl>
      </section>

      <fieldset disabled={disabled}>
        <TextAreaField label="Notes" name="notes" rows={3} maxLength={2000} defaultValue={echo("notes", initial.notes)} error={err("notes")} hint="Printed on the invoice." />
      </fieldset>

      <div>
        <Button type="submit" disabled={disabled} pending={pending} pendingLabel="Saving…" aria-describedby={disabled ? BLOCKED_NOTE_ID : undefined}>
          Save draft
        </Button>
      </div>
    </form>
  );
}
