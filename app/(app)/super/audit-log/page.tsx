import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  fetchAuditLogPage,
  parseAuditLogParams,
  recordAuditLogView,
  type AuditLogParams,
} from "@/lib/admin/audit-log";
import type { RawSearchParams } from "@/lib/list/params";
import { AuditLogFilterForm } from "@/components/admin/audit-log-filter-form";
import { AuditLogTable } from "@/components/admin/audit-log-table";
import { ListSkeleton } from "@/components/list/list-skeleton";

// Phase 7 Task 1's one shipped surface: the audit log viewer.
//
// Searchable/filterable by organisation, actor, action and date range
// (lib/admin/audit-log.ts), keyset-paginated, reading
// public.audit_events through the EXISTING platform-superuser SELECT policy
// (20260826154304) -- no new read surface. Every superuser VIEW of this page
// is itself audited (public.audit_superuser_audit_log_view(), 20260908010000),
// which is why AuditLogResults calls that RPC before it queries anything.
export const metadata: Metadata = {
  title: "Audit log · Superuser · GetSetPaid",
};

const BASE_PATH = "/super/audit-log";

export default async function AuditLogPage({
  searchParams,
}: PageProps<"/super/audit-log">) {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for
  // why the gate lives here rather than in the layout. This is the ONE
  // check standing between any authenticated caller and this page's
  // content; it runs below this route's own loading.tsx boundary, so a
  // refusal streams HTTP 200 + the identical app/(app)/not-found.tsx
  // document, the same refusal parity a tenant record's own 404 gets
  // (DESIGN.md § Error pages).
  if (!(await isSuperuser())) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const params = parseAuditLogParams(raw);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Audit log
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Every high-value action recorded across every organisation,
          append-only. Viewing this page is itself audited.
        </p>
      </div>

      <AuditLogFilterForm filters={params.filters} basePath={BASE_PATH} />

      {/* Keyed on the filters and the cursor together, same reasoning as
          app/(app)/[orgSlug]/contacts/page.tsx's own Suspense key: this
          page has no controls INSIDE the boundary whose focus needs to
          survive a remount (no sort links, and the "Next" link's href
          always points past the boundary to a fresh navigation anyway), so
          there is no cost to keying on everything that changes the result
          set, including the cursor. */}
      <Suspense
        key={JSON.stringify([params.filters, params.list.cursor])}
        fallback={<ListSkeleton columns={7} />}
      >
        <AuditLogResults params={params} raw={raw} />
      </Suspense>
    </div>
  );
}

async function AuditLogResults({
  params,
  raw,
}: {
  params: AuditLogParams;
  raw: RawSearchParams;
}) {
  // SELF-AUDIT FIRST. CLAUDE.md § Non-negotiable rules: "Superuser access
  // audits itself." A failed self-audit write refuses the whole page rather
  // than serving results with no matching audit record -- see
  // lib/admin/audit-log.ts's recordAuditLogView header for why that is the
  // fail-closed direction here.
  const audited = await recordAuditLogView(params.filters);
  if (!audited.ok) {
    return (
      <p
        role="status"
        className="border border-danger bg-surface px-3 py-3 text-base text-ink"
      >
        <span className="font-semibold text-danger">Error.</span> We
        couldn’t record this view, so we’re not showing results. Refresh the
        page to try again.
      </p>
    );
  }

  const page = await fetchAuditLogPage(params);

  return (
    <AuditLogTable page={page} params={params} raw={raw} basePath={BASE_PATH} />
  );
}
