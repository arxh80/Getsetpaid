"use client";

import { useActionState } from "react";
import { createNetworkProfileAction } from "@/lib/network/profiles";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { MAX_NAME } from "@/lib/crm/validate";
import {
  NETWORK_ENTITY_KIND_LABELS,
  type NetworkEntityKind,
} from "@/lib/network/fields";
import type { EntityOption } from "@/lib/network/entities";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The "Publish a record" entry point on the profiles list page.
//
// ===========================================================================
// M4: THIS FORM OFFERS ONLY RECORDS THE CALLER CAN MANAGE, PER KIND
// ===========================================================================
// The page computes `manageableKinds` from `manageableNetworkEntityKinds(org)`
// (lib/network/access.ts) BEFORE this component ever renders -- a marketing
// user, who holds manage_network_profile but only manage_contacts underneath
// it, is handed a `kinds` array containing "company" and "agency" and NOT
// "artist" or "venue". This component never widens that: there is no "all
// four kinds" fallback anywhere below, so a kind absent from the prop is a
// kind this control cannot offer, full stop.
//
// ===========================================================================
// ONE MINI-FORM PER KIND, EACH WITH entityKind FIXED IN A HIDDEN INPUT
// ===========================================================================
// A single cross-kind `<select>` would need JavaScript to keep its `entityId`
// options in step with a separately chosen `entityKind` -- and getting that
// wrong (the classic "picked Artist, submitted a Venue's id") is exactly the
// class of mistake `entity_is_manageable` would then refuse for a reason the
// user cannot see (it looks up the WRONG TABLE for that id and finds
// nothing). Splitting into one form per kind makes the pairing structural:
// each form's hidden `entityKind` can never disagree with what its own
// `entityId` select offers, because the select was built for that kind alone.
//
// `displayName` IS TYPED BY THE PUBLISHER, NOT COPIED FROM THE RECORD. Q75:
// the profile carries its own copy, and a network-facing name may deliberately
// differ from the CRM's internal one ("DJ Example" vs. the promoter's own
// shorthand for them). Pre-filling it from the picker's selected option would
// need JavaScript this form does not have and would imply the two are meant
// to match, which the schema does not require.

const NOTE_ID = "network-publish-blocked";

export function CreateProfileForm({
  orgSlug,
  kinds,
  optionsByKind,
  disabled,
  disabledExplanation,
}: {
  orgSlug: string;
  /** The kinds this caller may manage, in NETWORK_ENTITY_KINDS order. Empty
   *  when the general gate refuses everything (Free tier, suspended, no
   *  manage_network_profile at all) OR when the caller's role cannot manage
   *  any of the four private-record kinds (M4). */
  kinds: readonly NetworkEntityKind[];
  optionsByKind: Readonly<Partial<Record<NetworkEntityKind, readonly EntityOption[]>>>;
  disabled: boolean;
  disabledExplanation: string | null;
}) {
  if (disabled) {
    return (
      <div className="flex flex-col gap-2 border border-rule bg-surface p-5">
        <h2 className="text-lg font-bold text-ink">Publish a record</h2>
        <p id={NOTE_ID} className="max-w-prose text-base text-ink-muted">
          {disabledExplanation}
        </p>
        <Button type="button" disabled aria-describedby={NOTE_ID}>
          Publish a record
        </Button>
      </div>
    );
  }

  if (kinds.length === 0) {
    // canWrite for network-publish is TRUE, but every per-kind check failed
    // (M4) -- a real, honest state, distinct from the tier/permission refusal
    // above. Q77's roles that hold manage_network_profile without any of
    // manage_contacts/manage_artists/manage_venues do not exist today
    // (marketing holds manage_contacts), so this is defence in depth rather
    // than a reachable state -- and it is rendered rather than assumed
    // unreachable, because Constraint 12 applies to an edge case exactly as
    // much as to the common one.
    return (
      <div className="flex flex-col gap-2 border border-rule bg-surface p-5">
        <h2 className="text-lg font-bold text-ink">Publish a record</h2>
        <p className="max-w-prose text-base text-ink-muted">
          Your role can’t manage any of the record types the network
          publishes. Ask an Owner, Admin or Manager.
        </p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4 border border-rule bg-surface p-5">
      <h2 className="text-lg font-bold text-ink">Publish a record</h2>
      <p className="max-w-prose text-base text-ink-muted">
        Create a draft network identity for one of this workspace’s own
        records. Nothing is visible outside this workspace until you publish
        it from its own page.
      </p>
      <div className="flex flex-col gap-6">
        {kinds.map((kind) => (
          <CreateProfileKindForm
            key={kind}
            orgSlug={orgSlug}
            kind={kind}
            options={optionsByKind[kind] ?? []}
          />
        ))}
      </div>
    </section>
  );
}

function CreateProfileKindForm({
  orgSlug,
  kind,
  options,
}: {
  orgSlug: string;
  kind: NetworkEntityKind;
  options: readonly EntityOption[];
}) {
  const [state, formAction, pending] = useActionState(
    createNetworkProfileAction,
    EMPTY_FORM_STATE,
  );
  const idPrefix = `publish-${kind}`;
  const label = NETWORK_ENTITY_KIND_LABELS[kind];
  const empty = options.length === 0;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 border-t border-rule pt-4 first:border-t-0 first:pt-0"
    >
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="entityKind" value={kind} />

      <h3 className="text-sm font-semibold text-ink">Publish a {label.toLowerCase()}</h3>

      {empty ? (
        <p id={`${idPrefix}-empty`} className="text-sm text-ink-muted">
          Every {label.toLowerCase()} in this workspace already has a network
          profile.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${idPrefix}-entity`} className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
              {label}
            </label>
            <select
              key={`entityId:${state.values?.entityId ?? ""}`}
              id={`${idPrefix}-entity`}
              name="entityId"
              defaultValue={state.values?.entityId ?? options[0]?.id ?? ""}
              aria-describedby={
                state.fieldErrors?.entityId ? `${idPrefix}-error` : undefined
              }
              className="h-11 w-full min-w-0 border border-rule bg-surface px-3 text-base text-ink hover:border-ink focus:border-accent"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={`${idPrefix}-name`} className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
              Network name
            </label>
            <input
              id={`${idPrefix}-name`}
              name="displayName"
              type="text"
              maxLength={MAX_NAME}
              defaultValue={state.values?.displayName ?? ""}
              placeholder="How this shows up on the network"
              aria-describedby={
                state.fieldErrors?.displayName ? `${idPrefix}-name-error` : undefined
              }
              aria-invalid={state.fieldErrors?.displayName ? true : undefined}
              className={
                "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
                (state.fieldErrors?.displayName
                  ? "border-danger"
                  : "border-rule hover:border-ink focus:border-accent")
              }
            />
            {state.fieldErrors?.displayName ? (
              <p id={`${idPrefix}-name-error`} role="alert" className="text-sm font-semibold text-danger">
                {state.fieldErrors.displayName}
              </p>
            ) : null}
          </div>
        </div>
      )}

      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={empty}
          aria-describedby={empty ? `${idPrefix}-empty` : undefined}
          pending={pending}
          pendingLabel="Creating…"
        >
          Create draft
          {/* One of these forms renders per kind (up to four on the page);
              the kind disambiguates the accessible name (keyboard-a11y
              pass) — the visible <h3> above is not part of the button's
              name computation. */}
          <span className="sr-only"> — {NETWORK_ENTITY_KIND_LABELS[kind]}</span>
        </Button>
      </div>
    </form>
  );
}
