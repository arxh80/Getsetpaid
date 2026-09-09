import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import { ScanStatusChip } from "@/components/crm/scan-status-chip";
import { DocumentRestoreControl } from "@/components/crm/document-row";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import type { ScanStatus } from "@/lib/crm/task-status";
import {
  DOCUMENT_DELETED_LIST,
  DOCUMENT_DELETED_SELECT,
  type DeletedDocumentRow,
  type DocumentDeletedFilterKey,
  type DocumentDeletedSortKey,
} from "@/lib/crm/documents-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { humanFileSize } from "@/lib/format/bytes";
import { formatDateTime } from "@/lib/format/date";

// The restore queue for documents. Unlike every other entity, a document has no
// detail page, so restore is an INLINE control on this list rather than a
// button on a record page. Soft-delete keeps the bytes (Task 5), so a restored
// document comes back whole — its file was never removed from the bucket.

const WRITE_NOTE_ID = "documents-deleted-write-note";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/documents/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted documents · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedDocumentsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/documents/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(DOCUMENT_DELETED_LIST, raw);
  const basePath = `/${org.slug}/documents/deleted`;
  const narrowed = isNarrowed(DOCUMENT_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_documents");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/documents`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Documents
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted documents
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed — the file itself is kept. Restore one
          to put it back in the documents list. Until then it can’t be opened.
        </p>
      </div>

      <ListToolbar
        spec={DOCUMENT_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={5} />}
      >
        <Results
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

async function Results({
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
  listParams: ListParams<DocumentDeletedSortKey, DocumentDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const page = await fetchListPage<
    DeletedDocumentRow,
    DocumentDeletedSortKey,
    DocumentDeletedFilterKey
  >({
    spec: DOCUMENT_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "documents",
    select: DOCUMENT_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      filename: String(row.filename),
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status as ScanStatus,
      ownerUserId: (row.owner_user_id as string | null) ?? null,
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <>
      <EntityList
        spec={DOCUMENT_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        page={page}
        columns={columnsFor(orgSlug, access)}
        rowKey={(row) => row.id}
        narrowed={narrowed}
        scopeNote={
          recordScoped ? (
            <p className="text-sm text-ink-muted">
              You’re seeing deleted documents you uploaded. Others in this
              workspace may see more.
            </p>
          ) : undefined
        }
        emptyState={
          <div className="border border-rule bg-surface p-5">
            <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              Deleted documents stay here so they can be restored. The file
              itself is kept until then.
            </p>
          </div>
        }
      />
      {!access.canWrite && page.outcome === "loaded" && page.rows.length > 0 ? (
        <WriteBlockedNote access={access} id={WRITE_NOTE_ID} />
      ) : null}
    </>
  );
}

function columnsFor(
  orgSlug: string,
  access: CrmWriteAccess,
): readonly ListColumn<DeletedDocumentRow, DocumentDeletedSortKey>[] {
  return [
    {
      key: "filename",
      header: "File",
      // NOT a download link: a deleted document cannot be opened (its list
      // query is scope: "deleted", and it is out of the live surface). The
      // name identifies it for restore; nothing here resolves a signed URL.
      render: (row) => <span className="break-words font-semibold text-ink">{row.filename}</span>,
    },
    {
      key: "scan",
      header: "Scan",
      secondary: true,
      // The status it held when it was deleted — worth showing so a restore of a
      // quarantined file is not a surprise.
      render: (row) => <ScanStatusChip status={row.scanStatus} />,
    },
    {
      key: "size",
      header: "Size",
      numeric: true,
      secondary: true,
      render: (row) => (
        <span className="tabular-nums text-ink-muted">
          {humanFileSize(row.sizeBytes)}
        </span>
      ),
    },
    {
      key: "deleted",
      header: "Deleted",
      sortKey: "deleted",
      numeric: true,
      render: (row) => (
        <time dateTime={row.deletedAt} className="text-ink-muted">
          {formatDateTime(row.deletedAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) => (
        <DocumentRestoreControl
          orgSlug={orgSlug}
          documentId={row.id}
          blocked={!access.canWrite}
          describedBy={WRITE_NOTE_ID}
        />
      ),
    },
  ];
}
