import type { Metadata } from "next";
import Link from "next/link";
import { getActiveMemberships, getCurrentUser, getPendingInvites } from "@/lib/auth";
import { AcceptInviteForm } from "@/components/org/accept-invite-form";
import { AccountSetupForm } from "@/components/auth/account-setup-form";
import { RuledList, RuledRow, StatusChip } from "@/components/ui/ruled-row";

export const metadata: Metadata = { title: "Invitations · GetSetPaid" };

// Where an invitee lands after clicking the emailed link.
//
// HOW THE INVITATIONS ARE FOUND: a plain SELECT under the invitee's own
// session. The "select own rows" policy on organisation_memberships returns
// their rows at ANY status, so a pending 'invited' row is visible to them
// without any special access -- no lookup token in the URL, nothing to leak,
// and nothing an attacker can enumerate. The membership id then goes to
// accept_invite(), which re-checks ownership in the database anyway.
//
// WHAT AN INVITED USER CAN AND CANNOT SEE: they are not yet an active member,
// so organisations_select_member hides the organisation row -- which means we
// genuinely cannot show them the workspace's name until they accept. That is
// the tenancy model working correctly, not a bug to route around, so the copy
// says what is true rather than pretending to know.
export default async function InvitesPage({
  searchParams,
}: PageProps<"/invites">) {
  const params = await searchParams;
  // Set by /auth/callback after verifying an invite token. Only controls
  // whether the account-setup block is offered -- it grants nothing, so a
  // hand-typed ?welcome=1 shows a form the user could reach anyway.
  const welcome = params.welcome === "1";

  const [user, invites, active] = await Promise.all([
    getCurrentUser(),
    getPendingInvites(),
    getActiveMemberships(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          {welcome ? "Welcome to GetSetPaid" : "Invitations"}
        </h1>
        <p className="text-lg text-ink-muted">
          {invites.length > 0
            ? "Accept an invitation to join a workspace. You'll see its contacts, events and financials once you're in."
            : "You don't have any invitations waiting."}
        </p>
      </div>

      {invites.length > 0 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-bold text-ink">Waiting for you</h2>
          <RuledList>
            {invites.map((invite) => {
              // Empty name = the org row is hidden from them until they accept.
              const name = invite.organisation.name || "A GetSetPaid workspace";
              return (
                <RuledRow
                  key={invite.id}
                  title={name}
                  meta={
                    <>
                      Invited as {roleLabel(invite.role)} ·{" "}
                      <time dateTime={invite.invitedAt} className="tabular-nums">
                        {formatDate(invite.invitedAt)}
                      </time>
                    </>
                  }
                  status={<StatusChip tone="pending">Pending</StatusChip>}
                  action={
                    <AcceptInviteForm
                      membershipId={invite.id}
                      organisationName={name}
                    />
                  }
                />
              );
            })}
          </RuledList>
        </section>
      ) : null}

      {welcome ? (
        <section className="flex flex-col gap-4 border-t border-rule pt-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-ink">Finish setting up</h2>
            <p className="text-base text-ink-muted">
              You were signed in by an emailed link. Set a password so you can
              sign in again without one.
            </p>
          </div>
          <div className="max-w-md">
            <AccountSetupForm defaultName={user?.fullName} />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3 border-t border-rule pt-8">
        {active.length > 0 ? (
          <p className="text-base text-ink-muted">
            Your workspaces:{" "}
            {active.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ", " : ""}
                <Link
                  href={`/${m.organisation.slug}`}
                  className="text-primary underline underline-offset-4 hover:text-ink"
                >
                  {m.organisation.name}
                </Link>
              </span>
            ))}
            .
          </p>
        ) : (
          <p className="text-base text-ink-muted">
            Not expecting an invitation?{" "}
            <Link
              href="/onboarding"
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              Create your own workspace
            </Link>{" "}
            instead.
          </p>
        )}
      </section>
    </div>
  );
}

/** Role keys are snake_case in the database; people are not. */
function roleLabel(key: string): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * en-GB, explicitly. CLAUDE.md § Non-functional targets: UTC in the database,
 * UK local time in the UI. Left to the default locale this renders as a US
 * date on a US-configured machine, and 03/04 is a different day depending on
 * where you are standing.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
