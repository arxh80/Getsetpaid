import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import {
  columnLabel,
  displayValue,
  entityHref,
  entityNoun,
  loadMergePair,
  mergeBlockedExplanation,
  MERGEABLE_COLUMNS,
  reasonLabel,
} from "@/lib/crm/dedup";
import { MergeForm, type MergeFieldRow } from "@/components/crm/merge-form";

// One flagged pair, side by side.
//
// The read is `loadMergePair()`, which runs entirely as the caller: the
// candidate row is gated by a policy requiring BOTH records to be visible, and
// the two records are then read through RLS anyway rather than trusted. A
// candidate the caller cannot see, a pair with a record in another workspace,
// and a candidate that does not exist all come back null and all render the
// same 404 -- DESIGN.md § Error pages, the tenant-isolation rule.
//
// A PAIR WHERE ONE SIDE IS ALREADY DELETED IS ALSO A 404, and that is a
// decision rather than a fallthrough: merge_records() refuses such a merge (a
// history entry describing something that did not happen is worse than no
// entry), so a screen offering it would be a form that cannot succeed. The
// queue's own row disappears at the same moment, because the merge that
// deleted the record resolved the candidate with it.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/duplicates/[candidateId]">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Review a possible duplicate · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function ReviewDuplicatePage({
  params,
}: PageProps<"/[orgSlug]/duplicates/[candidateId]">) {
  const { orgSlug, candidateId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const pair = await loadMergePair(org.id, candidateId);
  if (!pair) notFound();

  const access = await getCrmWriteAccess(org, "merge_records");
  const { candidate, keep, duplicate, definitions } = pair;
  const entityType = candidate?.entityType ?? "contact";

  // ONE ROW PER MERGEABLE FIELD, plus one per live custom field definition.
  // The order comes from MERGEABLE_COLUMNS, which is this application's own
  // (name first) rather than the catalogue's -- and it is bound to
  // private.dedup_mergeable_columns() by an integration test, so a column the
  // database will merge and this screen does not offer is a red test rather
  // than a field nobody was asked about.
  const rows: MergeFieldRow[] = [
    ...MERGEABLE_COLUMNS[entityType].map((column) => ({
      key: column,
      label: columnLabel(column),
      keepValue: displayValue(keep.values[column]),
      duplicateValue: displayValue(duplicate.values[column]),
      custom: false,
    })),
    ...definitions.map((definition) => ({
      key: definition.id,
      label: definition.label,
      keepValue: displayValue(keep.custom[definition.id]),
      duplicateValue: displayValue(duplicate.custom[definition.id]),
      custom: true,
    })),
  ];

  const noun = entityNoun(entityType);

  // ===========================================================================
  // TWO RECORDS WITH THE SAME NAME IS THE CASE THIS SCREEN IS FOR
  // ===========================================================================
  // Found in a browser, on an exact-name duplicate -- which is the commonest
  // thing the queue holds, because an exact name match never auto-merges and
  // always lands here. Every field row said "from Ines Duarte" twice, and the
  // summary sentence read "Ines Duarte will be deleted and merged into Ines
  // Duarte." The screen was asking the user to choose between two sides it gave
  // no way to tell apart.
  //
  // The disambiguator is the ONLY thing that reliably differs: when they were
  // added. Applied only when the names collide, because "Ines Duarte (added 20
  // Aug 2026)" on every row is noise in the common case where the names already
  // distinguish them.
  const sameName = keep.name === duplicate.name;
  const sideName = (record: typeof keep): string =>
    sameName ? `${record.name} (added ${formatDate(record.createdAt)})` : record.name;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/duplicates`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Possible duplicates
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {keep.name}
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Two {noun} records that look like the same one.
          {candidate ? ` Flagged because: ${reasonLabel(candidate.reason).toLowerCase()}.` : ""}
        </p>
      </div>

      {/* ONE explanation for the whole page rather than one per control --
          five disabled buttons each repeating "this workspace is suspended" is
          noise on screen and a wall between a screen-reader user and the
          records. The form below is rendered inert by the same flag. */}
      {/* NOT WriteBlockedNote. Its sentence comes from getCrmWriteAccess(),
          which for reason "permission" says "your role can view records but not
          change them" -- true of manage_contacts and false of merge_records,
          which a Standard User lacks while changing records all day. See
          mergeBlockedExplanation(). */}
      {access.canWrite ? null : (
        <p
          id="merge-blocked"
          className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted"
        >
          <span className="font-semibold text-ink">Read-only.</span>{" "}
          {mergeBlockedExplanation(access)}
        </p>
      )}

      {access.canWrite ? (
        <MergeForm
          orgSlug={org.slug}
          entityType={entityType}
          keep={{
            id: keep.id,
            name: sideName(keep),
            createdAt: keep.createdAt,
            href: entityHref(org.slug, entityType, keep.id),
          }}
          duplicate={{
            id: duplicate.id,
            name: sideName(duplicate),
            createdAt: duplicate.createdAt,
            href: entityHref(org.slug, entityType, duplicate.id),
          }}
          rows={rows}
          candidateId={candidate?.id ?? null}
          cancelHref={`/${org.slug}/duplicates`}
        />
      ) : (
        // READ-ONLY COMPARISON, not a hidden page. Everyone who can reach this
        // route holds view_crm and can already read both records; what they
        // cannot do is merge them. Rendering the comparison and no controls is
        // the honest version of that, and it is the same information the merge
        // form shows -- with the values side by side, which is the useful part
        // even when the decision belongs to somebody else.
        <ReadOnlyComparison
          keepName={sideName(keep)}
          duplicateName={sideName(duplicate)}
          rows={rows}
        />
      )}
    </div>
  );
}

function ReadOnlyComparison({
  keepName,
  duplicateName,
  rows,
}: {
  keepName: string;
  duplicateName: string;
  rows: readonly MergeFieldRow[];
}) {
  const differing = rows.filter((row) => row.keepValue !== row.duplicateValue);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold text-ink">
        {differing.length === 0
          ? "These records agree on every field"
          : `Where they differ (${differing.length})`}
      </h2>
      {/* Scrolls inside its own container: a two-column comparison of
          user-supplied values is exactly the content that would otherwise push
          the page sideways, and html/body carry overflow-x: clip so the
          overflow would be silently cut rather than scrollable. */}
      <div className="overflow-x-auto border border-rule bg-surface">
        <table className="w-full min-w-[36rem] border-collapse text-base">
          <caption className="sr-only">
            Field-by-field comparison of {keepName} and {duplicateName}
          </caption>
          <thead>
            <tr className="border-b border-rule text-left">
              <th scope="col" className="px-4 py-3 text-sm font-semibold text-ink">
                Field
              </th>
              <th scope="col" className="px-4 py-3 text-sm font-semibold break-words text-ink">
                {keepName}
              </th>
              <th scope="col" className="px-4 py-3 text-sm font-semibold break-words text-ink">
                {duplicateName}
              </th>
            </tr>
          </thead>
          <tbody>
            {(differing.length === 0 ? rows : differing).map((row) => (
              <tr key={row.key} className="border-b border-rule align-top">
                <th
                  scope="row"
                  className="px-4 py-3 text-left text-sm font-semibold text-ink"
                >
                  {row.label}
                </th>
                <td className="px-4 py-3 break-words text-ink-muted">
                  {row.keepValue ?? <Absent />}
                </td>
                <td className="px-4 py-3 break-words text-ink-muted">
                  {row.duplicateValue ?? <Absent />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * An empty cell, said out loud.
 *
 * A blank cell in a dense table is indistinguishable from a rendering fault,
 * and a screen reader passes over it in silence.
 */
function Absent() {
  return (
    <span>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
