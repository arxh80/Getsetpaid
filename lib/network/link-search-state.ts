// Task 4 / Gap B (Q73): the link picker's search state -- its type and its
// starting value -- split out from lib/network/link-search.ts because that
// file is "use server", and a "use server" module may export ONLY async
// functions (found the hard way, in a browser: Next.js refuses the whole
// route at runtime with "A 'use server' file can only export async
// functions, found object", a rule `tsc`/eslint have no opinion on). This is
// the same reason lib/network/discovery.ts is deliberately NOT "use server"
// -- stated there for plain reads; this file is the identical argument for a
// plain VALUE.
//
// NOT REACT, NOT "use client" EITHER: importable from the server action
// (link-search.ts), the client component (link-picker.tsx) and a future unit
// test alike.

import type { NetworkDirectoryRow } from "@/lib/network/discovery-list";

export interface LinkPickerSearchState {
  /** The term actually searched, so the component can tell "never searched"
   *  (empty, no results shown at all) from "searched and found nothing". */
  readonly query: string;
  readonly results: readonly NetworkDirectoryRow[];
  readonly error?: string;
}

/** The picker's own starting point: no query, no results, no candidates shown
 *  -- Q73's "the search box starts empty and the user types". */
export const EMPTY_LINK_PICKER_SEARCH_STATE: LinkPickerSearchState = {
  query: "",
  results: [],
};
