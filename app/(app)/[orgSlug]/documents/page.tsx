import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  loadDocumentLinks,
  loadUploaderNames,
  type DocumentLinkTarget,
} from "@/lib/crm/queries";
import { ScanStatusChip } from "@/components/crm/scan-status-chip";
import {
  DocumentDownloadLink,
  DocumentDeleteControl,
} from "@/components/crm/document-row";
import { DocumentUpload } from "@/components/crm/document-upload";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import {
  DOCUMENT_LIST,
  DOCUMENT_SELECT,
  mapDocumentRow,
  type DocumentFilterKey,
  type DocumentRow,
  type DocumentSortKey,
} from "@/lib/crm/documents-list";
import type { LinkEntityType } from "@/lib/crm/links";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { humanFileSize } from "@/lib/format/bytes";
import { formatDateTime } from "@/lib/format/date";

// Documents. `manage_documents` (20260902010000). The org-wide file list: every
// document in the workspace, its scan status, who uploaded it, what it is
// attached to, and a download link that resolves ONLY for a `clean` file (the
// download Route Handler refuses the rest anyway — rule 12).
//
// Upload happens here (the whole-workspace file drop) and from any entity's
// related panel (which also attaches the file). "Uploaded by" and "Linked to"
// are two bounded decorating reads over this page's rows (loadUploaderNames /
// loadDocumentLinks), the same shape as the events list's venue names.

const WRITE_NOTE_ID = "documents-write-note";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/documents">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Documents · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DocumentsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/documents">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(DOCUMENT_LIST, raw);
  const basePath = `/${org.slug}/documents`;
  const narrowed = isNarrowed(DOCUMENT_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_documents");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {org.name}
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Documents
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Files kept with this workspace — contracts, riders, artwork. Each is
          scanned before it can be opened, and can be attached to the contacts,
          events and everyone else it is about.
        </p>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted documents
          </Link>
        </p>
      </div>

      {/* UPLOAD, gated. A writer gets the control; anyone else gets the
          explanation, never a silent absence (write-gate.tsx's rule). The
          server refuses a forbidden upload regardless (rule 12). */}
      {access.canWrite ? (
        <DocumentUpload orgSlug={org.slug} />
      ) : (
        <WriteBlockedNote access={access} id={WRITE_NOTE_ID} />
      )}

      <ListToolbar
        spec={DOCUMENT_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={6} />}
      >
        <DocumentResults
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
          access={access}
        />
      </Suspense>
    </div>
  );
}

async function DocumentResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
  access,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<DocumentSortKey, DocumentFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<DocumentRow, DocumentSortKey, DocumentFilterKey>({
    spec: DOCUMENT_LIST,
    params: listParams,
    organisationId,
    table: "documents",
    select: DOCUMENT_SELECT,
    mapRow: mapDocumentRow,
    applyFilters: (query: ListQuery, filters) => {
      let q = query;
      // Each value has already been narrowed to one of the spec's own declared
      // choices by parseListParams, so `filters.scan` cannot carry arbitrary
      // text — the events page's note applies here too.
      if (filters.scan !== "any") q = q.eq("scan_status", filters.scan);
      if (filters.owner === "mine" && user) q = q.eq("owner_user_id", user.id);
      return q;
    },
  });

  // Two bounded decorating reads over THIS page's rows only.
  const [uploaderNames, documentLinks] =
    page.outcome === "loaded"
      ? await Promise.all([
          loadUploaderNames(page.rows.map((row) => row.ownerUserId)),
          loadDocumentLinks(
            organisationId,
            page.rows.map((row) => row.id),
          ),
        ])
      : [
          new Map<string, string>(),
          new Map<string, DocumentLinkTarget[]>(),
        ];

  return (
    <>
      <EntityList
        spec={DOCUMENT_LIST}
        params={listParams}
        basePath={basePath}
        page={page}
        columns={documentColumns(
          orgSlug,
          uploaderNames,
          documentLinks,
          access,
        )}
        rowKey={(row) => row.id}
        narrowed={narrowed}
        scopeNote={
          recordScoped ? (
            <p className="text-sm text-ink-muted">
              You’re seeing documents you uploaded. Others in this workspace may
              see more.
            </p>
          ) : undefined
        }
        emptyState={
          <div className="border border-rule bg-surface p-5">
            <h2 className="text-xl font-bold text-ink">
              {recordScoped ? "No documents you uploaded" : "No documents yet"}
            </h2>
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              {recordScoped
                ? "Files you upload appear here. Ask a colleague to share theirs, or upload one above."
                : "Upload a contract, rider or artwork above. Every file is scanned before it can be opened, and can be attached to the records it is about."}
            </p>
          </div>
        }
      />
      {/* One explanation for every disabled Delete on the page (write-gate's
          rule: not one sentence repeated per row). Present only when the caller
          cannot write and there is a list to act on. */}
      {!access.canWrite && page.outcome === "loaded" && page.rows.length > 0 ? (
        <WriteBlockedNote access={access} id={WRITE_NOTE_ID} />
      ) : null}
    </>
  );
}

function documentColumns(
  orgSlug: string,
  uploaderNames: ReadonlyMap<string, string>,
  documentLinks: ReadonlyMap<string, DocumentLinkTarget[]>,
  access: CrmWriteAccess,
): readonly ListColumn<DocumentRow, DocumentSortKey>[] {
  return [
    {
      key: "filename",
      header: "File",
      render: (row) => (
        <DocumentDownloadLink
          orgSlug={orgSlug}
          documentId={row.id}
          filename={row.filename}
          scanStatus={row.scanStatus}
        />
      ),
    },
    {
      key: "linked",
      header: "Linked to",
      render: (row) => (
        <LinkedTo orgSlug={orgSlug} targets={documentLinks.get(row.id) ?? []} />
      ),
    },
    {
      key: "uploader",
      header: "Uploaded by",
      secondary: true,
      render: (row) => {
        const name = row.ownerUserId
          ? uploaderNames.get(row.ownerUserId)
          : undefined;
        return name ? (
          <span className="break-words text-ink-muted">{name}</span>
        ) : (
          <Absent label="Uploader not recorded" />
        );
      },
    },
    {
      key: "size",
      header: "Size",
      numeric: true,
      secondary: true,
      // DESIGN.md § Numerals: tabular figures on every file size. Non-negotiable.
      render: (row) => (
        <span className="tabular-nums text-ink-muted">
          {humanFileSize(row.sizeBytes)}
        </span>
      ),
    },
    {
      key: "scan",
      header: "Scan",
      render: (row) => <ScanStatusChip status={row.scanStatus} />,
    },
    {
      key: "created",
      header: "Uploaded",
      sortKey: "created",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.createdAt} className="text-ink-muted">
          {formatDateTime(row.createdAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) => (
        <DocumentDeleteControl
          orgSlug={orgSlug}
          documentId={row.id}
          filename={row.filename}
          blocked={!access.canWrite}
          describedBy={WRITE_NOTE_ID}
        />
      ),
    },
  ];
}

/** The "Linked to" cell: the CRM records this document is attached to. */
function LinkedTo({
  orgSlug,
  targets,
}: {
  orgSlug: string;
  targets: readonly DocumentLinkTarget[];
}) {
  if (targets.length === 0) return <Absent label="Not attached to anything" />;

  const SEGMENT: Record<LinkEntityType, string> = {
    company: "companies",
    contact: "contacts",
    agency: "agencies",
    artist: "artists",
    venue: "venues",
    event: "events",
  };
  const SHOWN = 3;
  const head = targets.slice(0, SHOWN);
  const rest = targets.length - head.length;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {head.map((t, i) => {
        const key = `${t.entityType}:${t.entityId}:${i}`;
        if (t.name === null) {
          return (
            <span key={key} className="text-ink-muted">
              A record outside your access
            </span>
          );
        }
        if (t.isDeleted) {
          return (
            <span key={key} className="break-words text-ink-muted">
              {t.name} <span className="text-ink-muted">(deleted)</span>
            </span>
          );
        }
        return (
          <Link
            key={key}
            href={`/${orgSlug}/${SEGMENT[t.entityType]}/${t.entityId}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {t.name}
          </Link>
        );
      })}
      {rest > 0 ? (
        <span className="text-ink-muted">+{rest} more</span>
      ) : null}
    </span>
  );
}

/** A blank cell is indistinguishable from a rendering fault, and silent to a
 *  screen reader. */
function Absent({ label }: { label: string }) {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
