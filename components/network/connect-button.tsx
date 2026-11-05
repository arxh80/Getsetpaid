"use client";

import { useActionState } from "react";
import Link from "next/link";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { sendConnectionRequestAction } from "@/lib/network/connections";
import type { OwnPublishedProfile } from "@/lib/network/entities";
import { NETWORK_ENTITY_KIND_LABELS } from "@/lib/network/fields";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Task 4: the send control on Task 3's profile page
// (app/(app)/[orgSlug]/network/[profileId]/page.tsx) -- that page renders the
// disabled shell unconditionally; this component gives it an `action`.
//
// ===========================================================================
// THREE STATES, AND THE ORDER MATTERS
// ===========================================================================
//   1. `!connectAccess.canWrite` -- suspended, tier or the permission. Same
//      disabled-with-a-sentence shape Task 3 shipped, using the SAME
//      `connectAccess.explanation` a submitted form would get back if the
//      `disabled` attribute were stripped (Constraint 12's "the two paths
//      must not disagree").
//   2. `ownProfiles.length === 0` -- Q78: sending needs at least one PUBLISHED
//      profile of the sender's, and this organisation has none. THE REFUSAL
//      THAT TEACHES (DESIGN.md's empty-states rule, named in the brief): a
//      sentence plus a link straight to Task 2's editor, not a dead end.
//   3. Otherwise: a real form. One published profile submits a hidden
//      `fromProfileId`; more than one offers a `<select>` (Constraint 11: keyed
//      on the state cycle, since React does not restore a `<select>`'s chosen
//      option after the action resets the form).
export function ConnectButton({
  orgSlug,
  toProfileId,
  canWrite,
  explanation,
  ownProfiles,
  moreOwnProfiles = false,
}: {
  orgSlug: string;
  toProfileId: string;
  canWrite: boolean;
  /** `connectAccess.explanation` when `canWrite` is false; the "publish a
   *  profile first" sentence lives in this component, not the caller's, since
   *  it depends on `ownProfiles` rather than on `connectAccess`. */
  explanation: string | undefined;
  ownProfiles: readonly OwnPublishedProfile[];
  /** G6: the list stops at OWN_PROFILES_LIMIT and there are more. */
  moreOwnProfiles?: boolean;
}) {
  const noteId = "network-connect-note";
  const [state, formAction, pending] = useActionState(
    sendConnectionRequestAction,
    EMPTY_FORM_STATE,
  );

  if (!canWrite) {
    return (
      <form action={formAction} className="flex flex-col gap-2 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Connect</h2>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="toProfileId" value={toProfileId} />
        {/* THE SERVER, NOT THE BROWSER, REFUSES (Constraint 12). This form
            DOES carry `action={formAction}` even though its one button is
            disabled: a caller who strips the `disabled` attribute and submits
            reaches `sendConnectionRequestAction` for real, and
            `authoriseConnections` there returns the SAME `explanation` string
            as an error -- so a submitted form and this disabled control never
            disagree about why. Without a real `action` here, a stripped
            submit would fall back to the browser's default GET-to-self, which
            proves nothing about server-side enforcement. */}
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <p id={noteId} className="max-w-prose text-sm text-ink-muted">
          {explanation}
        </p>
        <div>
          <Button type="submit" disabled aria-describedby={noteId} pending={pending}>
            Request connection
          </Button>
        </div>
      </form>
    );
  }

  if (ownProfiles.length === 0) {
    return (
      <div className="flex flex-col gap-2 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Connect</h2>
        <p id={noteId} className="max-w-prose text-sm text-ink-muted">
          You need a published profile of your own before you can send a
          connection request — the recipient sees who is asking, and that has
          to be one of your own published identities.{" "}
          <Link
            href={`/${orgSlug}/network/profiles`}
            className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
          >
            Publish a profile
          </Link>
          .
        </p>
        <div>
          <Button type="button" disabled aria-describedby={noteId}>
            Request connection
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Connect</h2>
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="toProfileId" value={toProfileId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {ownProfiles.length === 1 ? (
        <>
          <p className="max-w-prose text-sm text-ink-muted">
            Sent from{" "}
            <span className="font-semibold text-ink">
              {ownProfiles[0]!.displayName}
            </span>{" "}
            ({NETWORK_ENTITY_KIND_LABELS[ownProfiles[0]!.entityKind]}).
          </p>
          <input type="hidden" name="fromProfileId" value={ownProfiles[0]!.id} />
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor="connect-from-profile" className="text-sm font-semibold text-ink">
            Send from
          </label>
          <select
            // Constraint 11: remounts to the default choice after each submit,
            // since React does not restore a `<select>`'s option on the reset.
            key={`from:${state.error ?? ""}:${state.message ?? ""}`}
            id="connect-from-profile"
            name="fromProfileId"
            defaultValue={ownProfiles[0]!.id}
            className="h-11 w-full max-w-sm border border-rule bg-surface px-3 text-base text-ink hover:border-ink focus:border-accent"
          >
            {ownProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName} ({NETWORK_ENTITY_KIND_LABELS[profile.entityKind]})
              </option>
            ))}
          </select>
          {moreOwnProfiles ? (
            <p className="max-w-prose text-sm text-ink-muted">
              Showing your first {ownProfiles.length} published profiles, in name order.
            </p>
          ) : null}
        </div>
      )}

      <div>
        <Button type="submit" pending={pending} pendingLabel="Sending…">
          Request connection
        </Button>
      </div>
    </form>
  );
}
