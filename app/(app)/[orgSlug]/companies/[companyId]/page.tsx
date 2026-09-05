import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { RelatedPanel } from "@/components/crm/related-panel";
import type { RawSearchParams } from "@/lib/list/params";
import {
  activityIsScoped,
  activityParams,
  fetchActivityPage,
} from "@/lib/crm/activity";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  loadCompany,
  loadContactsForCompany,
  loadLinkOptions,
} from "@/lib/crm/queries";
import { companyTypeLabel } from "@/lib/crm/companies-list";
import { deleteCompanyAction, restoreCompanyAction } from "@/lib/crm/companies";
import { loadCustomFieldPanel } from "@/lib/crm/custom-field-queries";
import { CustomFieldsPanel } from "@/components/crm/custom-fields-panel";
import { Alert } from "@/components/ui/alert";
import { MergedIntoNotice } from "@/components/crm/merged-notice";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import { ContactCompanyPanel } from "@/components/crm/link-panel";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";
import { NetworkIdentityRow } from "@/components/network/network-identity-row";
import { loadNetworkProfileForEntity } from "@/lib/network/entities";
import { profileHasDrifted } from "@/lib/network/drift";

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "company-manage-blocked";

// One company. The other side of the contact_companies join.
//
// The Task 7 activity timeline sits below the People panel, same as on a
// contact -- one shared component over public.activity_events. See the contact
// detail page's header, and lib/crm/activity.ts for the contract.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/companies/[companyId]">): Promise<Metadata> {
  const { orgSlug, companyId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadCompany(org.id, companyId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Companies · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function CompanyDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/companies/[companyId]">) {
  const { orgSlug, companyId } = await params;
  // `?merged=1` -- see components/crm/merged-notice.tsx. A FLAG, never the
  // merged-away record's name: that name is personal data and a query string is
  // logged, bookmarked and pasted into support tickets.
  const raw = (await searchParams) as RawSearchParams;
  const justMerged = raw.merged === "1";
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadCompany(org.id, companyId),
    getCrmWriteAccess(org, "manage_contacts"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this company just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const company = result.record;
  const links = await loadContactsForCompany(org.id, company.id);
  const options = access.canWrite
    ? await loadLinkOptions(
        "contacts",
        org.id,
        links.map((l) => l.otherId),
      )
    : [];

  const blocked = access.canWrite ? null : access.explanation;
  // See the contact detail page's copy: a deleted record's links are not
  // editable, and this route serves deleted records on purpose.
  const panelBlocked =
    company.deletedAt !== null ? DELETED_RECORD_EXPLANATION : blocked;
  // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
  // the panel is a Client Component and this is the only place with an
  // RLS-scoped server client. `includeRemoved` is implied: the loader
  // returns the values of REMOVED fields too, which is what makes
  // "removing a field keeps what was filled in" visible rather than merely
  // true (20260829010000, decision 1).
  const customFields = await loadCustomFieldPanel(org.id, "company", company.id);
  // A CUSTOM FIELD VALUE IS AN ORDINARY CRM WRITE ON THIS RECORD, so the
  // key that gates it is the company's own key --
  // private.entity_is_manageable() maps this entity type to it in the
  // database, and lib/crm/custom-fields.ts's PERMISSION_FOR_ENTITY mirrors
  // that mapping for the sentence. `manage_custom_fields` governs the
  // DEFINITION and nothing here.
  //
  // A DELETED RECORD'S VALUES ARE READ-ONLY, and as of 20260829011000 that
  // is a policy term (private.entity_is_live() in the three
  // custom_field_values write policies), not only an application check --
  // so this is the explanation rather than the control.
  const customFieldsBlocked =
    company.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : access.canWrite
        ? null
        : access.explanation;
  const basePath = `/${org.slug}/companies`;

  // THE TIMELINE'S OWN PAGE OF ITS OWN LIST. `activityParams` reads only keys
  // beginning `activity_`, and not even `activity_q` -- there is no search
  // control on this surface (lib/crm/activity.ts). So it cannot be confused by
  // `?merged=1`, or narrowed by a hand-edited URL, or disturbed by anything a
  // later phase adds to this route.
  const activityListParams = activityParams(raw);
  const activity = await fetchActivityPage(
    org.id,
    "company",
    company.id,
    activityListParams,
  );

  // THE NETWORK IDENTITY ROW (Phase 6 Task 2, Q75). A plain lookup of THIS
  // organisation's own network_profiles row for THIS company -- never a join,
  // never a cross-tenant read (lib/network/entities.ts's header). `companies`
  // has no city/country/website columns (20260827232510), so the drift
  // comparison below has only `name` to check for a company -- the one field
  // every kind shares.
  const networkProfile = await loadNetworkProfileForEntity(
    org.id,
    "company",
    company.id,
  );
  const networkDrifted =
    networkProfile !== null &&
    profileHasDrifted(
      { name: company.name },
      {
        displayName: networkProfile.displayName,
        country: networkProfile.country,
        city: networkProfile.city,
        websiteUrl: networkProfile.websiteUrl,
      },
    );

  return (
    <div className="flex flex-col gap-8">
      {justMerged ? (
        <MergedIntoNotice noun="company" historyHref={`/${org.slug}/merges`} />
      ) : null}
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Companies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {company.name}
        </h1>
        {company.type.length > 0 ? (
          <p className="flex flex-wrap gap-2">
            {company.type.map((value) => (
              <span
                key={value}
                className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {companyTypeLabel(value)}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-base text-ink-muted">Untyped</p>
        )}
      </div>

      {company.deletedAt !== null ? (
        <div role="status" className="border border-rule-strong bg-surface px-3 py-3">
          <p className="text-base text-ink">
            <span className="font-semibold text-warning">Deleted.</span> This
            company was deleted on{" "}
            <time dateTime={company.deletedAt} className="tabular-nums">
              {formatDateTime(company.deletedAt)}
            </time>
            . Its links to people are still here and come back with it.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            Added
          </dt>
          <dd className="text-base text-ink">
            <time dateTime={company.createdAt} className="tabular-nums">
              {formatDateTime(company.createdAt)}
            </time>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            Last updated
          </dt>
          <dd className="text-base text-ink">
            <time dateTime={company.updatedAt} className="tabular-nums">
              {formatDateTime(company.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>

      <ContactCompanyPanel
        orgSlug={org.slug}
        side="company"
        anchorId={company.id}
        linked={links.map((link) => ({
          id: link.otherId,
          name: link.otherName,
          isPrimary: link.isPrimary,
          isDeleted: link.otherDeleted,
          href: `/${org.slug}/contacts/${link.otherId}`,
        }))}
        options={options}
        disabledReason={panelBlocked}
      />

      {/* A FAILED QUERY IS NOT AN EMPTY PANEL. Rendering nothing here
          would tell a user with forty custom fields that they have none,
          which is the one thing the empty state must never do. */}
      {customFields.outcome === "unavailable" ? (
        <Alert tone="error">
          We couldn’t load this record’s custom fields just now. Refresh the
          page to try again — nothing has been changed.
        </Alert>
      ) : (
        <CustomFieldsPanel
          orgSlug={org.slug}
          entityType="company"
          entityId={company.id}
          live={customFields.panel.live}
          removed={customFields.panel.removed}
          disabledReason={customFieldsBlocked}
        />
      )}

      {/* THE SHARED ACTIVITY TIMELINE (Task 7). One component, five pages,
          and every later phase's sources arrive as branches of
          public.activity_events rather than as a second component --
          lib/crm/activity.ts's header is the contract. */}
      {/* THE RELATED PANEL (Phase 4 Task 3). Four lib/list/ surfaces on this
          route now (three related + the timeline), each passed preserve (rule 10). */}
      <RelatedPanel
        orgSlug={org.slug}
        organisationId={org.id}
        entityType="company"
        entityId={company.id}
        basePath={`${basePath}/${company.id}`}
        raw={raw}
      />

      <ActivityTimeline
        orgSlug={org.slug}
        subjectType="company"
        page={activity}
        params={activityListParams}
        basePath={`${basePath}/${company.id}`}
        recordScoped={activityIsScoped(org.role)}
        preserve={raw}
      />

      <NetworkIdentityRow
        orgSlug={org.slug}
        profile={networkProfile}
        drifted={networkDrifted}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {/* One explanation for the group -- see the contact page's copy. */}
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {company.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${company.id}/edit`}
                label="Edit company"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteCompanyAction}
              hiddenFields={{ orgSlug: org.slug, companyId: company.id }}
              label="Delete company"
              question={`Delete ${company.name}? It comes out of the companies list. Anyone linked to it keeps the link, and you can restore it from Companies › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreCompanyAction}
            hiddenFields={{ orgSlug: org.slug, companyId: company.id }}
            label="Restore company"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}
