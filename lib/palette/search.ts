"use server";

// The command palette's record search — a READ-only server action.
//
// ===========================================================================
// NO NEW QUERY PATH (the brief's hard constraint, and this file's contract)
// ===========================================================================
// Every group below is `fetchListPage` (lib/list/query.ts) over an entity's
// OWN list spec/select/table — see lib/palette/entities.ts for the catalogue
// and the exclusions. That means the palette inherits, rather than restates:
// the allowlisted search column, the tenant clause, the soft-delete clause,
// the server-side page-size ceiling, and RLS under all of it. There is no
// unbounded endpoint here and no client-side dump of records: at most
// PALETTE_RESULTS_PER_ENTITY rows per entity leave the server per search,
// each one a row the caller's own list pages would render.
//
// AUTHORISATION is the same two-layer shape as every org-scoped page:
// `getCurrentOrg(orgSlug)` resolves the workspace through the RLS-gated
// membership lookup (null covers not-found, not-yours and not-active-member
// identically — the tenant-isolation rule), and RLS bounds every row that
// comes back regardless. A separate `use server` module from any write
// surface, same as lib/network/link-search.ts and for its reasons.
//
// SEPARATE FROM THE LIST PAGES' OWN READS in one deliberate way: a failure
// here degrades to "couldn't search" inside the palette; it never 404s or
// throws, because the palette overlays a page that is itself fine.

import { getCurrentOrg } from "@/lib/auth";
import { formatDateTime } from "@/lib/format/date";
import {
  MAX_SEARCH_LENGTH,
  parseListParams,
  toolbarParamNames,
  type ListParams,
} from "@/lib/list/params";
import { fetchListPage } from "@/lib/list/query";
import type { ListSpec } from "@/lib/list/spec";
import {
  PALETTE_ENTITIES,
  PALETTE_RESULTS_PER_ENTITY,
  type PaletteEntityDef,
} from "@/lib/palette/entities";
import {
  PALETTE_MIN_QUERY_LENGTH,
  type PaletteRecordGroup,
  type PaletteRecordHit,
  type PaletteSearchResult,
} from "@/lib/palette/results";

/**
 * ListParams for one palette read, THROUGH `parseListParams` rather than
 * hand-rolled — tests/unit/list/one-cursor-only.test.ts's census requires
 * every `fetchListPage` caller to pair with the shared parser, and the first
 * cut of this function was exactly the hand-rolled params object that census
 * exists to catch. Feeding the query and page size in as raw, spec-namespaced
 * params means the palette's inputs go through the same trimming, capping and
 * validation the list pages' query strings do, and everything else (default
 * sort and direction, filters-nothing filter choices, NO CURSOR — the palette
 * never pages) is the parser's own default.
 */
function paletteParams(
  spec: ListSpec<string, string>,
  q: string,
): ListParams<string, string> {
  const names = toolbarParamNames(spec);
  return parseListParams(spec, {
    [names.q]: q,
    [names.size]: String(PALETTE_RESULTS_PER_ENTITY),
  });
}

function hitDetail(def: PaletteEntityDef, raw: Record<string, unknown>): string | null {
  // Only fields the entity's own list page already renders, and only ones
  // that help tell same-named rows apart.
  if (def.key === "contacts" && typeof raw.email === "string" && raw.email !== "") {
    return raw.email;
  }
  if ((def.key === "events" || def.key === "meetings") && typeof raw.starts_at === "string") {
    return formatDateTime(raw.starts_at);
  }
  return null;
}

export async function searchPaletteAction(
  orgSlug: unknown,
  rawQuery: unknown,
): Promise<PaletteSearchResult> {
  // Server actions are a public endpoint; both arguments are untrusted.
  if (typeof orgSlug !== "string" || typeof rawQuery !== "string") {
    return { outcome: "unavailable" };
  }
  const q = rawQuery.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q.length < PALETTE_MIN_QUERY_LENGTH) {
    return { outcome: "results", groups: [] };
  }

  // Null covers three cases and must not distinguish them — the same
  // RLS-gated resolution every org-scoped page starts with.
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { outcome: "unavailable" };

  const pages = await Promise.all(
    PALETTE_ENTITIES.map((def) =>
      fetchListPage<PaletteRecordHit, string, string>({
        spec: def.spec,
        params: paletteParams(def.spec, q),
        organisationId: org.id,
        table: def.table,
        select: def.select,
        mapRow: (raw) => ({
          id: String(raw.id),
          label: String(raw[def.labelColumn] ?? ""),
          detail: hitDetail(def, raw),
          href: `/${org.slug}/${def.key}/${String(raw.id)}`,
        }),
      }),
    ),
  );

  // ONE keystroke's search is ONE metered unit, however many entities it fans
  // out to: consumeRateLimit() is cache()-wrapped, so the first fetchListPage
  // consumed the caller's 'search' budget and every sibling read the same
  // verdict. A refusal therefore refuses ALL groups at once, and the palette
  // owes the honest sentence rather than the "try again in a moment" the
  // unavailable state renders (SECURITY.md § 5).
  const limited = pages.find((page) => page.outcome === "rate_limited");
  if (limited && limited.outcome === "rate_limited") {
    return {
      outcome: "rate_limited",
      retryAfterSeconds: limited.retryAfterSeconds,
    };
  }

  const groups: PaletteRecordGroup[] = [];
  let anyLoaded = false;
  for (const [i, page] of pages.entries()) {
    if (page.outcome !== "loaded") continue;
    anyLoaded = true;
    if (page.rows.length === 0) continue;
    const def = PALETTE_ENTITIES[i]!;
    const qParam = toolbarParamNames(def.spec).q;
    groups.push({
      key: def.key,
      label: def.label,
      hits: page.rows,
      total: page.total,
      moreHref: `/${org.slug}/${def.key}?${qParam}=${encodeURIComponent(q)}`,
    });
  }

  // Every read failing at once is a stack problem worth saying out loud;
  // one entity failing quietly degrades to that group being absent, the
  // same per-group independence the list pages' own count query has.
  if (!anyLoaded) return { outcome: "unavailable" };
  return { outcome: "results", groups };
}
