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
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { ContactCompanyPanel } from "@/components/crm/link-panel";

// One contact.
//
// ===========================================================================
// WHERE TASK 7'S TIMELINE GOES, AND WHY THERE IS A GAP RATHER THAN A STUB
// ===========================================================================
// The activity timeline (notes, tasks, meetings, email activity) is Task 7 and
// belongs at the bottom of this page, below the join panel, as a full-width
// section. The layout is already the two-column-on-wide/stacked-on-narrow
// shape it needs, and nothing here has to move for it to land.
//
// There is deliberately NO placeholder heading. "Activity — coming soon" is a
// dead affordance of the same class the Foundation review caught three times,
// and an empty <section> is a thing someone later has to work out the purpose
// of. A comment costs nothing and says more.
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
}: PageProps<"/[orgSlug]/contacts/[contactId]">) {
  const { orgSlug, contactId } = await params;

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
  const links = await loadCompaniesForContact(org.id, contact.id);
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
  // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
  // the panel is a Client Component and this is the only place with an
  // RLS-scoped server client. `includeRemoved` is implied: the loader
  // returns the values of REMOVED fields too, which is what makes
  // "removing a field keeps what was filled in" visible rather than merely
  // true (20260829010000, decision 1).
  const customFields = await loadCustomFieldPanel(org.id, "contact", contact.id);
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

      {/* Task 7's activity timeline goes here. See the file header. */}

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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
        {label}
      </dt>
      <dd className="text-base break-words text-ink">{children}</dd>
    </div>
  );
}

/** See the contacts list's copy of this: a blank cell is indistinguishable
 *  from a rendering fault, and silent to a screen reader. */
function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
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
