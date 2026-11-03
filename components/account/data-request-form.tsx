"use client";

import { useActionState, useId } from "react";
import { submitDataSubjectRequestAction } from "@/lib/dsr/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  DSR_DETAIL_MAX,
  DSR_RESPONSE_DAYS,
  DSR_RIGHTS,
  DSR_RIGHT_COPY,
  DSR_SCOPES,
  DSR_SCOPE_COPY,
} from "@/lib/dsr/contract";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { TextAreaField } from "@/components/ui/field";

// TWO RADIO GROUPS, NOT TWO SELECTS.
//
// The brief asks that the person "see plainly what will happen" before they
// choose. A <select> shows one option at a time and hides the explanation of
// every other; a radio group in a <fieldset> shows all six rights with what
// each one means, side by side, which is the difference between choosing and
// guessing. It is also the shape that survives JavaScript being off, and the
// blurbs are bound to their inputs by aria-describedby rather than sitting
// loose beside them.
//
// NOTHING HERE IS TRUSTED. The right and the scope are re-checked against the
// closed lists in the action and again by the database (22023 unknown_right /
// unknown_scope), and the requester is stamped from the session by a trigger
// no write path can reach around.

export function DataRequestForm() {
  const [state, formAction, pending] = useActionState(
    submitDataSubjectRequestAction,
    EMPTY_FORM_STATE,
  );
  const rightsId = useId();
  const scopesId = useId();

  return (
    <div className="flex flex-col gap-5">
      <div aria-live="polite" className="flex flex-col gap-3">
        {state.error ? (
          <Alert tone="error" live={false}>
            {state.error}
          </Alert>
        ) : null}
        {state.message ? (
          <Alert tone="success" live={false}>
            {state.message}
          </Alert>
        ) : null}
      </div>

      <form action={formAction} className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-3 border-0 p-0">
          <legend className="text-lg font-bold text-ink">What are you asking for?</legend>
          {state.fieldErrors?.rightType ? (
            <p role="alert" className="text-sm text-danger">
              {state.fieldErrors.rightType}
            </p>
          ) : null}
          <ul className="flex flex-col border-t border-rule">
            {DSR_RIGHTS.map((right) => {
              const id = `${rightsId}-${right}`;
              const copy = DSR_RIGHT_COPY[right];
              return (
                <li key={right} className="border-b border-rule py-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      id={id}
                      name="rightType"
                      value={right}
                      defaultChecked={state.values?.rightType === right}
                      aria-describedby={`${id}-blurb`}
                      className="mt-1.5 h-4 w-4 accent-[var(--color-primary)]"
                    />
                    <div className="flex flex-col gap-1">
                      <label htmlFor={id} className="text-base font-semibold text-ink">
                        {copy.label}
                      </label>
                      <p id={`${id}-blurb`} className="max-w-prose text-sm text-ink-muted">
                        {copy.blurb}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <fieldset className="flex flex-col gap-3 border-0 p-0">
          <legend className="text-lg font-bold text-ink">Which data is it about?</legend>
          {state.fieldErrors?.subjectScope ? (
            <p role="alert" className="text-sm text-danger">
              {state.fieldErrors.subjectScope}
            </p>
          ) : null}
          <ul className="flex flex-col border-t border-rule">
            {DSR_SCOPES.map((scope) => {
              const id = `${scopesId}-${scope}`;
              const copy = DSR_SCOPE_COPY[scope];
              return (
                <li key={scope} className="border-b border-rule py-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      id={id}
                      name="subjectScope"
                      value={scope}
                      defaultChecked={state.values?.subjectScope === scope}
                      aria-describedby={`${id}-blurb`}
                      className="mt-1.5 h-4 w-4 accent-[var(--color-primary)]"
                    />
                    <div className="flex flex-col gap-1">
                      <label htmlFor={id} className="text-base font-semibold text-ink">
                        {copy.label}
                      </label>
                      <p id={`${id}-blurb`} className="max-w-prose text-sm text-ink-muted">
                        {copy.blurb}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <TextAreaField
          label="Tell us what you want"
          name="detail"
          required
          rows={6}
          maxLength={DSR_DETAIL_MAX}
          defaultValue={state.values?.detail ?? ""}
          error={state.fieldErrors?.detail}
          hint={
            <>
              Be as specific as you can — which data, and if it is about a business’s records,
              which business. We read this; nobody else does, and it is never published or
              copied into the security log. Up to{" "}
              {DSR_DETAIL_MAX.toLocaleString("en-GB")} characters.
            </>
          }
        />

        <div className="flex flex-col gap-3">
          <Button type="submit" pending={pending} pendingLabel="Sending…">
            Send this request
          </Button>
          <p className="max-w-prose text-sm text-ink-muted">
            We will respond within {DSR_RESPONSE_DAYS} days of receiving it. You will see the
            deadline and the current state below, and you can withdraw the request at any time
            before it is answered.
          </p>
        </div>
      </form>
    </div>
  );
}
