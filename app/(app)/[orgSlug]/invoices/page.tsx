import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getFinanceReadAccess, getFinanceWriteAccess } from "@/lib/crm/finance-access";
import { INVOICE_LIST, INVOICE_SELECT, mapInvoiceRow, type InvoiceFilterKey, type InvoiceRow, type InvoiceSortKey } from "@/lib/invoices/list";
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

// The invoices list (Invoices part 1). view_finance holders only; anyone else
// gets the not-found a missing page gets. "New invoice" is offered only to a
// caller who can write finance; otherwise the reason is shown in its place.
export async function generateMetadata({ params }: PageProps<"/[orgSlug]/invoices">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return { title: org ? `Invoices · ${org.name} · GetSetPaid` : "Not found · GetSetPaid" };
}

export default async function InvoicesPage({ params, searchParams }: PageProps<"/[orgSlug]/invoices">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();
  if (!(await getFinanceReadAccess(org))) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(INVOICE_LIST, raw);
  const basePath = `/${org.slug}/invoices`;
  const narrowed = isNarrowed(INVOICE_LIST, listParams);
  const access = await getFinanceWriteAccess(org);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}`} className="break-words text-primary underline underline-offset-4 hover:text-ink">{org.name}</Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">Invoices</h1>
          {access.canWrite ? (
            <Link href={`${basePath}/new`} className="inline-flex h-11 items-center justify-center gap-2 border px-4 text-base font-semibold whitespace-nowrap transition-colors duration-[var(--dur-fast)] ease-brand disabled:cursor-not-allowed disabled:opacity-55 border-primary bg-primary text-on-primary hover:border-ink hover:bg-ink active:border-ink active:bg-ink">
              New invoice
            </Link>
          ) : (
            <p className="max-w-sm text-sm text-ink-muted">{access.explanation}</p>
          )}
        </div>
      </div>
      <ListToolbar spec={INVOICE_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />
      <Suspense key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])} fallback={<ListSkeleton columns={6} />}>
        <InvoiceResults organisationId={org.id} orgSlug={org.slug} listParams={listParams} basePath={basePath} narrowed={narrowed} />
      </Suspense>
    </div>
  );
}

async function InvoiceResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<InvoiceSortKey, InvoiceFilterKey>;
  basePath: string;
  narrowed: boolean;
}) {
  const page = await fetchListPage<InvoiceRow, InvoiceSortKey, InvoiceFilterKey>({
    spec: INVOICE_LIST,
    params: listParams,
    organisationId,
    table: "invoices",
    select: INVOICE_SELECT,
    mapRow: mapInvoiceRow,
    applyFilters: (query: ListQuery, filters) => (filters.status !== "any" ? query.eq("status", filters.status) : query),
  });
  return (
    <EntityList
      spec={INVOICE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={invoiceColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">No invoices yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            An invoice bills a company or contact for a show. Start one here, or from an event’s finance lines.
          </p>
        </div>
      }
    />
  );
}

function invoiceColumns(orgSlug: string): readonly ListColumn<InvoiceRow, InvoiceSortKey>[] {
  return [
    {
      key: "number",
      header: "Invoice",
      render: (row) => (
        <Link href={`/${orgSlug}/invoices/${row.id}`} className="font-semibold text-primary underline underline-offset-4 hover:text-ink tabular-nums">
          {row.number ?? "Draft"}
        </Link>
      ),
    },
    { key: "status", header: "Status", render: (row) => <InvoiceStatusChip status={row.status} /> },
    { key: "recipient", header: "To", render: (row) => row.recipientName ?? <Absent label="No recipient yet" /> },
    { key: "total", header: "Total", numeric: true, render: (row) => <span className="tabular-nums">{formatGbp(row.grossMinor)}</span> },
    {
      key: "due",
      header: "Due",
      numeric: true,
      render: (row) => (row.dueDate ? <span className="tabular-nums">{formatDateOnly(row.dueDate)}</span> : <Absent label="Not issued" />),
    },
    {
      key: "created",
      header: "Created",
      sortKey: "created",
      numeric: true,
      secondary: true,
      render: (row) => <time dateTime={row.createdAt} className="text-ink-muted">{formatDateTime(row.createdAt)}</time>,
    },
  ];
}
