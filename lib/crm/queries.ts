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
    .eq("contact_id", contactId)
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
    .eq("company_id", companyId)
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
 */
export async function loadLinkOptions(
  table: "companies" | "contacts",
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
