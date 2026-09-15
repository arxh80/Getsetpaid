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
  loadCompaniesForContact,
  loadContact,
  loadLinkOptions,
} from "@/lib/crm/queries";
import { deleteContactAction, restoreContactAction } from "@/lib/crm/contacts";
import { loadCustomFieldPanel } from "@/lib/crm/custom-field-queries";
import { CustomFieldsPanel } from "@/components/crm/custom-fields-panel";
import { Alert } from "@/components/ui/alert";
import { MergedIntoNotice } from "@/components/crm/merged-notice";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { ContactCompanyPanel } from "@/components/crm/link-panel";
import { formatDateTime } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";
import { Detail } from "@/components/ui/detail";

// One contact.
//
// ===========================================================================
// THE ACTIVITY TIMELINE (Task 7), BELOW THE JOIN PANEL
// ===========================================================================
// One shared component on all five detail pages, over ONE relation --
// public.activity_events, a security_invoker view that unions the CRM tables
// into a uniform event row. Phase 3, 4 and 5 add their sources as BRANCHES of
// that view rather than as a second timeline; lib/crm/activity.ts's header is
// the contract, and 20260829040000 is the view.
//
// It is fetched with a plain await rather than inside a <Suspense>, matching
// the serial style this page already has for loadContact, the join panel and
// the custom fields. It costs ~8-10 ms; see the Task 7 report, which records
// that as a choice rather than an oversight.
//
// ===========================================================================
// A DELETED CONTACT RENDERS, AND THAT IS THE RESTORE PATH
// ===========================================================================
// `loadContact` does not filter `deleted_at`, so this route serves a
// soft-deleted record with a notice and a Restore control instead of a 404.
// Two things depend on it: the restore queue links straight here, and the
// delete confirmation leaves the user on the record they just deleted with the
// undo already in front of them. A 404 after deleting is the shape that makes
// people afraid of the delete button.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/contacts/[contactId]">): Promise<Metadata> {
  const { orgSlug, contactId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadContact(org.id, contactId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Contacts · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function ContactDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/contacts/[contactId]">) {
  const { orgSlug, contactId } = await params;
  // `?merged=1` -- see components/crm/merged-notice.tsx. A FLAG, never the
  // merged-away record's name: that name is personal data and a query string is
  // logged, bookmarked and pasted into support tickets.
  const raw = (await searchParams) as RawSearchParams;
  const justMerged = raw.merged === "1";

  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadContact(org.id, contactId),
    getCrmWriteAccess(org, "manage_contacts"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD. Same rule as the list surface and
  // the members page: "there is no such contact" is a claim about the
  // customer's data, and making it because the database was unreachable reads
  // as deletion.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this contact just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const contact = result.record;

  // THE TIMELINE'S OWN PAGE OF ITS OWN LIST. `activityParams` reads only keys
  // beginning `activity_`, and not even `activity_q` -- there is no search
  // control on this surface (lib/crm/activity.ts). So it cannot be confused by
  // `?merged=1`, or narrowed by a hand-edited URL, or disturbed by anything a
  // later phase adds to this route.
  const activityListParams = activityParams(raw);

  // ONE WAVE, NOT A WATERFALL. These three need `org.id` and `contact.id` and
  // nothing produced by each other, so awaiting them one at a time was three
  // sequential round trips for an ordering nobody asked for. See the agencies
  // page's identical comment.
  //
  // THE LINK PICKER IS NOT IN THIS WAVE, and that is not an oversight: its
  // exclusion list is `links.map(...)`, so it genuinely cannot start until
  // `links` has resolved. It stays serial below. Everything that CAN start at
  // once now does.
  const [links, customFields, activity] = await Promise.all([
    loadCompaniesForContact(org.id, contact.id),
    // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
    // the panel is a Client Component and this is the only place with an
    // RLS-scoped server client. `includeRemoved` is implied: the loader
    // returns the values of REMOVED fields too, which is what makes
    // "removing a field keeps what was filled in" visible rather than merely
    // true (20260829010000, decision 1).
    loadCustomFieldPanel(org.id, "contact", contact.id),
    fetchActivityPage(org.id, "contact", contact.id, activityListParams),
  ]);

  const options = access.canWrite
    ? await loadLinkOptions(
        "companies",
        org.id,
        links.map((l) => l.otherId),
      )
    : [];

  const blocked = access.canWrite ? null : access.explanation;
  // THE LINK PANEL HAS A SECOND REASON TO BE READ-ONLY, and this route is the
  // one place it applies. The detail route deliberately serves DELETED records
  // -- that is how restore is reached -- and it rendered the whole panel next
  // to the record's own "Deleted" notice, so Link / Unlink / Make primary were
  // offered on a record the /edit route refuses to open. The review changed a
  // soft-deleted contact's primary company from here and the write applied.
  // lib/crm/contacts.ts enforces the same rule, so this is the explanation and
  // not the control.
  const panelBlocked =
    contact.deletedAt !== null ? DELETED_RECORD_EXPLANATION : blocked;
  // A CUSTOM FIELD VALUE IS AN ORDINARY CRM WRITE ON THIS RECORD, so the
  // key that gates it is the contact's own key --
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
    contact.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : access.canWrite
        ? null
        : access.explanation;
  const basePath = `/${org.slug}/contacts`;

  return (
    <div className="flex flex-col gap-8">
      {justMerged ? (
        <MergedIntoNotice noun="contact" historyHref={`/${org.slug}/merges`} />
      ) : null}
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Contacts
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {contact.name}
        </h1>
        {contact.title ? (
          <p className="text-base break-words text-ink-muted">{contact.title}</p>
        ) : null}
      </div>

      {contact.deletedAt !== null ? (
        <div
          role="status"
          className="border border-rule-strong bg-surface px-3 py-3"
        >
          <p className="text-base text-ink">
            <span className="font-semibold text-warning">Deleted.</span> This
            contact was deleted on{" "}
            <time dateTime={contact.deletedAt} className="tabular-nums">
              {formatDateTime(contact.deletedAt)}
            </time>
            . It is out of the contacts list and out of search, and everything
            about it is still here.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Email">
          {contact.email ? (
            // mailto is generated from a value validated as an email address
            // by lib/crm/validate.ts, never from an arbitrary user URL --
            // which is why lib/crm/urls.ts's allowlist does not need to carry
            // `mailto:`. encodeURIComponent so a stored address containing a
            // `?` cannot smuggle mail headers into the link.
            <a
              href={`mailto:${encodeURIComponent(contact.email)}`}
              translate="no"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {contact.email}
            </a>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Phone">
          {contact.phone ? (
            <span translate="no" className="tabular-nums">
              {contact.phone}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Location">{contact.location ?? <Absent />}</Detail>
        <Detail label="Website">
          {/* `websiteHref`, NEVER `website`. The raw column is user content and
              `normaliseWebsite()` only guards the form -- an import, a merge or
              a direct PostgREST call with the anon key writes this column
              without meeting it. An earlier draft of this page put the raw
              value straight into href with a comment asserting the socials
              check covered it, which was false: socials is a different column.
              safeHref() decides in lib/crm/queries.ts; this only renders the
              decision.

              noreferrer as well as noopener: an outbound link from a CRM
              should not carry the internal URL of the record it came from. */}
          {contact.websiteHref ? (
            <a
              href={contact.websiteHref}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {contact.website}
            </a>
          ) : contact.website ? (
            <span translate="no" className="break-all">
              {contact.website}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Tags">
          {contact.tags.length > 0 ? (
            <span className="flex flex-wrap gap-2">
              {contact.tags.map((tag) => (
                <span
                  key={tag}
                  className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
                >
                  {tag}
                </span>
              ))}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Social">
          {contact.socials.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {contact.socials.map((entry) => (
                <li key={entry.key} className="break-all">
                  <span className="text-ink-muted">{entry.label}: </span>
                  {entry.href ? (
                    <a
                      href={entry.href}
                      rel="noopener noreferrer nofollow"
                      target="_blank"
                      className="text-primary underline underline-offset-4 hover:text-ink"
                    >
                      {entry.value}
                    </a>
                  ) : (
                    // NOT A LINK, and this is the render-side half of the
                    // protocol rule. A handle is not a URL, and a stored
                    // `javascript:` -- from an import, a merge, or a direct
                    // PostgREST call that never met the form -- reaches here
                    // as inert text rather than an anchor. safeHref() has
                    // already decided; this branch only renders the decision.
                    <span translate="no">{entry.value}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Added">
          <time dateTime={contact.createdAt} className="tabular-nums">
            {formatDateTime(contact.createdAt)}
          </time>
        </Detail>
        <Detail label="Last updated">
          <time dateTime={contact.updatedAt} className="tabular-nums">
            {formatDateTime(contact.updatedAt)}
          </time>
        </Detail>
      </dl>

      <ContactCompanyPanel
        orgSlug={org.slug}
        side="contact"
        anchorId={contact.id}
        linked={links.map((link) => ({
          id: link.otherId,
          name: link.otherName,
          isPrimary: link.isPrimary,
          isDeleted: link.otherDeleted,
          href: `/${org.slug}/companies/${link.otherId}`,
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
          entityType="contact"
          entityId={contact.id}
          live={customFields.panel.live}
          removed={customFields.panel.removed}
          disabledReason={customFieldsBlocked}
        />
      )}

      {/* THE SHARED ACTIVITY TIMELINE (Task 7). One component, five pages,
          and every later phase's sources arrive as branches of
          public.activity_events rather than as a second component --
          lib/crm/activity.ts's header is the contract. */}
      {/* THE RELATED PANEL (Phase 4 Task 3): the tasks, notes and documents
          linked to this contact. Its three lists carry `rel_tasks_`/`rel_notes_`/
          `rel_docs_` and the timeline carries `activity_`, so four lib/list/
          surfaces now share this route -- every one is passed `preserve={raw}`
          so paging any one leaves the others where they were (rule 10). */}
      <RelatedPanel
        orgSlug={org.slug}
        organisationId={org.id}
        entityType="contact"
        entityId={contact.id}
        basePath={`${basePath}/${contact.id}`}
        raw={raw}
      />

      <ActivityTimeline
        orgSlug={org.slug}
        subjectType="contact"
        page={activity}
        params={activityListParams}
        basePath={`${basePath}/${contact.id}`}
        recordScoped={activityIsScoped(org.role)}
        preserve={raw}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {/* ONE EXPLANATION FOR THE WHOLE GROUP, above the controls it explains
            and referenced by each of them through aria-describedby. Repeating
            it per control puts the same sentence between a screen-reader user
            and every button. */}
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {contact.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${contact.id}/edit`}
                label="Edit contact"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteContactAction}
              hiddenFields={{ orgSlug: org.slug, contactId: contact.id }}
              label="Delete contact"
              question={`Delete ${contact.name}? It comes out of the contacts list and out of search. You can restore it from Contacts › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreContactAction}
            hiddenFields={{ orgSlug: org.slug, contactId: contact.id }}
            label="Restore contact"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "contact-manage-blocked";

/** See the contacts list's copy of this: a blank cell is indistinguishable
 *  from a rendering fault, and silent to a screen reader. */
