import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess } from "@/lib/crm/finance-access";
import { RECEIVED_LIST, RECEIVED_SELECT, mapReceivedRow, type ReceivedFilterKey, type ReceivedRow, type ReceivedSortKey } from "@/lib/invoices/received";
import { isNarrowed, parseListParams, type ListParams, type RawSearchParams } from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { InvoiceStatusChip } from "@/components/invoices/invoice-status-chip";
import { Absent } from "@/components/ui/absent";
import { formatGbp } from "@/lib/format/money";
import { formatDateOnly, formatDateTime } from "@/lib/format/date";

// The received invoices inbox (Invoices part 3). view_finance in THIS
// workspace, any tier; anyone else gets the not-found a missing page gets.
// Read-only: nothing here writes, and nothing is added to the workspace's own
// finance.
export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices/received">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Received invoices · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function ReceivedInvoicesPage({ params, searchParams }: PageProps<"/[orgSlug]/invoices/received">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(RECEIVED_LIST, raw);
  const basePath = `/${org.slug}/invoices/received`;
  const narrowed = isNarrowed(RECEIVED_LIST, listParams);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}/invoices`} className="break-words text-primary underline underline-offset-4 hover:text-ink">Invoices</Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Received invoices</h1>
      </div>
      <ListToolbar spec={RECEIVED_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />
      <Suspense key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])} fallback={<ListSkeleton columns={7} />}>
        <ReceivedResults organisationId={org.id} orgSlug={org.slug} listParams={listParams} basePath={basePath} narrowed={narrowed} />
      </Suspense>
    </div>
  );
}

async function ReceivedResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<ReceivedSortKey, ReceivedFilterKey>;
  basePath: string;
  narrowed: boolean;
}) {
  const page = await fetchListPage<ReceivedRow, ReceivedSortKey, ReceivedFilterKey>({
    spec: RECEIVED_LIST,
    params: listParams,
    organisationId,
    table: "received_invoices",
    select: RECEIVED_SELECT,
    mapRow: mapReceivedRow,
    applyFilters: (query: ListQuery, filters) => (filters.status !== "any" ? query.eq("status", filters.status) : query),
  });
  return (
    <EntityList
      spec={RECEIVED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={receivedColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">No invoices received yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            When a workspace you are connected to on the network sends you an invoice through GetSetPaid, it appears here. You can read it, download the PDF and pay it. Nothing is added to your own finance.
          </p>
        </div>
      }
    />
  );
}

function receivedColumns(orgSlug: string): readonly ListColumn<ReceivedRow, ReceivedSortKey>[] {
  return [
    { key: "sender", header: "Sender", render: (row) => row.senderName ?? <Absent label="No name" /> },
    {
      key: "number",
      header: "Invoice",
      render: (row) => (
        <Link href={`/${orgSlug}/invoices/received/${row.id}`} className="font-semibold text-primary underline underline-offset-4 hover:text-ink tabular-nums">
          {row.number}
        </Link>
      ),
    },
    { key: "issued", header: "Issued", numeric: true, render: (row) => <span className="tabular-nums">{formatDateOnly(row.issueDate)}</span> },
    { key: "due", header: "Due", numeric: true, render: (row) => <span className="tabular-nums">{formatDateOnly(row.dueDate)}</span> },
    { key: "total", header: "Total", numeric: true, render: (row) => <span className="tabular-nums">{formatGbp(row.grossMinor)}</span> },
    { key: "status", header: "Status", render: (row) => <InvoiceStatusChip status={row.status} /> },
    {
      key: "received",
      header: "Received",
      sortKey: "delivered",
      numeric: true,
      secondary: true,
      render: (row) => <time dateTime={row.deliveredAt} className="text-ink-muted tabular-nums">{formatDateTime(row.deliveredAt)}</time>,
    },
  ];
}
