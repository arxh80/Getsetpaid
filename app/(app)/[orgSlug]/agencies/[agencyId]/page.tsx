import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  loadAgency,
  loadLinkOptions,
  loadRepresentationsForAgency,
} from "@/lib/crm/queries";
import { deleteAgencyAction, restoreAgencyAction } from "@/lib/crm/agencies";
import { Alert } from "@/components/ui/alert";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import { RepresentationPanel } from "@/components/crm/representation-panel";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";

// One agency. The other side of artist_representations.
//
// ===========================================================================
// TWO PERMISSION KEYS ON ONE PAGE, AND THAT IS NOT A MISTAKE
// ===========================================================================
// The agency RECORD is `manage_contacts` (20260828121000 groups agencies with
// contacts and companies as "the relationship layer"). The REPRESENTATIONS
// listed on it are `manage_artists`, because
// `artist_representations_*_via_artist` reach EXISTS against `artists` and are
// gated on that key.
//
// WHICH ROLES DIVERGE, READ OUT OF role_permissions RATHER THAN GUESSED. An
// earlier version of this comment said a Booker was the divergent case, on the
// reasoning that a Booker is an artist role. That is wrong, and the RLS suite
// (T22c) is where it was caught:
//
//   owner, admin, manager, standard_user   both keys      no difference
//   booker         manage_artists, manage_contacts        no difference
//   venue_manager  manage_contacts, manage_venues         agency YES, panel NO
//   marketing      manage_contacts                        agency YES, panel NO
//   finance, read_only                     view_crm only  neither
//
// `manage_contacts` is the WIDEST key in the matrix -- every role but finance
// and read_only holds it -- because it covers contacts, companies and agencies
// together, the relationship layer everybody in a booking business works in.
// So the case this page has to get right is a VENUE MANAGER or a MARKETING
// user: they can rename and delete the agency and must not be offered controls
// on the representations listed under it. Asking for one key and using it for
// both panels would offer them a panel that refuses. T22h-T22k measure both
// halves on the same session.
//
// Task 7's activity timeline lands below the representation panel.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/agencies/[agencyId]">): Promise<Metadata> {
  const { orgSlug, agencyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadAgency(org.id, agencyId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Agencies · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "agency-manage-blocked";

export default async function AgencyDetailPage({
  params,
}: PageProps<"/[orgSlug]/agencies/[agencyId]">) {
  const { orgSlug, agencyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access, artistAccess] = await Promise.all([
    loadAgency(org.id, agencyId),
    getCrmWriteAccess(org, "manage_contacts"),
    getCrmWriteAccess(org, "manage_artists"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD -- same rule as the list surface.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this agency just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const agency = result.record;
  const rows = await loadRepresentationsForAgency(org.id, agency.id);
  // NO EXCLUSION LIST, unlike the contact/company picker. The schema is
  // explicit that the same agency representing the same artist twice is
  // legitimate -- 20260827232510: "the same agency representing the same
  // artist in two territories, or over two separate periods, is exactly the
  // case the PRD asks for" -- so there is no uniqueness to protect and
  // filtering the artist out would refuse a real relationship.
  const [artistOptions, contactOptions] = artistAccess.canWrite
    ? await Promise.all([
        loadLinkOptions("artists", org.id, []),
        loadLinkOptions("contacts", org.id, []),
      ])
    : [[], []];

  // WHY THE PANEL NEEDS THE ROLE AND NOT ONLY THE ACCESS. An empty picker
  // means "this workspace has none" for a full-scope viewer and "none are
  // assigned to you" for a record-scoped one. Task 4b's browser pass rendered
  // the first sentence to `pstd1` on a page listing six representations; see
  // RepresentationPanel's `recordScoped` prop.
  const recordScoped = isRecordScopedRole(org.role);
  // THE PANEL HAS A SECOND REASON TO BE READ-ONLY, and this route is where it
  // applies. The detail route deliberately serves DELETED records -- that is
  // how restore is reached -- so without this the whole panel would render
  // next to the record's own "Deleted" notice. lib/crm/artists.ts enforces the
  // same rule, so this is the explanation and not the control.
  const panelBlocked =
    agency.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : artistAccess.canWrite
        ? null
        : artistAccess.explanation;
  const basePath = `/${org.slug}/agencies`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Agencies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {agency.name}
        </h1>
      </div>

      {agency.deletedAt !== null ? (
        <div role="status" className="border border-rule-strong bg-surface px-3 py-3">
          <p className="text-base text-ink">
            <span className="font-semibold text-warning">Deleted.</span> This
            agency was deleted on{" "}
            <time dateTime={agency.deletedAt} className="tabular-nums">
              {formatDateTime(agency.deletedAt)}
            </time>
            . The representations it holds are still recorded and come back with
            it.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            Added
          </dt>
          <dd className="text-base text-ink">
            <time dateTime={agency.createdAt} className="tabular-nums">
              {formatDateTime(agency.createdAt)}
            </time>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            Last updated
          </dt>
          <dd className="text-base text-ink">
            <time dateTime={agency.updatedAt} className="tabular-nums">
              {formatDateTime(agency.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>

      <RepresentationPanel
        orgSlug={org.slug}
        side="agency"
        anchorId={agency.id}
        rows={rows.map((row) => ({
          id: row.id,
          artistId: row.artist.id,
          agencyId: row.agency.id,
          otherId: row.artist.id,
          otherName: row.artist.name,
          otherHref: `/${org.slug}/artists/${row.artist.id}`,
          otherDeleted: row.artist.deleted,
          contactId: row.contact?.id ?? null,
          contactName: row.contact?.name ?? null,
          contactHref: row.contact ? `/${org.slug}/contacts/${row.contact.id}` : null,
          contactDeleted: row.contact?.deleted ?? false,
          role: row.role,
          territory: row.territory,
          isExclusive: row.isExclusive,
          primaryState: row.primaryState,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          isRemoved: row.deletedAt !== null,
        }))}
        otherOptions={artistOptions}
        contactOptions={contactOptions}
        recordScoped={recordScoped}
        disabledReason={panelBlocked}
      />

      {/* Task 7's activity timeline goes here. No placeholder heading: a dead
          affordance is worse than a comment, and an empty <section> is a thing
          someone later has to work out the purpose of. */}

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {/* ONE EXPLANATION FOR THE WHOLE GROUP, above the controls it explains
            and referenced by each of them through aria-describedby. Repeating
            it per control puts the same sentence between a screen-reader user
            and every button. */}
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {agency.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${agency.id}/edit`}
                label="Edit agency"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteAgencyAction}
              hiddenFields={{ orgSlug: org.slug, agencyId: agency.id }}
              label="Delete agency"
              question={`Delete ${agency.name}? It comes out of the agencies list. Every representation it holds stays recorded, and you can restore it from Agencies › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreAgencyAction}
            hiddenFields={{ orgSlug: org.slug, agencyId: agency.id }}
            label="Restore agency"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets:
 *  UTC in the database, UK local time in the UI with explicit handling. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}
