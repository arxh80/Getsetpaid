// The command palette's searchable-entity catalogue.
//
// ===========================================================================
// EVERY ENTRY REUSES AN EXISTING LIST SPEC — THAT IS THE WHOLE DESIGN
// ===========================================================================
// The palette's record search goes through `fetchListPage` with the SAME spec,
// select and table each entity's own list page uses: the same allowlisted
// search column, the same soft-delete clause, the same tenant clause, the same
// page-size ceiling, the same RLS underneath. This file adds NO new query
// path, no new column, and no new endpoint — it is a page-size-5 read of
// eight list surfaces that already exist and are already tested. If an entity
// is not listed here it is because it has no list spec to reuse or no detail
// page to land on, never because a bespoke query felt easier.
//
// NOT LISTED, AND WHY:
//   - notes: its search column is the note BODY, and note visibility is the
//     one per-row read rule in the product (`private` vs `company`); RLS
//     enforces it identically here, but surfacing body fragments in a global
//     palette is a product decision the founder has not made. Sections still
//     jump to /notes.
//   - documents: no detail page to land on (downloads are a route handler
//     gated on scan status), so a hit has nowhere to go but the list the
//     palette's section jump already reaches.
//   - network profiles/directory: discovery has its own deliberate surface
//     and rate-limit posture (SECURITY.md § 5, deferred Q86/Q87); the palette
//     does not open a second cross-tenant search path beside it.
//
// The widened `ListSpec<string, string>` type is safe: the palette only reads
// `defaultSort`, the default filter choices and the search column — all
// literals from the spec — and `fetchListPage` receives the spec and params
// as one consistent pair.

import type { ListSpec } from "@/lib/list/spec";
import { AGENCY_LIST, AGENCY_SELECT } from "@/lib/crm/agencies-list";
import { ARTIST_LIST, ARTIST_SELECT } from "@/lib/crm/artists-list";
import { COMPANY_LIST, COMPANY_SELECT } from "@/lib/crm/companies-list";
import { CONTACT_LIST, CONTACT_SELECT } from "@/lib/crm/contacts-list";
import { EVENT_LIST, EVENT_SELECT } from "@/lib/crm/events-list";
import { MEETING_LIST, MEETING_SELECT, TASK_LIST, TASK_SELECT } from "@/lib/crm/tasks-list";
import { VENUE_LIST, VENUE_SELECT } from "@/lib/crm/venues-list";

/**
 * Results per entity group. Five keeps the whole palette scannable (eight
 * groups × five rows is already a tall list) and keeps each of the eight
 * parallel reads a page-one keyset query — far below MAX_PAGE_SIZE, and each
 * group links to the full, paginated list page for anything past it.
 */
export const PALETTE_RESULTS_PER_ENTITY = 5;

export interface PaletteEntityDef {
  /** Stable key, also the URL path segment under /[orgSlug]/. */
  readonly key: string;
  /** Group heading in the palette. */
  readonly label: string;
  /** PostgREST relation, a literal — same value the list page passes. */
  readonly table: string;
  /** The entity's list spec, reused verbatim. */
  readonly spec: ListSpec<string, string>;
  /** The entity's select list, reused verbatim. */
  readonly select: string;
  /** Column carrying the row's display label (name/title). */
  readonly labelColumn: string;
}

export const PALETTE_ENTITIES: readonly PaletteEntityDef[] = [
  { key: "contacts", label: "Contacts", table: "contacts", spec: CONTACT_LIST, select: CONTACT_SELECT, labelColumn: "name" },
  { key: "companies", label: "Companies", table: "companies", spec: COMPANY_LIST, select: COMPANY_SELECT, labelColumn: "name" },
  { key: "artists", label: "Artists", table: "artists", spec: ARTIST_LIST, select: ARTIST_SELECT, labelColumn: "name" },
  { key: "venues", label: "Venues", table: "venues", spec: VENUE_LIST, select: VENUE_SELECT, labelColumn: "name" },
  { key: "agencies", label: "Agencies", table: "agencies", spec: AGENCY_LIST, select: AGENCY_SELECT, labelColumn: "name" },
  { key: "events", label: "Events", table: "events", spec: EVENT_LIST, select: EVENT_SELECT, labelColumn: "name" },
  { key: "tasks", label: "Tasks", table: "tasks", spec: TASK_LIST, select: TASK_SELECT, labelColumn: "title" },
  { key: "meetings", label: "Meetings", table: "meetings", spec: MEETING_LIST, select: MEETING_SELECT, labelColumn: "title" },
];
