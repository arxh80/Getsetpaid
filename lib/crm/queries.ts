import "server-only";

// Single-record reads for the contact and company detail/edit screens.
//
// ===========================================================================
// A MISSING ROW AND A REFUSED ROW ARE THE SAME ANSWER, AND A FAILED QUERY IS
// NOT EITHER
// ===========================================================================
// `null` here means "there is no such record for you", covering: no such id,
// another tenant's id, a record outside a record-scoped user's scope, and an
// id from the caller's OTHER workspace reached through this one's URL. Every
// one of those renders the same 404 -- DESIGN.md § Error pages, the same
// enumeration-oracle argument getCurrentOrg() makes for slugs.
//
// A query that FAILED is a third thing and is not null: `{ outcome:
// "unavailable" }`, the same three-way shape lib/list/query.ts uses, because
// "this record does not exist" is a claim about the customer's data and
// rendering it when the database was merely unreachable reads as deletion.
// Foundation shipped exactly that on the members page and it is still in
// FOLLOW-UPS.md.
//
// ===========================================================================
// `deleted_at` IS SELECTED AND NOT FILTERED
// ===========================================================================
// The detail route serves live records AND deleted ones -- that is how restore
// is reached, and how the delete confirmation can leave the user on the record
// they just deleted with an undo in front of them. So the caller decides what
// to render, and the row carries the fact. Every WRITE path filters
// `deleted_at` itself (lib/crm/contacts.ts), which is where it matters.

import { createClient } from "@/lib/supabase/server";
import { parseSocials, safeHref, type SocialEntry } from "@/lib/crm/urls";
import type { EventStatus, EventType } from "@/lib/crm/event-status";
// THE PICKER'S ASSEMBLY IS PURE AND LIVES ELSEWHERE, so a node test can drive
// it. See lib/crm/event-picker.ts's header: fix round 1's Important 1 was a
// defect in thirty lines this module could not expose to any test.
import { assemblePicker, type PickerVenue } from "@/lib/crm/event-picker";
// PHASE 3 TASK 5. The lineup panel is the first CHILD panel in this file that
// is a real lib/list/ surface rather than a `LINK_PANEL_LIMIT` cap -- see
// lib/crm/lineup-list.ts's header for the argument, and `loadLineupForEvent`
// at the bottom of this file for the three queries it takes.
import {
  LINEUP_LIST,
  LINEUP_SELECT,
  lineupParams,
  mapLineupRow,
  type LineupFilterKey,
  type LineupParams,
  type LineupRow,
  type LineupSortKey,
} from "@/lib/crm/lineup-list";
import type { RawSearchParams } from "@/lib/list/params";
import { fetchListPage, type ListPage, type ListQuery } from "@/lib/list/query";

// Re-exported so the shape the picker returns is nameable from the module that
// loads it, as every other reader in this file names its own.
export type { PickerRoom, PickerVenue, PickerAvailability } from "@/lib/crm/event-picker";

export type RecordResult<T> =
  | { readonly outcome: "found"; readonly record: T }
  | { readonly outcome: "missing" }
  | { readonly outcome: "unavailable" };

export interface ContactDetail {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  location: string | null;
  website: string | null;
  /**
   * The href to render for `website`, or null to render it as inert text.
   *
   * SEPARATE FROM `website` BECAUSE THE RAW VALUE IS NOT SAFE TO PUT IN AN
   * href, and the first version of the detail page did exactly that with a
   * comment claiming the socials check covered it. It does not: `website` is
   * its own column, `normaliseWebsite()` guards the FORM, and a row written by
   * an import, a merge, or a direct PostgREST call with the anon key never
   * meets the form. Computed here, once, so no page can reintroduce it by
   * reaching for `website` when it means `websiteHref`.
   */
  websiteHref: string | null;
  tags: string[];
  socials: SocialEntry[];
  /** The raw object, for pre-filling the edit form. */
  socialsRaw: Record<string, string>;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONTACT_DETAIL_SELECT =
  "id, name, email, phone, title, location, website, socials, tags, deleted_at, created_at, updated_at";

export async function loadContact(
  organisationId: string,
  contactId: string,
): Promise<RecordResult<ContactDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_DETAIL_SELECT)
    // Explicit tenant filter, for the reason lib/list/query.ts gives: RLS lets
    // a multi-org member read BOTH workspaces' rows, so only the query can say
    // which workspace this URL is about.
    .eq("organisation_id", organisationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    // An unparseable uuid is a client error, not a server one: PostgREST
    // answers 22P02 for `id=eq.not-a-uuid`, and that is a 404 rather than
    // "we could not load this" -- there is no such record and there never
    // could be.
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] contact lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  const socialsRaw: Record<string, string> = {};
  const raw = data.socials;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") socialsRaw[key] = value;
    }
  }

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      email: (data.email as string | null) ?? null,
      phone: (data.phone as string | null) ?? null,
      title: (data.title as string | null) ?? null,
      location: (data.location as string | null) ?? null,
      website: (data.website as string | null) ?? null,
      websiteHref: safeHref(data.website as string | null),
      tags: (data.tags as string[] | null) ?? [],
      // Protocol validation on the way OUT, which is the half that is the
      // control -- see lib/crm/urls.ts. Every consumer of this record gets
      // entries whose `href` is already null for anything unsafe, so no page
      // can render a stored `javascript:` into an anchor by forgetting.
      socials: parseSocials(data.socials),
      socialsRaw,
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

export interface CompanyDetail {
  id: string;
  name: string;
  type: string[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function loadCompany(
  organisationId: string,
  companyId: string,
): Promise<RecordResult<CompanyDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, type, deleted_at, created_at, updated_at")
    .eq("organisation_id", organisationId)
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] company lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      type: (data.type as string[] | null) ?? [],
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

// ---------------------------------------------------------------------------
// The join, read from either side
// ---------------------------------------------------------------------------

export interface LinkRow {
  /** The OTHER end's id -- a company id on a contact page, and vice versa. */
  otherId: string;
  otherName: string;
  isPrimary: boolean;
  otherDeleted: boolean;
}

/**
 * Bound on every list this file returns.
 *
 * CLAUDE.md § Non-negotiable rules: "Paginate everything. No unbounded list
 * endpoint." A detail panel is a list endpoint -- it just does not look like
 * one -- and a contact with 900 linked companies would render 900 rows and
 * 1,800 buttons. 100 is well past any real record and small enough that the
 * page cannot become the problem.
 *
 * THE HONEST LIMIT, recorded rather than papered over: when a workspace
 * exceeds this, the panel shows the first 100 by name and says so. A real
 * answer is a search-backed picker with its own keyset page, which needs a
 * measured design; it is named in the Task 4 report and in FOLLOW-UPS.md
 * rather than guessed at here.
 */
export const LINK_PANEL_LIMIT = 100;

export async function loadCompaniesForContact(
  organisationId: string,
  contactId: string,
): Promise<LinkRow[]> {
  const supabase = await createClient();
  // ONE QUERY WITH AN EMBED, not two. PostgREST resolves `companies(...)`
  // through the foreign key, and the embedded rows are subject to companies'
  // OWN policies -- so a record-scoped user who can see the link but not the
  // company gets a null embed rather than another tenant's name. That is why
  // the null branch below is a real case and not defensive padding.
  const { data, error } = await supabase
    .from("contact_companies")
    .select("company_id, is_primary, companies ( id, name, deleted_at )")
    .eq("organisation_id", organisationId)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it Postgres
    // returns rows in whatever order it likes, so above LINK_PANEL_LIMIT the
    // hundred that come back are a different hundred on every render. The
    // rendered order was never at risk -- `toLinkRows` sorts the rows again in
    // memory -- so what this fixes is WHICH rows survive the cap, not the
    // sequence they appear in. `is_primary` leads it so the primary link is
    // the one row that can never be truncated away; `id` closes the tie so
    // two rows created in the same transaction do not swap places.
    .eq("contact_id", contactId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[crm] contact_companies lookup failed:", error.message);
    }
    return [];
  }
  return toLinkRows(data, "company_id");
}

export async function loadContactsForCompany(
  organisationId: string,
  companyId: string,
): Promise<LinkRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contact_companies")
    .select("contact_id, is_primary, contacts ( id, name, deleted_at )")
    .eq("organisation_id", organisationId)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it Postgres
    // returns rows in whatever order it likes, so above LINK_PANEL_LIMIT the
    // hundred that come back are a different hundred on every render. The
    // rendered order was never at risk -- `toLinkRows` sorts the rows again in
    // memory -- so what this fixes is WHICH rows survive the cap, not the
    // sequence they appear in. `is_primary` leads it so the primary link is
    // the one row that can never be truncated away; `id` closes the tie so
    // two rows created in the same transaction do not swap places.
    .eq("company_id", companyId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[crm] contact_companies lookup failed:", error.message);
    }
    return [];
  }
  return toLinkRows(data, "contact_id");
}

function toLinkRows(
  rows: Record<string, unknown>[],
  idKey: "company_id" | "contact_id",
): LinkRow[] {
  const embedKey = idKey === "company_id" ? "companies" : "contacts";
  const out: LinkRow[] = [];
  for (const row of rows) {
    const other = row[embedKey] as
      | { id: string; name: string; deleted_at: string | null }
      | null;
    // The embed is null when the caller may see the link but not the record it
    // points at. Dropping the row is right: rendering "(unavailable)" would
    // confirm that a record exists and is out of reach, which is the same
    // oracle the 404 rule exists to close.
    if (!other) continue;
    out.push({
      otherId: String(row[idKey]),
      otherName: String(other.name),
      isPrimary: row.is_primary === true,
      otherDeleted: other.deleted_at !== null,
    });
  }
  return out.sort((a, b) => {
    // Primary first, then by name. Not by insertion order: the primary is the
    // answer to "who do they work for", and it should not move down the list
    // as links are added.
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.otherName.localeCompare(b.otherName, "en-GB", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * Candidates for the "link a…" picker: live records in this workspace that are
 * not already linked.
 *
 * Bounded and ordered by name, for the reason on LINK_PANEL_LIMIT. `exclude`
 * is applied in memory rather than as a `not.in` filter because the exclusion
 * list is already in hand and a `not.in` with 100 uuids is a 4KB query string.
 *
 * ===========================================================================
 * THIS IS WHERE THE Q3a / Q5 WRITE HALF IS CLOSED, AND ONLY HERE
 * ===========================================================================
 * FOLLOW-UPS.md, corrected in Task 4's fix round 1: the SELECT policies on
 * `contact_companies` and `artist_representations` hand a record-scoped user
 * the identifiers of records outside their scope, and the accepted disposition
 * is that no ATTRIBUTES leak. The write half is a form question, not a policy
 * question -- "offer only companies the caller can read, NOT in a policy, a
 * policy that refused it would reintroduce the AND that Q5 rejected".
 *
 * The query runs through the CALLER'S OWN client, so what comes back is
 * exactly what their SELECT policy allows: a Standard User is offered the
 * agencies and contacts they own, and nothing else. It is a courtesy, not a
 * control -- a forged form post naming an agency they cannot see is still
 * accepted by the database, by design.
 *
 * `agencies` and `artists` were added by Task 4b for the representation
 * pickers. Widening this union is the ONLY change Task 4b made to a file
 * Task 4 shipped, and it is additive: no existing caller's behaviour changes.
 */
export async function loadLinkOptions(
  table: "companies" | "contacts" | "agencies" | "artists",
  organisationId: string,
  exclude: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .select("id, name")
    .eq("organisation_id", organisationId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(LINK_PANEL_LIMIT + exclude.length);

  if (error || !data) {
    if (error) console.error(`[crm] ${table} option lookup failed:`, error.message);
    return [];
  }
  const skip = new Set(exclude);
  return data
    .filter((row) => !skip.has(String(row.id)))
    .slice(0, LINK_PANEL_LIMIT)
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
}

// ===========================================================================
// TASK 4b: artists, agencies, venues, and their children
// ===========================================================================
// The same three-way `RecordResult` shape, the same "deleted_at is selected
// and not filtered" rule, and the same `websiteHref` discipline as the two
// loaders above. What is new is below the entity loaders: two child readers
// whose ordering carries a product rule the database cannot express.

interface SocialColumns {
  socials: SocialEntry[];
  /** The raw object, for pre-filling the edit form. */
  socialsRaw: Record<string, string>;
}

/**
 * The `socials` column, split into what a page renders and what a form
 * pre-fills.
 *
 * Lifted out of `loadContact` unchanged rather than copied a third and fourth
 * time. `parseSocials` computes each entry's `href` through `safeHref()` here,
 * once, so no page can render one of these values into an `href` by reaching
 * for the raw string -- which is the render-side half of the protocol rule and
 * the half lib/crm/urls.ts calls the control.
 *
 * `socialsRaw` keeps only string values, deliberately and for a different
 * reason from `parseSocials`: it feeds `defaultValue` on a text input, and a
 * number or a nested object there would render as `[object Object]` and be
 * saved back as that string. `mergeSocials()` is what protects the non-string
 * values in the column itself.
 */
function readSocials(raw: unknown): SocialColumns {
  const socialsRaw: Record<string, string> = {};
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") socialsRaw[key] = value;
    }
  }
  return { socials: parseSocials(raw), socialsRaw };
}

export interface ArtistDetail {
  id: string;
  name: string;
  genres: string[];
  country: string | null;
  city: string | null;
  website: string | null;
  /**
   * The href to render for `website`, or null to render it as inert text.
   *
   * SEPARATE FROM `website` BECAUSE THE RAW VALUE IS NOT SAFE IN AN href, and
   * Task 4's contact page shipped exactly that mistake behind a comment
   * claiming otherwise. `normaliseWebsite()` guards the FORM; a row written by
   * an import, a merge, or a direct PostgREST call with the anon key never
   * meets the form. Computed here, once, so no page can reintroduce it by
   * reaching for `website` when it means `websiteHref`.
   */
  websiteHref: string | null;
  socials: SocialEntry[];
  socialsRaw: Record<string, string>;
  /** PRD 6.3's free-text notes. Untrusted; rendered as text, never as HTML. */
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function loadArtist(
  organisationId: string,
  artistId: string,
): Promise<RecordResult<ArtistDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("artists")
    .select(
      "id, name, genres, country, city, website, socials, notes, deleted_at, created_at, updated_at",
    )
    // Explicit tenant filter, for the reason lib/list/query.ts gives: RLS lets
    // a multi-org member read BOTH workspaces' rows, so only the query can say
    // which workspace this URL is about.
    .eq("organisation_id", organisationId)
    .eq("id", artistId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] artist lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      genres: (data.genres as string[] | null) ?? [],
      country: (data.country as string | null) ?? null,
      city: (data.city as string | null) ?? null,
      website: (data.website as string | null) ?? null,
      websiteHref: safeHref(data.website as string | null),
      ...readSocials(data.socials),
      notes: (data.notes as string | null) ?? null,
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

export interface AgencyDetail {
  id: string;
  name: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function loadAgency(
  organisationId: string,
  agencyId: string,
): Promise<RecordResult<AgencyDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agencies")
    .select("id, name, deleted_at, created_at, updated_at")
    .eq("organisation_id", organisationId)
    .eq("id", agencyId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] agency lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

export interface VenueDetail {
  id: string;
  name: string;
  address: string | null;
  location: string | null;
  capacity: number | null;
  website: string | null;
  websiteHref: string | null;
  socials: SocialEntry[];
  socialsRaw: Record<string, string>;
  /**
   * PA, rigging, load-in, power. Unstructured by design (PRD 6.4 asks for
   * "technical information" and specifies no schema) and therefore UNTRUSTED
   * free text: rendered as text, never as HTML, and never through
   * `dangerouslySetInnerHTML` (CLAUDE.md § Non-negotiable rules).
   */
  technicalInfo: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function loadVenue(
  organisationId: string,
  venueId: string,
): Promise<RecordResult<VenueDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venues")
    .select(
      "id, name, address, location, capacity, website, socials, technical_info, deleted_at, created_at, updated_at",
    )
    .eq("organisation_id", organisationId)
    .eq("id", venueId)
    .maybeSingle();

  if (error) {
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] venue lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      address: (data.address as string | null) ?? null,
      location: (data.location as string | null) ?? null,
      // NOT `?? 0`. The column is nullable because an unknown capacity is a
      // real state (20260827232510) and zero is a lie that renders as a real
      // number.
      capacity: (data.capacity as number | null) ?? null,
      website: (data.website as string | null) ?? null,
      websiteHref: safeHref(data.website as string | null),
      ...readSocials(data.socials),
      technicalInfo: (data.technical_info as string | null) ?? null,
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

// ---------------------------------------------------------------------------
// artist_representations, read from either side
// ---------------------------------------------------------------------------

/**
 * One end of a representation: the artist, the agency, or the named contact.
 *
 * `name` IS NULLABLE AND THAT IS THE Q3a CASE, not a defensive default. The
 * SELECT policy on artist_representations is scoped by the ARTIST alone, so a
 * record-scoped user who owns the artist reads the whole representation row --
 * including `agency_id` and `contact_id` of records outside their scope. The
 * embedded rows are subject to `agencies`' and `contacts`' OWN policies, so
 * those come back null.
 *
 * FOLLOW-UPS.md's corrected note is the disposition: this is an accepted
 * IDENTIFIER disclosure, bounded by the fact that no ATTRIBUTES leak. The row
 * is rendered rather than dropped -- dropping it would hide a representation
 * from the person whose artist it is, which is the legitimate case Q3a exists
 * to protect -- and the missing name is shown as such rather than as a blank
 * cell, because a blank cell next to a filled-in role and territory reads as a
 * rendering fault.
 */
export interface RepresentationEnd {
  id: string;
  /** Null when the caller may read the representation but not the record it names. */
  name: string | null;
  deleted: boolean;
}

/**
 * How a representation's `is_primary` flag should be READ, given its period.
 *
 * ===========================================================================
 * THE TIE-BREAK RULE, WRITTEN WHERE READS HAPPEN
 * ===========================================================================
 * `artist_representations_one_current_primary_per_artist` is partial on
 * `is_primary and ended_at is null and deleted_at is null`, so it enforces one
 * OPEN-ENDED primary, not one CURRENT one. `current_date` is not IMMUTABLE and
 * cannot appear in an index predicate or a CHECK constraint, so no schema
 * object can say otherwise. Measured on this database before the write path
 * was built: one artist held four `is_primary` rows at once -- one open-ended,
 * two with a future `ended_at`, one with a past `ended_at` -- and only a
 * SECOND OPEN-ENDED one raised 23505.
 *
 * Task 4b accepted the gap rather than forbidding a future-dated `ended_at`
 * (see 20260829000000's closing note: a representation that ends on a known
 * date is an ordinary fact people record when they sign it). The cost of
 * accepting it is that a reader has to know what to do when it finds two, and
 * this is that rule:
 *
 *   "current"        is_primary, no end date. THE ONE the index guarantees is
 *                    unique, and the ONLY one the product labels "Primary".
 *   "scheduled-end"  is_primary, end date in the future. Real, and shown as
 *                    "Primary until <date>" -- never as the current primary.
 *   "past"           is_primary, end date passed. History; shown as
 *                    "Was primary". This is the row the demote half of
 *                    set_artist_primary_representation() must never touch.
 *   null             not primary.
 *
 * Computed here rather than in a component so all three readers -- the artist
 * page, the agency page, and anything Phase 3 adds -- agree by construction.
 */
export type PrimaryState = "current" | "scheduled-end" | "past" | null;

/**
 * Today, in the timezone the product's dates are read in.
 *
 * `en-CA` because it formats as `YYYY-MM-DD`, which compares correctly as a
 * STRING against a `date` column's PostgREST representation. That is the whole
 * trick: `ended_at` never becomes a JavaScript `Date`, so nothing can shift it
 * a day under BST. CLAUDE.md § Non-functional targets: UTC in the database,
 * UK local time in the UI, with explicit handling.
 */
function todayInUK(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

export interface RepresentationRow {
  id: string;
  artist: RepresentationEnd;
  agency: RepresentationEnd;
  /** Null when no individual agent was named -- an ordinary, complete state. */
  contact: RepresentationEnd | null;
  role: string | null;
  territory: string | null;
  isExclusive: boolean;
  isPrimary: boolean;
  startedAt: string | null;
  endedAt: string | null;
  deletedAt: string | null;
  primaryState: PrimaryState;
}

const REPRESENTATION_SELECT =
  "id, artist_id, agency_id, contact_id, role, territory, is_exclusive, is_primary, started_at, ended_at, deleted_at, " +
  "artists ( id, name, deleted_at ), agencies ( id, name, deleted_at ), contacts ( id, name, deleted_at )";

function toRepresentationRows(rows: Record<string, unknown>[]): RepresentationRow[] {
  const today = todayInUK();
  const out: RepresentationRow[] = [];
  for (const row of rows) {
    const end = (
      embedKey: "artists" | "agencies" | "contacts",
      idKey: "artist_id" | "agency_id" | "contact_id",
    ): RepresentationEnd | null => {
      const id = row[idKey];
      if (typeof id !== "string") return null;
      const embed = row[embedKey] as
        | { id: string; name: string; deleted_at: string | null }
        | null;
      // The embed is null when the caller may read the representation but not
      // the record it points at. The IDENTIFIER is kept -- the policy already
      // handed it over -- and the name is not invented.
      return {
        id,
        name: embed ? String(embed.name) : null,
        deleted: embed ? embed.deleted_at !== null : false,
      };
    };
    const artist = end("artists", "artist_id");
    const agency = end("agencies", "agency_id");
    // Both are NOT NULL columns, so a null here means the row is malformed
    // rather than the caller being record-scoped -- skip it rather than render
    // half a representation.
    if (!artist || !agency) continue;
    const isPrimary = row.is_primary === true;
    const endedAt = (row.ended_at as string | null) ?? null;
    out.push({
      id: String(row.id),
      artist,
      agency,
      contact: end("contacts", "contact_id"),
      role: (row.role as string | null) ?? null,
      territory: (row.territory as string | null) ?? null,
      isExclusive: row.is_exclusive === true,
      isPrimary,
      startedAt: (row.started_at as string | null) ?? null,
      endedAt,
      deletedAt: (row.deleted_at as string | null) ?? null,
      primaryState: !isPrimary
        ? null
        : endedAt === null
          ? "current"
          : endedAt >= today
            ? "scheduled-end"
            : "past",
    });
  }
  return sortRepresentations(out);
}

/**
 * Current work first, history after it.
 *
 * NOT insertion order and NOT `is_primary` alone. The question a
 * representation panel answers is "who represents them NOW", so:
 *
 *   1. live rows before removed (soft-deleted) ones;
 *   2. among live rows, open-ended before ended, because an ended
 *      representation is history whatever its flags say;
 *   3. the current primary at the very top of the open-ended group -- it is
 *      the answer to "who is their main agency" and it must not drift down the
 *      list as representations are added;
 *   4. ended rows most-recently-ended first, which is how a history reads;
 *   5. by the agency's name, so the order is stable between renders.
 *
 * A row whose other end the caller cannot see (Q3a) sorts last within its
 * group rather than first, because `null` would otherwise lead every list.
 */
function sortRepresentations(rows: RepresentationRow[]): RepresentationRow[] {
  return rows.sort((a, b) => {
    const removed = Number(a.deletedAt !== null) - Number(b.deletedAt !== null);
    if (removed !== 0) return removed;
    const ended = Number(a.endedAt !== null) - Number(b.endedAt !== null);
    if (ended !== 0) return ended;
    const current =
      Number(b.primaryState === "current") - Number(a.primaryState === "current");
    if (current !== 0) return current;
    if (a.endedAt !== null && b.endedAt !== null && a.endedAt !== b.endedAt) {
      return a.endedAt < b.endedAt ? 1 : -1;
    }
    const an = a.agency.name ?? "￿";
    const bn = b.agency.name ?? "￿";
    return an.localeCompare(bn, "en-GB", { numeric: true, sensitivity: "base" });
  });
}

/**
 * Every representation of one artist, live and removed.
 *
 * Bounded by LINK_PANEL_LIMIT for the reason that constant gives: a detail
 * panel is a list endpoint that does not look like one, and CLAUDE.md
 * § Non-negotiable rules has no exception for panels. The honest limit,
 * recorded rather than papered over: an artist with more than 100
 * representations shows 100 of them. WHICH 100 is decided by the query's own
 * `ORDER BY` -- primary first, then oldest first -- and NOT by
 * `sortRepresentations`, which only reorders whatever the cap already let
 * through. Before final review I-6 there was no `ORDER BY` at all and the
 * truncation set was a different hundred on every render. That is far past any
 * real record; the real answer is a paginated panel, and the fee-history
 * section on the same page is what one looks like.
 */
export async function loadRepresentationsForArtist(
  organisationId: string,
  artistId: string,
): Promise<RepresentationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("artist_representations")
    .select(REPRESENTATION_SELECT)
    .eq("organisation_id", organisationId)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it Postgres
    // returns rows in whatever order it likes, so above LINK_PANEL_LIMIT the
    // hundred that come back are a different hundred on every render. The
    // rendered order was never at risk -- `sortRepresentations` sorts the rows again in
    // memory -- so what this fixes is WHICH rows survive the cap, not the
    // sequence they appear in. `is_primary` leads it so the primary link is
    // the one row that can never be truncated away; `id` closes the tie so
    // two rows created in the same transaction do not swap places.
    .eq("artist_id", artistId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[crm] artist_representations lookup failed:", error.message);
    }
    return [];
  }
  return toRepresentationRows(data as unknown as Record<string, unknown>[]);
}

/**
 * Every representation held by one agency.
 *
 * THE SAME ROWS, READ FROM THE OTHER SIDE, and the access decision is
 * unchanged: `artist_representations_select_via_artist` reaches EXISTS against
 * `artists` alone, so a record-scoped user browsing an agency they own sees
 * only the representations whose ARTIST they also own. That is Q3a working as
 * adjudicated, not a bug in this query -- and it is why the agency page's
 * panel says so in its empty state rather than claiming the agency represents
 * nobody.
 */
export async function loadRepresentationsForAgency(
  organisationId: string,
  agencyId: string,
): Promise<RepresentationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("artist_representations")
    .select(REPRESENTATION_SELECT)
    .eq("organisation_id", organisationId)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it Postgres
    // returns rows in whatever order it likes, so above LINK_PANEL_LIMIT the
    // hundred that come back are a different hundred on every render. The
    // rendered order was never at risk -- `sortRepresentations` sorts the rows again in
    // memory -- so what this fixes is WHICH rows survive the cap, not the
    // sequence they appear in. `is_primary` leads it so the primary link is
    // the one row that can never be truncated away; `id` closes the tie so
    // two rows created in the same transaction do not swap places.
    .eq("agency_id", agencyId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[crm] artist_representations lookup failed:", error.message);
    }
    return [];
  }
  return toRepresentationRows(data as unknown as Record<string, unknown>[]);
}

// ---------------------------------------------------------------------------
// venue_rooms
// ---------------------------------------------------------------------------

export interface RoomRow {
  id: string;
  name: string;
  deletedAt: string | null;
}

/**
 * Every room in one venue, open and closed.
 *
 * NO EMBED AND NOTHING TO DISCLOSE. A room names no second entity: its record
 * scope is its venue's, `venue_rooms` carries no `owner_user_id` by design
 * (20260827232510 convention (2)), and a caller who can read the venue can
 * read all of its rooms. That is why this is the shortest reader in the file
 * and why 20260829001000's half for `venue_rooms` is one-sided.
 *
 * Closed rooms come back too, and are shown. `deleted_at` exists on this table
 * so that Phase 3 events can reference a room that has since closed
 * (20260827232510), so hiding closed rooms would hide the thing the column was
 * added for -- and the restore path has to be reachable or the soft delete is
 * a hard delete with extra steps.
 *
 * Bounded by LINK_PANEL_LIMIT, same argument as the representation panel. A
 * venue with more than 100 rooms is a festival site, not a venue.
 */
export async function loadRoomsForVenue(
  organisationId: string,
  venueId: string,
): Promise<RoomRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venue_rooms")
    .select("id, name, deleted_at")
    .eq("organisation_id", organisationId)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). `venue_rooms` carries
    // its own `name`, so the cap keeps the alphabetically first hundred rather
    // than an arbitrary hundred. The rendered order is still decided in memory
    // below (open rooms first, then closed); this decides which rows are read.
    .eq("venue_id", venueId)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error || !data) {
    if (error) console.error("[crm] venue_rooms lookup failed:", error.message);
    return [];
  }
  return data
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      deletedAt: (row.deleted_at as string | null) ?? null,
    }))
    // Open rooms first, then closed ones, each alphabetically. Closed rooms
    // are a tail the user scrolls past, not rows interleaved with live ones.
    .sort((a, b) => {
      const closed = Number(a.deletedAt !== null) - Number(b.deletedAt !== null);
      if (closed !== 0) return closed;
      return a.name.localeCompare(b.name, "en-GB", {
        numeric: true,
        sensitivity: "base",
      });
    });
}

/**
 * Venue names for one page of events, keyed by venue id.
 *
 * ===========================================================================
 * A SECOND QUERY, NOT A PostgREST EMBED, AND THE EMBED IS THE OBVIOUS CHOICE
 * ===========================================================================
 * `EVENT_SELECT` carries `venue_id` and the events list renders a venue NAME.
 * `select=...,venues(name)` would do it in one round trip and it is rejected
 * for two reasons, both mechanical:
 *
 *   1. `fetchListPage` (lib/list/query.ts) runs a COUNT query beside the page
 *      query, and up to two `limit 1` boundary probes. An embed changes the
 *      shape of the request PostgREST plans, and `count=exact` over a request
 *      carrying an embed counts something this list would then have to reason
 *      about. The count line is a claim about how many events match; nothing
 *      about a venue should be able to move it.
 *   2. Under RLS an embed of a row the caller cannot read comes back as
 *      `null`, so the null case has to be handled anyway -- see `toLinkRows()`
 *      above, which drops exactly that row for exactly that reason. The embed
 *      therefore buys one round trip and costs the same branch.
 *
 * A VENUE THE CALLER CANNOT READ IS SIMPLY NOT IN THE MAP, and the cell then
 * renders the same em-dash `Absent` marker as "no venue recorded". THAT
 * COLLISION IS THE POINT AND NOT A LIMITATION: rendering "(unavailable)" would
 * confirm that a record exists and is out of reach, which is the oracle
 * `toLinkRows()` above already refuses to build and the same one
 * `getCurrentOrg()` refuses for slugs. A record-scoped user seeing a dash
 * learns nothing about their colleagues' venues.
 *
 * The query runs through the CALLER'S OWN client, so RLS decides what comes
 * back; `organisation_id` is pinned anyway, because multi-org membership means
 * RLS alone would allow the other workspace's rows.
 *
 * BOUNDED BY CONSTRUCTION. The caller passes the venue ids of ONE page, so at
 * most `MAX_PAGE_SIZE` = 50 distinct ids (lib/list/params.ts enforces the
 * ceiling server-side). `.in()` with 50 uuids is a ~2KB query string, which is
 * why this is safe to do per page and would not be safe over a whole tenant.
 */
export async function loadVenueNames(
  organisationId: string,
  venueIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(venueIds)];
  // No ids means no query. `.in("id", [])` is a legal request that returns
  // nothing, but it is still a round trip on every page of a workspace whose
  // events have no venues yet -- which is most of them at the start.
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venues")
    .select("id, name")
    .eq("organisation_id", organisationId)
    .in("id", unique)
    // RLS DOES NOT DO THIS (lib/list/query.ts clause 2, and Phase 2 Task 2
    // § 4.1 decided it deliberately). Without it a soft-deleted venue's name
    // renders on a live event as though nothing had happened, and the list
    // would be the one surface in the product that shows deleted records.
    .is("deleted_at", null);

  if (error || !data) {
    if (error) console.error("[crm] venue name lookup failed:", error.message);
    // An empty map, not a throw. The venue column degrades to dashes and the
    // rest of the page renders -- the failure of a decorative lookup must not
    // take down a list of events. A caller that needs to distinguish "no
    // venue" from "lookup failed" should not be using this function.
    return new Map();
  }
  return new Map(data.map((row) => [String(row.id), String(row.name)]));
}

// ===========================================================================
// PHASE 3 TASK 4: events
// ===========================================================================
// The same three-way `RecordResult`, the same "deleted_at is selected and not
// filtered" rule, and the same `safeHref` discipline as every loader above.
// What is new is the picker, which has to offer rooms grouped by venue with no
// JavaScript to cascade with -- see `loadVenuesForPicker`.

export interface EventDetail {
  id: string;
  name: string;
  eventType: EventType;
  status: EventStatus;
  /** An INSTANT. `timestamptz`, rendered through lib/format/date.ts. */
  startsAt: string;
  endsAt: string | null;
  venueId: string | null;
  /**
   * Null when there is no venue AND when the caller cannot read the one this
   * event names -- the same collision the events list makes deliberately (see
   * `loadVenueNames`). Distinguishing them would confirm that a record exists
   * and is out of reach.
   */
  venueName: string | null;
  /** True when the venue is soft-deleted. The name is still shown; the link is not. */
  venueDeleted: boolean;
  venueRoomId: string | null;
  roomName: string | null;
  /** True when the room has been closed. A closed room stays on a past event. */
  roomClosed: boolean;
  location: string | null;
  /**
   * The raw column, rendered as TEXT when `ticketLinkHref` is null.
   *
   * `events_ticket_link_is_http` is a CHECK on the column and 20260901000000
   * calls it "DEFENCE IN DEPTH, NOT THE CONTROL" in as many words, because it
   * does not run on render: a row that predates it, an import, or a merge can
   * carry anything. `safeHref()` below is the control.
   */
  ticketLink: string | null;
  ticketLinkHref: string | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One event, live or soft-deleted.
 *
 * DOES NOT FILTER `deleted_at`, like every other detail loader in this file:
 * the route has to serve a deleted event with a notice and a Restore control
 * rather than a 404, or the soft delete is a hard delete with extra steps and
 * the restore list links into nothing.
 *
 * THE VENUE AND ROOM NAMES ARE TWO MORE ROUND TRIPS, NOT AN EMBED, for the
 * reason `loadVenueNames` gives above: an embed of a row the caller cannot
 * read comes back null anyway, so it buys one round trip and costs the same
 * branch. Both are `maybeSingle()` lookups by primary key, and both are
 * skipped when the column is null -- which it is for most events, since an
 * event is routinely created before the venue is booked.
 *
 * NEITHER LOOKUP FILTERS `deleted_at` EITHER, and that is a departure from the
 * LIST, which does. On a list a deleted venue's name would be the one place in
 * the product showing a deleted record; on the DETAIL page of the event that
 * names it, hiding the name would leave a dash where the user recorded
 * something, and they cannot fix what they cannot see. So the name renders,
 * marked, and only the link is withheld.
 */
export async function loadEvent(
  organisationId: string,
  eventId: string,
): Promise<RecordResult<EventDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, name, event_type, status, starts_at, ends_at, venue_id, venue_room_id, location, ticket_link, notes, deleted_at, created_at, updated_at",
    )
    .eq("organisation_id", organisationId)
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    // 22P02 is an unparseable uuid in the URL: no such record, and there never
    // could be. Anything else is a fault, and a fault is not a missing record.
    if (error.code === "22P02") return { outcome: "missing" };
    console.error(
      `[crm] event lookup failed in organisation ${organisationId}:`,
      error.message,
    );
    return { outcome: "unavailable" };
  }
  if (!data) return { outcome: "missing" };

  const venueId = (data.venue_id as string | null) ?? null;
  const venueRoomId = (data.venue_room_id as string | null) ?? null;
  const [venue, room] = await Promise.all([
    venueId === null
      ? Promise.resolve(null)
      : lookupPlace(supabase, "venues", organisationId, venueId),
    venueRoomId === null
      ? Promise.resolve(null)
      : lookupPlace(supabase, "venue_rooms", organisationId, venueRoomId),
  ]);

  return {
    outcome: "found",
    record: {
      id: String(data.id),
      name: String(data.name),
      eventType: data.event_type as EventType,
      status: data.status as EventStatus,
      startsAt: String(data.starts_at),
      endsAt: (data.ends_at as string | null) ?? null,
      venueId,
      venueName: venue?.name ?? null,
      venueDeleted: venue?.deleted === true,
      venueRoomId,
      roomName: room?.name ?? null,
      roomClosed: room?.deleted === true,
      location: (data.location as string | null) ?? null,
      ticketLink: (data.ticket_link as string | null) ?? null,
      // NOT the raw column. See the field's own comment: the CHECK constraint
      // is defence in depth and does not run on render.
      ticketLinkHref: safeHref(data.ticket_link as string | null),
      notes: (data.notes as string | null) ?? null,
      deletedAt: (data.deleted_at as string | null) ?? null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  };
}

/**
 * The name and liveness of one venue or room, or null.
 *
 * Through the CALLER'S OWN client and pinned to the organisation, so this is
 * not a privileged existence check: a record another workspace owns, or one
 * outside a record-scoped caller's scope, returns null here and renders as
 * "not recorded" -- the same collision the events list makes on purpose.
 */
async function lookupPlace(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "venues" | "venue_rooms",
  organisationId: string,
  id: string,
): Promise<{ name: string; deleted: boolean } | null> {
  const { data, error } = await supabase
    .from(table)
    .select("name, deleted_at")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    if (error && error.code !== "22P02") {
      console.error(`[crm] ${table} name lookup failed:`, error.message);
    }
    return null;
  }
  return { name: String(data.name), deleted: data.deleted_at !== null };
}

/**
 * Rooms are capped separately from venues, and the number is derived.
 *
 * `LINK_PANEL_LIMIT` bounds the VENUES for the reason that constant gives. The
 * rooms are a second list under them and one cap of 100 across the whole
 * workspace would mean the alphabetically-last venues silently had no rooms
 * offered -- 100 venues with eight rooms each is 800, which is a large but
 * entirely ordinary workspace. Ten rooms a venue is past any real one, and
 * deriving it from `LINK_PANEL_LIMIT` keeps one number to change.
 *
 * THE HONEST LIMIT, recorded rather than papered over, exactly as
 * `LINK_PANEL_LIMIT` records its own: past this the picker offers the
 * alphabetically first rooms and the server still accepts any room of the
 * chosen venue, so a workspace that outgrows it needs a search-backed picker
 * -- named in the task report and in FOLLOW-UPS.md, not guessed at here.
 */
const PICKER_ROOM_LIMIT = LINK_PANEL_LIMIT * 10;

/**
 * The venues and rooms the event form offers.
 *
 * THE QUERIES ARE HERE; THE ASSEMBLY IS IN lib/crm/event-picker.ts, which is
 * pure and unit-tested. That split was made in fix round 1 because the defect
 * it found (I-1) lived in the assembly and nothing in this repository could
 * reach it: `tests/unit` is pure functions only, by vitest.config.ts's own
 * rule, and this module cannot be imported into a node test.
 *
 * ===========================================================================
 * ONLY WHAT THE CALLER CAN READ, WHICH IS WHERE THE WRITE HALF IS CLOSED
 * ===========================================================================
 * The same rule as `loadLinkOptions` and for the same reason (20260828140500's
 * write-half item): a picker that offers records the caller cannot see is how
 * a record-scoped user creates a link to a record they cannot read. The query
 * runs through the CALLER'S OWN client, so what comes back is exactly what
 * their SELECT policy allows. It is a courtesy and not a control -- a forged
 * form post naming a venue they cannot see is still decided by the database.
 *
 * ===========================================================================
 * NO JAVASCRIPT CASCADE, SO EVERY ROOM IS RENDERED AT ONCE
 * ===========================================================================
 * The form works with JavaScript disabled, which means there is nothing to
 * repopulate the room `<select>` when the venue `<select>` changes. So every
 * live room in the workspace is returned, grouped by its venue, and the FORM
 * renders each group as an `<optgroup label={venue.name}>` -- a native control
 * a keyboard and a screen reader both already understand. The server refuses a
 * room that is not in the chosen venue; that check is the correctness, and
 * this is the affordance.
 *
 * ===========================================================================
 * `includeVenueId` / `includeRoomId`: THE EDIT FORM'S STALE ENDS
 * ===========================================================================
 * An event may already name a venue the picker offers nobody, and a `<select>`
 * that does not contain the stored value SILENTLY SUBMITS A DIFFERENT ONE --
 * so editing the event's NAME would clear its venue with nothing said. The
 * edit page therefore passes the stored ids, and `assemblePicker` guarantees
 * each one is an option in the result whatever else is true.
 *
 * THREE WAYS A STORED VENUE IS ABSENT FROM THE LIVE LIST, AND ALL THREE ARE
 * HANDLED (fix round 1, I-1 -- the third was not):
 *
 *   soft-deleted   found by `lookupPlace`, which deliberately does not filter
 *                  `deleted_at`; keeps its name, marked "(deleted)".
 *   past the cap   found the same way; renders as an ordinary live venue.
 *   UNREADABLE     `lookupPlace` returns null, and the option is appended
 *                  anyway with NO NAME. See lib/crm/event-picker.ts's header
 *                  for why that discloses nothing the caller's own SELECT
 *                  policy does not already hand them, and why the alternative
 *                  -- omitting it -- is a silent `venue_id = null` on the next
 *                  save.
 *
 * A CLOSED ROOM IS DIFFERENT FROM A DELETED VENUE, and the asymmetry is
 * deliberate: `venue_rooms.deleted_at` exists precisely so a past event can go
 * on naming a room that has closed (20260827232510), so the action ACCEPTS a
 * closed room of the chosen venue. It is marked in the list so the user knows
 * what they are looking at; it is not refused.
 */
export async function loadVenuesForPicker(
  organisationId: string,
  includeVenueId: string | null = null,
  includeRoomId: string | null = null,
): Promise<PickerVenue[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venues")
    .select("id, name")
    .eq("organisation_id", organisationId)
    .is("deleted_at", null)
    // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it the hundred
    // that survive the cap are a different hundred on every render.
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(LINK_PANEL_LIMIT);

  if (error) {
    console.error("[crm] venue picker lookup failed:", error.message);
    return [];
  }

  const live = (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
  }));

  // Only when the record HAS a venue and the live list does not carry it.
  const needsStoredVenue =
    includeVenueId !== null && !live.some((row) => row.id === includeVenueId);
  const storedVenue = needsStoredVenue
    ? await lookupPlace(supabase, "venues", organisationId, includeVenueId)
    : null;

  // THE ID SET FOR THE ROOM QUERY INCLUDES THE STORED VENUE even when it is
  // unreadable -- `.in()` over an id the caller cannot read simply returns no
  // rows, which is the right answer and costs nothing.
  const venueIds = [...new Set([...live.map((row) => row.id), ...(includeVenueId ? [includeVenueId] : [])])];

  let rooms: { id: string; name: string; venueId: string }[] = [];
  if (venueIds.length > 0) {
    // THE QUERY-STRING BUDGET, recorded as `loadVenueNames` records its own:
    // at most LINK_PANEL_LIMIT + 1 = 101 uuids, roughly 4KB of GET query
    // string. Within ordinary proxy and PostgREST limits (and double the 50
    // that earned a sentence there), and bounded by construction rather than
    // by hope -- the venue list above is already capped.
    const result = await supabase
      .from("venue_rooms")
      .select("id, name, venue_id")
      .eq("organisation_id", organisationId)
      .is("deleted_at", null)
      .in("venue_id", venueIds)
      // ORDER BY BEFORE LIMIT, same rule.
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .limit(PICKER_ROOM_LIMIT);
    if (result.error) {
      console.error("[crm] room picker lookup failed:", result.error.message);
    } else {
      rooms = (result.data ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        venueId: String(row.venue_id),
      }));
    }
  }

  // The stored room, when the live rooms do not carry it -- a closed room the
  // event still names, or one this caller cannot read.
  const needsStoredRoom =
    includeRoomId !== null && !rooms.some((row) => row.id === includeRoomId);
  let storedRoom: { name: string; venueId: string; deleted: boolean } | null = null;
  if (needsStoredRoom) {
    const result = await supabase
      .from("venue_rooms")
      .select("name, venue_id, deleted_at")
      .eq("organisation_id", organisationId)
      .eq("id", includeRoomId)
      .maybeSingle();
    if (result.error && result.error.code !== "22P02") {
      console.error("[crm] stored room lookup failed:", result.error.message);
    }
    if (result.data) {
      storedRoom = {
        name: String(result.data.name),
        venueId: String(result.data.venue_id),
        deleted: result.data.deleted_at !== null,
      };
    }
  }

  return assemblePicker({
    live,
    rooms,
    includeVenueId,
    includeRoomId,
    storedVenue,
    storedRoom,
  });
}

// ===========================================================================
// PHASE 3 TASK 5: the lineup
// ===========================================================================
// Two readers, and one of them is deliberately a delegation rather than a
// query. What is new here is that a CHILD PANEL is a real lib/list/ surface --
// see lib/crm/lineup-list.ts's header for why a lineup pages where a room or a
// representation is capped.

/** An artist as the lineup panel needs to render them. */
export interface LineupArtist {
  name: string;
  /**
   * Soft-deleted. NAMED AND NOT LINKED, exactly as `loadEvent` treats a
   * deleted venue: the name is what the user recorded and hiding it would
   * leave a dash they cannot act on.
   */
  deleted: boolean;
}

/** One removed slot, for the disclosure that makes restore reachable. */
export interface RemovedLineupRow {
  id: string;
  artistId: string;
  position: number;
  deletedAt: string;
}

/**
 * One event's lineup: a page of it, the removed rows under it, and the names.
 *
 * ===========================================================================
 * THREE QUERIES, AND EACH ONE ANSWERS A DIFFERENT QUESTION
 * ===========================================================================
 *   1. `fetchListPage` over `event_lineup`, keyset-paginated, live rows only
 *      (`applyScope` writes `deleted_at is null`), ordered by `position` then
 *      `id` and filtered to this event. That is the BILL.
 *   2. A capped read of the REMOVED rows. Not paginated, deliberately: a
 *      second lib/list/ surface on this page would need a third query-string
 *      namespace and a third pager for a tail nobody scrolls. It is bounded by
 *      `LINK_PANEL_LIMIT` for the reason that constant gives, ordered before
 *      it caps (final review I-6), and the honest limit is that an event with
 *      more than 100 removed slots shows the 100 most recently removed.
 *   3. The artist NAMES, for the union of both sets' artist ids.
 *
 * ===========================================================================
 * NAMES ARE A SECOND QUERY, NOT A PostgREST EMBED -- `loadVenueNames`' REASONS
 * ===========================================================================
 * `select=...,artists(name)` would do it in one round trip and is rejected for
 * the two mechanical reasons that function records: `fetchListPage` runs a
 * `count=exact` head request and up to two boundary probes beside the page
 * query, and nothing about an artist should be able to move the count line;
 * and under RLS an embed of a row the caller cannot read comes back `null`
 * anyway, so the branch is owed either way.
 *
 * WHERE THIS DIVERGES FROM `loadVenueNames`: **`deleted_at` IS SELECTED, NOT
 * FILTERED.** That function filters it so the events LIST is not the one
 * surface in the product showing deleted records. This is a DETAIL page, and
 * `loadEvent`'s own place lookups already make the opposite choice there for
 * the same reason -- on the page of the event that books them, hiding a
 * deleted artist's name leaves a row the user cannot act on. So the name
 * renders, marked, and only the LINK is withheld.
 *
 * AN ARTIST THE CALLER CANNOT READ IS SIMPLY NOT IN THE MAP, and the panel
 * then renders "An artist outside your access" rather than a name. That is the
 * same accepted IDENTIFIER disclosure lib/crm/event-picker.ts records: the
 * caller already holds `artist_id` -- `event_lineup_select_via_event` returns
 * the whole slot row and PostgREST is reachable from a browser with the anon
 * key -- and no ATTRIBUTE crosses the boundary, because no name is fetched.
 *
 * BOUNDED BY CONSTRUCTION. At most `MAX_PAGE_SIZE` (50) live ids plus
 * `LINK_PANEL_LIMIT` (100) removed ones, so 150 uuids at the very worst --
 * roughly 6KB of GET query string, the same budget `loadVenuesForPicker`
 * records for its 101.
 */
export async function loadLineupForEvent(
  organisationId: string,
  eventId: string,
  raw: RawSearchParams,
): Promise<{
  params: LineupParams;
  page: ListPage<LineupRow>;
  removed: readonly RemovedLineupRow[];
  artists: ReadonlyMap<string, LineupArtist>;
}> {
  // THE RAW QUERY STRING IN, THE PARSED PARAMS BACK OUT, rather than the
  // parsed params in. Two reasons, and the first is the one that made this
  // signature change rather than a preference:
  //
  //   * tests/unit/list/one-cursor-only.test.ts requires every
  //     `fetchListPage` caller to parse its params through lib/list, so that
  //     a list cannot arrive here with a cursor somebody read off the query
  //     string by hand. Taking a pre-parsed `LineupParams` would have left
  //     that pairing to a caller nobody checks.
  //   * `lineupParams` applies LINEUP_LIST's namespace AND drops `lineup_q`
  //     (see its doc-block). A caller that built params some other way would
  //     silently lose the drop -- and the symptom is "No lineup yet" on an
  //     event with a full bill, which is exactly the lie the drop exists to
  //     prevent.
  //
  // The parsed params come back because the PAGER needs them, and they must
  // be the same object this read used or the links describe a different page
  // from the one on screen.
  const params = lineupParams(raw);
  const supabase = await createClient();

  const [page, removedResult] = await Promise.all([
    fetchListPage<LineupRow, LineupSortKey, LineupFilterKey>({
      spec: LINEUP_LIST,
      params,
      organisationId,
      table: "event_lineup",
      select: LINEUP_SELECT,
      mapRow: mapLineupRow,
      // THE SECOND EQUALITY COLUMN. `fetchListPage` pins organisation_id
      // itself; this pins the event, and 20260901021000's index is built as
      // (organisation_id, event_id, position, id) to match. The id comes from
      // the resolved route, never from the query string.
      applyFilters: (query: ListQuery) => query.eq("event_id", eventId),
    }),
    supabase
      .from("event_lineup")
      .select("id, artist_id, position, deleted_at")
      .eq("organisation_id", organisationId)
      .eq("event_id", eventId)
      // ORDER BY BEFORE LIMIT (final review I-6 / L771). Without it the
      // hundred that survive the cap are a different hundred on every render.
      // Most recently removed first, because that is the one a user is looking
      // for when they open the disclosure; `id` closes the tie.
      .filter("deleted_at", "not.is", null)
      .order("deleted_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(LINK_PANEL_LIMIT),
  ]);

  if (removedResult.error) {
    console.error(
      "[crm] removed lineup lookup failed:",
      removedResult.error.message,
    );
  }
  const removed: RemovedLineupRow[] = (removedResult.data ?? []).map((row) => ({
    id: String(row.id),
    artistId: String(row.artist_id),
    position: Number(row.position),
    deletedAt: String(row.deleted_at),
  }));

  const ids = new Set<string>(removed.map((row) => row.artistId));
  if (page.outcome === "loaded") {
    for (const row of page.rows) ids.add(row.artistId);
  }

  const artists = new Map<string, LineupArtist>();
  if (ids.size > 0) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, deleted_at")
      .eq("organisation_id", organisationId)
      .in("id", [...ids]);
    if (error) {
      // An empty map, not a throw. The panel degrades to "An artist outside
      // your access" and the rest of the page renders -- the failure of a name
      // lookup must not take down the bill it decorates. Same disposition as
      // `loadVenueNames`.
      console.error("[crm] artist name lookup failed:", error.message);
    } else {
      for (const row of data ?? []) {
        artists.set(String(row.id), {
          name: String(row.name),
          deleted: row.deleted_at !== null,
        });
      }
    }
  }

  return { params, page, removed, artists };
}

/**
 * Candidates for the lineup panel's artist picker.
 *
 * ===========================================================================
 * A DELEGATION, NOT A SECOND COPY OF THE SAME QUERY
 * ===========================================================================
 * The brief names this function, and what it asks for -- live artists of this
 * workspace, ordered by name, bounded at `LINK_PANEL_LIMIT` -- is EXACTLY what
 * `loadLinkOptions("artists", ...)` already is. Writing the four clauses out
 * again would put `.is("deleted_at", null)` in two places with only one of
 * them guarded: `tests/unit/crm/source-shape.test.ts` asserts that filter
 * against `loadLinkOptions` by name (review mutation 8 -- dropping it is
 * invisible to the whole suite and starts offering records the product says
 * are deleted), and the copy would sit outside that assertion.
 *
 * `exclude` IS EMPTY, and that is a decision rather than a default. The
 * obvious move is to leave out the artists already on this bill, and it cannot
 * be done honestly here, because the panel is PAGINATED: the caller holds one
 * page of the lineup, not all of it, so an exclusion list built from it would
 * hide artists that are on the bill and offer others that are, arbitrarily by
 * page. The duplicate is refused instead -- by
 * `event_lineup_event_artist_live_unique`, and by a sentence
 * (`LINEUP_DUPLICATE_ARTIST` in lib/crm/events.ts) rather than by a silently
 * shorter list.
 *
 * THE CAP IS THE SAME NAMED STOPGAP `LINK_PANEL_LIMIT` records: past 100
 * artists the picker offers the alphabetically first 100, and the real answer
 * is a search-backed picker with its own keyset page, which needs a measured
 * design and is in FOLLOW-UPS.md rather than guessed at here.
 */
export async function loadArtistsForPicker(
  organisationId: string,
): Promise<{ id: string; name: string }[]> {
  return loadLinkOptions("artists", organisationId, []);
}
