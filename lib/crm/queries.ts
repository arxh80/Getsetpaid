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
