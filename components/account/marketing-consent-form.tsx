"use client";

import { useActionState } from "react";
import { setMarketingConsentAction } from "@/lib/consent/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// ONE BUTTON, WHICHEVER WAY (CLAUDE.md: "as easy to withdraw as to give").
//
// Agreeing and withdrawing are the same form, the same button variant, the
// same single press, and neither asks for confirmation -- so withdrawal can
// never be the harder of the two. The button's label is the action it takes;
// the state it changes is stated in words above it (and in the chip), so the
// control is never the only place the current choice is readable.
//
// `policyVersion` is the version of the Marketing page this screen rendered.
// It is posted with a grant so the database can refuse the grant if the page
// changed in the meantime, rather than record agreement to text the person
// never saw. A withdrawal does not send it and can never fail for that reason.
export function MarketingConsentForm({
  agreed,
  policyVersion,
}: {
  agreed: boolean;
  policyVersion: number;
}) {
  const [state, formAction, pending] = useActionState(
    setMarketingConsentAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      {/* One live region for both outcomes, above the control it reports on. */}
      <div aria-live="polite" className="flex flex-col gap-3">
        {state.error ? <Alert tone="error" live={false}>{state.error}</Alert> : null}
        {state.message ? <Alert tone="success" live={false}>{state.message}</Alert> : null}
      </div>
      <form action={formAction}>
        <input type="hidden" name="choice" value={agreed ? "withdraw" : "grant"} />
        {agreed ? null : (
          <input type="hidden" name="policyVersion" value={String(policyVersion)} />
        )}
        <Button
          type="submit"
          variant="secondary"
          pending={pending}
          pendingLabel="Saving…"
        >
          {agreed ? "Withdraw agreement to marketing email" : "Agree to marketing email"}
        </Button>
      </form>
    </div>
  );
}
