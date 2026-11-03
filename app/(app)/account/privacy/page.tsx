import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getPublishedLegalDocument } from "@/lib/legal/published";
import { getOwnConsentState, type ConsentEvent } from "@/lib/consent/ledger";
import { MARKETING_EMAIL } from "@/lib/consent/catalogue";
import { formatDateTime } from "@/lib/format/date";
import { Alert } from "@/components/ui/alert";
import { RuledList, RuledRow, StatusChip } from "@/components/ui/ruled-row";
import { MarketingConsentForm } from "@/components/account/marketing-consent-form";

export const metadata: Metadata = { title: "Privacy and communications · GetSetPaid" };

// PHASE 8 TASK 2 -- the account-level privacy control PRD §12 asks for.
//
// ACCOUNT-LEVEL, NOT A WORKSPACE PAGE. Consent to marketing is the person's,
// not their employer's, so this sits outside `[orgSlug]` and reads nothing
// tenant-scoped. It lives under the (app) layout, so it is signed-in and
// MFA-gated like every other signed-in screen.
//
// WHAT IT DOES NOT ASK. Only marketing email is a consent choice. Service
// messages are part of running the service (contract), and every item of
// browser storage is strictly necessary (Q129) -- both are EXPLAINED here and
// deliberately not offered as toggles, because a toggle for something that is
// not consent-based is the "bundled consent" CLAUDE.md forbids.
export default async function AccountPrivacyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [policy, state] = await Promise.all([
    getPublishedLegalDocument(MARKETING_EMAIL.policySlug),
    getOwnConsentState(user.id, MARKETING_EMAIL),
  ]);
  if (!policy) {
    // Every slug is seeded and nothing can unpublish one; a missing row is a
    // deployment without the seed, and agreeing to nothing is not agreeing.
    throw new Error("The Marketing and Communications Preferences page is not published.");
  }

  const current = state.current;
  const agreed = current?.action === "granted";

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Privacy and communications
        </h1>
        <p className="max-w-prose text-lg text-ink-muted">
          Choices about how GetSetPaid contacts you. They belong to your account, not to a
          workspace, and apply wherever you work.
        </p>
      </div>

      <section aria-labelledby="marketing-heading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="marketing-heading" className="text-xl font-bold text-ink">
            Marketing email
          </h2>
          <StatusChip tone={agreed ? "active" : "revoked"}>
            {agreed ? "Agreed" : "Not agreed"}
          </StatusChip>
        </div>

        <Alert tone="info" live={false}>
          GetSetPaid does not send marketing email today, whatever you choose here. Agreeing
          only means we may, if that changes.
        </Alert>

        <p className="max-w-prose text-base text-ink" data-testid="consent-state">
          {describeState(current)}
        </p>

        <figure className="flex max-w-prose flex-col gap-2 border-l-2 border-rule pl-4">
          <figcaption className="text-sm text-ink-muted">What you are agreeing to</figcaption>
          <blockquote className="text-base text-ink">{MARKETING_EMAIL.statement}</blockquote>
        </figure>

        <p className="max-w-prose text-sm text-ink-muted">
          Governed by{" "}
          <Link
            href={`/legal/${policy.slug}`}
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            {policy.title}
          </Link>
          , <span className="tabular-nums">version {policy.version}</span>, which says what we
          record when you choose.
          {current && current.policyVersion !== policy.version ? (
            <>
              {" "}
              Your last choice was made under{" "}
              <span className="tabular-nums">version {current.policyVersion}</span>.
            </>
          ) : null}
        </p>

        <MarketingConsentForm agreed={agreed} policyVersion={policy.version} />
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-4">
        <h2 id="history-heading" className="text-xl font-bold text-ink">
          Your marketing email history
        </h2>
        {state.history.length === 0 ? (
          <p className="text-base text-ink-muted">
            Nothing yet. Each time you agree or withdraw, a record appears here.
          </p>
        ) : (
          <>
            <RuledList>
              {state.history.map((event) => (
                <RuledRow
                  key={event.id}
                  title={event.action === "granted" ? "Agreed" : "Withdrew agreement"}
                  meta={
                    <>
                      <time dateTime={event.occurredAt} className="tabular-nums">
                        {formatDateTime(event.occurredAt)}
                      </time>{" "}
                      (UK time) · on this page
                    </>
                  }
                  status={
                    <span className="tabular-nums">
                      Marketing preferences version {event.policyVersion}
                    </span>
                  }
                />
              ))}
            </RuledList>
            {state.truncated ? (
              <p className="text-sm text-ink-muted">
                Showing your most recent {state.history.length} choices. Older records are kept
                and are included if you ask us for a copy of your data.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="service-heading" className="flex flex-col gap-3">
        <h2 id="service-heading" className="text-xl font-bold text-ink">
          Service messages
        </h2>
        <p className="max-w-prose text-base text-ink">
          Sign-in and password emails, a notice when password sign-in to your account is locked,
          and similar messages are needed to run the service. They are not marketing, so there is
          no choice to make about them here.
        </p>
      </section>

      <section aria-labelledby="storage-heading" className="flex flex-col gap-3">
        <h2 id="storage-heading" className="text-xl font-bold text-ink">
          Cookies and browser storage
        </h2>
        <p className="max-w-prose text-base text-ink">
          GetSetPaid only stores what it needs to work — keeping you signed in, remembering your
          workspace and a display choice, and signing you out when idle. None of it needs your
          consent, so there is nothing to switch on or off. The{" "}
          <Link
            href="/legal/cookies"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Cookie Policy
          </Link>{" "}
          lists every item.
        </p>
      </section>
    </div>
  );
}

function describeState(current: ConsentEvent | null): string {
  if (!current) {
    return "You have not agreed to marketing email.";
  }
  const when = `${formatDateTime(current.occurredAt)} (UK time)`;
  return current.action === "granted"
    ? `You agreed on ${when}, under version ${current.policyVersion} of the Marketing and Communications Preferences.`
    : `You withdrew your agreement on ${when}. You have not agreed to marketing email.`;
}
