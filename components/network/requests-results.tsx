import Link from "next/link";
import { isNarrowed, parseListParams, type RawSearchParams } from "@/lib/list/params";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ConnectionStatusChip } from "@/components/network/connection-status-chip";
import {
  AcceptRequestForm,
  DeclineRequestForm,
  WithdrawRequestForm,
} from "@/components/network/request-actions";
import { formatDateTime } from "@/lib/format/date";
import { NETWORK_ENTITY_KIND_LABELS } from "@/lib/network/fields";
import {
  NETWORK_REQUESTS_RECEIVED_LIST,
  NETWORK_REQUESTS_SENT_LIST,
  loadReceivedConnectionRequests,
  loadSentConnectionRequests,
  type ConnectionRequestRow,
  type NetworkRequestSortKey,
} from "@/lib/network/requests-list";

// Task 4: the Suspense boundary's own async component for each of the two
// lists on app/(app)/[orgSlug]/network/requests/page.tsx -- the same split
// Task 3's DirectoryResults uses, doubled because Constraint 10 makes this a
// two-list page. `raw` is the WHOLE page's searchParams in both, since each
// spec's own `paramPrefix` (`req_in_` / `req_out_`) is what keeps the two
// from reading each other's `after`/`before`.
//
// THE COUNTERPARTY COLUMN RENDERS A PROFILE, NEVER A TENANT. `row.counterparty`
// is resolved through `loadNetworkProfileSummaries` (the two masking views),
// never a name or id belonging to the counterparty ORGANISATION -- CLAUDE.md:
// "The requester renders to the recipient as its published network profile —
// never a tenant name or user name." `row.fromOrganisationId` /
// `toOrganisationId` are never read by either component below.
export async function ReceivedRequestsResults({
  orgSlug,
  organisationId,
  raw,
  basePath,
}: {
  orgSlug: string;
  organisationId: string;
  raw: RawSearchParams;
  basePath: string;
}) {
  const listParams = parseListParams(NETWORK_REQUESTS_RECEIVED_LIST, raw);
  const narrowed = isNarrowed(NETWORK_REQUESTS_RECEIVED_LIST, listParams);
  const page = await loadReceivedConnectionRequests({ id: organisationId }, raw);

  return (
    <EntityList
      spec={NETWORK_REQUESTS_RECEIVED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={counterpartyColumns(orgSlug, "received")}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      preserve={raw}
      emptyState={
        <p className="max-w-prose text-base text-ink-muted">
          Nobody has sent your workspace a connection request yet. When
          somebody does, it shows up here — there is no other notification
          (CLAUDE.md: no notification subsystem exists at MVP).
        </p>
      }
    />
  );
}

export async function SentRequestsResults({
  orgSlug,
  organisationId,
  raw,
  basePath,
}: {
  orgSlug: string;
  organisationId: string;
  raw: RawSearchParams;
  basePath: string;
}) {
  const listParams = parseListParams(NETWORK_REQUESTS_SENT_LIST, raw);
  const narrowed = isNarrowed(NETWORK_REQUESTS_SENT_LIST, listParams);
  const page = await loadSentConnectionRequests({ id: organisationId }, raw);

  return (
    <EntityList
      spec={NETWORK_REQUESTS_SENT_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={counterpartyColumns(orgSlug, "sent")}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      preserve={raw}
      emptyState={
        <p className="max-w-prose text-base text-ink-muted">
          You haven’t sent a connection request yet. Send one from a
          published profile’s page in the network directory.
        </p>
      }
    />
  );
}

function counterpartyColumns(
  orgSlug: string,
  direction: "received" | "sent",
): readonly ListColumn<ConnectionRequestRow, NetworkRequestSortKey>[] {
  return [
    {
      key: "counterparty",
      header: direction === "received" ? "From" : "To",
      render: (row) =>
        row.counterparty === null ? (
          <span className="text-ink-muted">No longer available</span>
        ) : (
          <div className="flex flex-col gap-1">
            <Link
              href={`/${orgSlug}/network/${row.counterpartyProfileId}`}
              className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
            >
              {row.counterparty.row.displayName}
            </Link>
            <span className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
              {NETWORK_ENTITY_KIND_LABELS[row.counterparty.row.entityKind]}
            </span>
          </div>
        ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <ConnectionStatusChip status={row.status} />,
    },
    {
      key: "requested",
      header: "Requested",
      sortKey: "requested",
      numeric: true,
      render: (row) => (
        <time dateTime={row.requestedAt} className="tabular-nums">
          {formatDateTime(row.requestedAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          {direction === "received" && row.status === "pending" ? (
            <>
              {/* `subject` disambiguates the accessible name per row (a table
                  of pending requests otherwise announces N identical "Accept"
                  buttons). The display name is already rendered visibly in
                  this row's counterparty cell, so it discloses nothing new. */}
              <AcceptRequestForm
                orgSlug={orgSlug}
                requestId={row.id}
                subject={row.counterparty?.row.displayName}
              />
              <DeclineRequestForm
                orgSlug={orgSlug}
                requestId={row.id}
                subject={row.counterparty?.row.displayName}
              />
            </>
          ) : null}
          {direction === "sent" && row.status === "pending" ? (
            <WithdrawRequestForm
              orgSlug={orgSlug}
              requestId={row.id}
              subject={row.counterparty?.row.displayName}
            />
          ) : null}
        </div>
      ),
    },
  ];
}
