"use server";

// Task 4 / Gap B (Q73): the link picker's search action, and NOTHING ELSE.
//
// A SEPARATE "use server" MODULE from lib/network/links.ts on purpose --
// that file is the WRITE surface (createNetworkLinkAction,
// removeNetworkLinkAction), reviewed and tested as exactly that; this is a
// READ, and folding it in there would mix a search into a module whose own
// header is about what a link changes and does not change. It is also
// separate from lib/network/discovery.ts, which is NOT "use server" (every
// export of a "use server" module becomes a server action, which would make
// that file's plain reads unreachable from a unit test and from a Server
// Component that just wants the data, not an action).
//
// ===========================================================================
// THE Q73 REFUSAL, STATED HERE BECAUSE THIS IS WHERE IT WOULD BE TEMPTING TO
// ADD IT BACK
// ===========================================================================
// No pre-fill from the private record that opened the picker: this action
// receives ONLY the text the user typed in `q`, never an entity name or id.
// No ranking by similarity and no "suggested match" section: the query goes
// straight to `loadNetworkDirectory`, whose default sort is `display_name`
// ascending -- alphabetical, not relevance-scored -- and this file adds no
// second pass over the results to reorder or annotate them by how closely
// they resemble anything. tests/unit/network/link-picker-source-shape.test.ts
// is the source-shape guard: it parses this file (and link-picker.tsx) for a
// `similarity(` call or a prop that reads like a pre-filled default, with a
// planted positive control that proves the parse would catch one.

import { loadNetworkDirectory } from "@/lib/network/discovery";
import {
  EMPTY_LINK_PICKER_SEARCH_STATE,
  type LinkPickerSearchState,
} from "@/lib/network/link-search-state";

// NOTE ON THE SPLIT: `EMPTY_LINK_PICKER_SEARCH_STATE` (the picker's starting
// value) and `LinkPickerSearchState` used to live in THIS file, next to the
// action that returns them -- exactly this file's own header argues
// discovery.ts is NOT "use server" for. FOUND IN A BROWSER WALK (Constraint
// 17), not by `tsc` or eslint: a `"use server"` module may export ONLY async
// functions, so `link-picker.tsx` importing that constant from here broke the
// whole route with "A 'use server' file can only export async functions,
// found object" -- a Next.js build-time rule with no compile-time signal
// anywhere in this codebase's own toolchain. `lib/network/link-search-
// state.ts` is now the non-"use server" home for BOTH; this file only
// IMPORTS them (for its own internal use) and exports neither.

/**
 * Search the network directory for the link picker.
 *
 * Reuses `loadNetworkDirectory` (Task 3) rather than a second query builder:
 * the same page-size ceiling, the same ILIKE-over-display_name search and the
 * same masking view apply here as on the full directory page, so a picker
 * result is never a field the directory page itself would refuse to show.
 * Only `.rows` is used -- the picker is a short candidate list, not a second
 * paginated surface, so `hasNext`/cursors are deliberately discarded rather
 * than threaded through a component this task does not ask for a pager on.
 */
export async function searchNetworkDirectoryForLinkAction(
  _prev: LinkPickerSearchState,
  formData: FormData,
): Promise<LinkPickerSearchState> {
  const raw = formData.get("q");
  const query = typeof raw === "string" ? raw.trim() : "";
  if (query === "") return EMPTY_LINK_PICKER_SEARCH_STATE;

  const page = await loadNetworkDirectory({ net_q: query });
  if (page.outcome !== "loaded") {
    return {
      query,
      results: [],
      error:
        "We couldn’t search the network just now. Try again in a moment.",
    };
  }
  return { query, results: page.rows };
}
