import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import {
  loadCompany,
  loadContactsForCompany,
  loadLinkOptions,
} from "@/lib/crm/queries";
import { companyTypeLabel } from "@/lib/crm/companies-list";
import { deleteCompanyAction, restoreCompanyAction } from "@/lib/crm/companies";
import { Alert } from "@/components/ui/alert";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import { ContactCompanyPanel } from "@/components/crm/link-panel";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "company-manage-blocked";

// One company. The other side of the contact_companies join.
//
// Task 7's activity timeline lands below the People panel, same as on a
// contact. No placeholder -- see the contact detail page's header for why.

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
}: PageProps<"/[orgSlug]/companies/[companyId]">) {
  const { orgSlug, companyId } = await params;
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
  const basePath = `/${org.slug}/companies`;

  return (
    <div className="flex flex-col gap-8">
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
        disabledReason={blocked}
      />

      {/* Task 7's activity timeline goes here. */}

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
