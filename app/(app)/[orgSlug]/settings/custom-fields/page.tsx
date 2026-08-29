import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import {
  loadCustomFieldCounts,
  loadCustomFieldDefinitions,
} from "@/lib/crm/custom-field-queries";
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  customFieldLimit,
  ENTITY_TYPE_LABELS,
  isCustomFieldEntityType,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";
import { CustomFieldEditor } from "@/components/crm/custom-field-editor";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";

// Settings › Custom fields. One screen, five tabs, one per entity type.
//
// ===========================================================================
// THE ENTITY TYPE IS A QUERY PARAMETER, NOT A ROUTE SEGMENT
// ===========================================================================
// `/settings/custom-fields/[entityType]` would be five routes' worth of
// generated types for a tab strip, and it would put the five-value allowlist
// into the ROUTER as well as into the three CHECK constraints and
// lib/crm/custom-fields.ts. `?entity=` keeps the copies at four and keeps the
// validation in one place: anything that is not one of the five falls back to
// `contact` rather than 404ing, because a mistyped tab is not a missing page.
//
// ===========================================================================
// THE PAGE RENDERS FOR EVERYONE WITH view_crm, READ-ONLY FOR MOST OF THEM
// ===========================================================================
// `manage_custom_fields` is Owner and Admin only, and a definition is readable
// by anyone with `view_crm` -- the SELECT policy has no record scope on
// purpose (20260828121000: "a definition is not a record, it is the label and
// type that make a value renderable"). So a Manager or a Read Only user who
// reaches this URL sees the real list with the real count and a sentence
// saying who can change it, rather than a 404 that would imply the workspace
// has no custom fields.
//
// A caller WITHOUT view_crm gets an explicit sentence rather than an empty
// list, because an empty list would be a lie: the rows are there and the
// policy is hiding them. "The empty state must not lie" applies to the reason
// as well as to the count.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/settings/custom-fields">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Custom fields · Settings · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

const BLOCKED_NOTE = "custom-fields-blocked";

export default async function CustomFieldsSettingsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/settings/custom-fields">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const query = await searchParams;
  const requested = typeof query.entity === "string" ? query.entity : "";
  const entityType: CustomFieldEntityType = isCustomFieldEntityType(requested)
    ? requested
    : "contact";

  const [canRead, access, entitlements] = await Promise.all([
    hasPermission(org.id, "view_crm"),
    getCrmWriteAccess(org, "manage_custom_fields"),
    getOrganisationEntitlements(org.id),
  ]);

  const heading = (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        <Link
          href={`/${org.slug}`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          {org.name}
        </Link>
      </p>
      <h1 className="tracking-display text-3xl font-extrabold text-ink">
        Custom fields
      </h1>
      <p className="max-w-prose text-base text-ink-muted">
        Extra fields on your records, for whatever this workspace tracks that
        GetSetPaid doesn’t have a box for. Every field you add here appears on
        every record of that type.
      </p>
    </div>
  );

  if (!canRead) {
    return (
      <div className="flex flex-col gap-8">
        {heading}
        <Alert tone="info">
          Your role in this workspace can’t see its records, so it can’t see
          their custom fields either. Ask an Owner or Admin if you need access.
        </Alert>
      </div>
    );
  }

  const [counts, definitions] = await Promise.all([
    loadCustomFieldCounts(org.id),
    loadCustomFieldDefinitions(org.id, entityType, { includeRemoved: true }),
  ]);

  // A FAILED QUERY IS NOT AN EMPTY WORKSPACE.
  if (definitions.outcome === "unavailable" || counts.outcome === "unavailable") {
    return (
      <div className="flex flex-col gap-8">
        {heading}
        <Alert tone="error">
          We couldn’t load this workspace’s custom fields just now. Refresh the
          page to try again — nothing has been changed.
        </Alert>
      </div>
    );
  }

  const live = definitions.definitions.filter((d) => d.deletedAt === null);
  const removed = definitions.definitions.filter((d) => d.deletedAt !== null);
  const limit = customFieldLimit(entitlements);

  return (
    <div className="flex flex-col gap-8">
      {heading}

      {/* A tab strip as a list of links, so it works without JavaScript, is
          bookmarkable, and lands a keyboard user on the same page they can
          already reach with Back. `aria-current="page"` is what announces the
          selected one -- the border alone would be colour-and-shape only. */}
      <nav aria-label="Record type">
        <ul className="flex flex-wrap gap-x-2 gap-y-2 border-b border-rule pb-3">
          {CUSTOM_FIELD_ENTITY_TYPES.map((type) => {
            const selected = type === entityType;
            return (
              <li key={type}>
                <Link
                  href={`/${org.slug}/settings/custom-fields?entity=${type}`}
                  aria-current={selected ? "page" : undefined}
                  className={
                    "inline-flex h-11 items-center border px-3 text-base no-underline " +
                    (selected
                      ? "border-accent bg-surface font-semibold text-ink"
                      : "border-rule bg-surface text-ink hover:border-ink")
                  }
                >
                  {ENTITY_TYPE_LABELS[type]}{" "}
                  <span className="ml-2 tabular-nums text-ink-muted">
                    {counts.counts[type]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <WriteBlockedNote access={access} id={BLOCKED_NOTE} />

      <CustomFieldEditor
        orgSlug={org.slug}
        entityType={entityType}
        live={live}
        removed={removed}
        limit={limit}
        disabledReason={
          access.canWrite
            ? null
            : // The same sentence the disabled-control note carries. Two
              // different explanations for one situation is how a user
              // concludes one of them is wrong.
              access.explanation
        }
      />
    </div>
  );
}
