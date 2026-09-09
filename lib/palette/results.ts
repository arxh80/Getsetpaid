// The palette search's result shapes and client-shared constants.
//
// A separate module from lib/palette/search.ts for the reason
// lib/network/link-search-state.ts records from its own browser-found
// failure: a "use server" module may export ONLY async functions, so the
// non-function values a client component needs (a constant, and for
// consistency the types beside it) live here. Also separate from
// lib/palette/entities.ts on purpose — that file imports every entity's
// list spec, which the CLIENT bundle has no business carrying; this one
// imports nothing.

/** Minimum query length before the palette searches records at all. One
 *  character matches most of a tenant and answers nothing. */
export const PALETTE_MIN_QUERY_LENGTH = 2;

/**
 * The window CustomEvent the header trigger dispatches to open the palette.
 *
 * AN EVENT, NOT AN IMPORT, AND THE INDIRECTION IS LOAD-BEARING: the trigger
 * lives in the app shell's header (app/(app)/layout.tsx), and the shell's
 * module graph must reach no CRM query — tests/unit/list/
 * app-shell-has-no-crm-query.test.ts guards the MFA-enrolment lockout that a
 * CRM read in the shell would cause. The palette (whose search action DOES
 * reach the CRM list specs) therefore mounts below the MFA gate in
 * app/(app)/[orgSlug]/layout.tsx, and the trigger knows only this string.
 */
export const PALETTE_OPEN_EVENT = "getsetpaid:open-command-palette";

export interface PaletteRecordHit {
  readonly id: string;
  readonly label: string;
  /** One secondary line (an email, a date) — never a field the entity's own
   *  list page would not show. */
  readonly detail: string | null;
  readonly href: string;
}

export interface PaletteRecordGroup {
  readonly key: string;
  readonly label: string;
  readonly hits: readonly PaletteRecordHit[];
  /** Total matches beyond the palette's window, or null when uncounted. */
  readonly total: number | null;
  /** The entity's own list page, pre-filtered to this query — the "see all"
   *  escape into real pagination. */
  readonly moreHref: string;
}

export type PaletteSearchResult =
  | { readonly outcome: "results"; readonly groups: readonly PaletteRecordGroup[] }
  | { readonly outcome: "unavailable" };
