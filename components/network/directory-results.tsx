import Link from "next/link";
import { isNarrowed, parseListParams, type RawSearchParams } from "@/lib/list/params";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ProfileCard } from "@/components/network/profile-card";
import { loadNetworkDirectory } from "@/lib/network/discovery";
import {
  NETWORK_DIRECTORY_LIST,
  type NetworkDirectoryRow,
  type NetworkDirectorySortKey,
} from "@/lib/network/discovery-list";
import { NETWORK_ENTITY_KIND_LABELS } from "@/lib/network/fields";

// The directory's results: the Suspense boundary's own async component, so
// `app/(app)/[orgSlug]/network/page.tsx` streams the toolbar immediately and
// this fetches the page underneath it -- the same split Task 2's own-profiles
// page uses for `NetworkProfileResults`.
//
// TWO COLUMNS, NOT ELEVEN. `NETWORK_DIRECTORY_SELECT` carries eleven columns
// because the VIEW projects exactly what is safe to show (its own header); this
// component decides how to LAY them out, and a column per field would be a
// mostly-empty table -- most profiles publish two or three of the seven. Name
// (sortable, with the kind as a caption) is its own column because it is the
// one thing every row always has and the one a caller searches by;
// `ProfileCard` carries everything else as a compact block, wrapped in one
// `<td>`.
export async function DirectoryResults({
  orgSlug,
  raw,
  basePath,
}: {
  orgSlug: string;
  raw: RawSearchParams;
  basePath: string;
}) {
  const listParams = parseListParams(NETWORK_DIRECTORY_LIST, raw);
  const narrowed = isNarrowed(NETWORK_DIRECTORY_LIST, listParams);
  const page = await loadNetworkDirectory(raw);

  return (
    <EntityList
      spec={NETWORK_DIRECTORY_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={directoryColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-lg font-bold text-ink">
            Nobody has published to the network yet
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            When a company, artist, venue or agency is published from another
            GetSetPaid workspace, it appears here. Your own published
            identities live under{" "}
            <Link
              href={`/${orgSlug}/network/profiles`}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              Your network profiles
            </Link>
            .
          </p>
        </div>
      }
    />
  );
}

function directoryColumns(
  orgSlug: string,
): readonly ListColumn<NetworkDirectoryRow, NetworkDirectorySortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      render: (row) => (
        <div className="flex flex-col gap-1">
          <Link
            href={`/${orgSlug}/network/${row.id}`}
            className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {row.displayName}
          </Link>
          <span className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
            {NETWORK_ENTITY_KIND_LABELS[row.entityKind]}
          </span>
        </div>
      ),
    },
    {
      key: "details",
      header: "Details",
      render: (row) => <ProfileCard row={row} compact />,
    },
  ];
}
