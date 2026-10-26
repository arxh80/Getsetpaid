import "server-only";

// `loadNetworkProfileById` is `cache`-wrapped: both profile routes ask for the
// profile twice in one render (generateMetadata, then the body). Per-request
// and keyed on the two string ids -- see lib/crm/queries.ts's header.
import { cache } from "react";

// The bridge between "a network profile" and "the private record it speaks
// for" -- reading the PRIVATE side only, never joining it into a network
// query. Two things live here:
//
//   1. WHICH RECORDS CAN BE PUBLISHED. The "Publish a record" picker on
//      app/(app)/[orgSlug]/network/profiles/page.tsx needs, per manageable
//      kind, this organisation's live records that do not already have a
//      live profile (Q74: one profile per record). `loadLinkOptions` already
//      is exactly that query for four of its six tables -- company, artist,
//      venue, agency, the same four NETWORK_ENTITY_KINDS names -- so this
//      delegates rather than re-querying (the same argument
//      `loadArtistsForPicker`'s header makes).
//   2. THE FOUR DETAIL PAGES' "Network identity" ROW. Each of
//      companies/[companyId], artists/[artistId], venues/[venueId] and
//      agencies/[agencyId] needs to know: does this record have a network
//      profile, and if so, has the private record changed since it was
//      published (the Q75 drift affordance, lib/network/drift.ts). Both
//      questions are answered from the CALLER'S OWN organisation_id and
//      entity_id -- never a cross-tenant read, never a join from
//      network_profiles into a private table.
//
// NO DATABASE PATH FROM network_profiles TO A PRIVATE TABLE IS INTRODUCED
// HERE. Every function below is either a query against ONE table (a private
// entity table, or network_profiles scoped to organisation_id = the caller's
// own) -- never a join between them. The drift comparison itself is plain
// JavaScript over two already-separately-loaded objects (lib/network/drift.ts),
// which is what "compares... inside the server component that already loads
// both" (the brief) means in practice.

import { createClient } from "@/lib/supabase/server";
import { LINK_PANEL_LIMIT } from "@/lib/crm/queries";
import {
  parseFieldVisibility,
  type FieldVisibility,
  type NetworkEntityKind,
  type ProfileStatus,
} from "@/lib/network/fields";

/** The private table each network entity kind speaks for. */
export const ENTITY_TABLE: Record<NetworkEntityKind, "companies" | "artists" | "venues" | "agencies"> = {
  company: "companies",
  artist: "artists",
  venue: "venues",
  agency: "agencies",
};

export interface EntityOption {
  id: string;
  name: string;
}

/** How many pages of records the publish picker scans for unpublished ones. */
export const PUBLISHABLE_SCAN_PAGES = 10;

/**
 * Live records of one kind this organisation could publish -- i.e. not
 * already speaking through a live profile (Q74: one profile per record).
 *
 * BOUNDED (Phase 10 Task 14, G6). It used to read EVERY live profile id of the
 * kind as an exclusion list, which past max_rows (1000) was cut short and
 * offered already-published records again. Now it walks the records in name
 * order a page at a time, asks which of THAT page's ids have a live profile
 * (one per record, so at most a page of rows), and keeps the rest, until it
 * has LINK_PANEL_LIMIT or has scanned PUBLISHABLE_SCAN_PAGES pages.
 * shortcut: a workspace with more than 1,000 published records of one kind
 * may see fewer than 100 options; a search box is the upgrade.
 *
 * Soft-deleted profiles do not count (`network_profiles_entity_unique` is
 * partial on `deleted_at is null`), so a record whose profile was deleted is
 * offered again.
 *
 * A FAILED READ OFFERS NOTHING: treating every record as unpublished would
 * offer ones that already have a profile and hit the unique index's 23505.
 *
 * DOES NOT CHECK MANAGEABILITY. That is `getNetworkPublishAccessForEntity`'s
 * job (lib/network/access.ts) and the caller's (M4).
 */
export async function loadPublishableEntities(
  organisationId: string,
  entityKind: NetworkEntityKind,
): Promise<EntityOption[]> {
  const supabase = await createClient();
  const options: EntityOption[] = [];
  // Walked by name with `.gte` (no offset: tests/unit/list/one-cursor-only
  // bans it), skipping ids already seen, so records sharing the boundary name
  // are neither repeated nor lost.
  const seen = new Set<string>();
  let fromName: string | null = null;
  for (let page = 0; page < PUBLISHABLE_SCAN_PAGES && options.length < LINK_PANEL_LIMIT; page += 1) {
    let query = supabase
      .from(ENTITY_TABLE[entityKind])
      .select("id, name")
      .eq("organisation_id", organisationId)
      .is("deleted_at", null);
    if (fromName !== null) query = query.gte("name", fromName);
    const records = await query
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .limit(LINK_PANEL_LIMIT);
    if (records.error) {
      console.error(`[network] publishable ${entityKind} lookup failed:`, records.error.message);
      return [];
    }
    const fresh = records.data.filter((row) => !seen.has(String(row.id)));
    if (fresh.length === 0) break;
    for (const row of fresh) seen.add(String(row.id));
    fromName = String(records.data[records.data.length - 1]!.name);

    const ids = fresh.map((row) => String(row.id));
    const profiles = await supabase
      .from("network_profiles")
      .select("entity_id")
      .eq("organisation_id", organisationId)
      .eq("entity_kind", entityKind)
      .is("deleted_at", null)
      .in("entity_id", ids)
      .limit(LINK_PANEL_LIMIT);
    if (profiles.error) {
      console.error(`[network] existing-profile lookup failed for ${entityKind}:`, profiles.error.message);
      return [];
    }
    const published = new Set(profiles.data.map((row) => String(row.entity_id)));
    for (const row of fresh) {
      if (options.length < LINK_PANEL_LIMIT && !published.has(String(row.id))) {
        options.push({ id: String(row.id), name: String(row.name) });
      }
    }
    if (records.data.length < LINK_PANEL_LIMIT) break;
  }
  return options;
}

/** One organisation's live network profile for one of its own private
 *  records, as the four detail pages and the drift notice need it. */
export interface EntityNetworkProfile {
  id: string;
  status: ProfileStatus;
  displayName: string;
  city: string | null;
  country: string | null;
  websiteUrl: string | null;
  fieldVisibility: FieldVisibility;
}

/**
 * This organisation's own live network profile for one private record, or
 * null if it has none.
 *
 * Reads `network_profiles` filtered to `organisation_id = organisationId` --
 * the caller's OWN row, through the `network_profiles_select_view_network`
 * policy, never the cross-tenant directory policy. `entity_kind`/`entity_id`
 * are the polymorphic pair Q74 names; there is no foreign key to join through,
 * by design (20260904000000's header), so this is a plain equality lookup on
 * a table any query touching entity_id already has to filter this way.
 */
export async function loadNetworkProfileForEntity(
  organisationId: string,
  entityKind: NetworkEntityKind,
  entityId: string,
): Promise<EntityNetworkProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("network_profiles")
    .select("id, status, display_name, city, country, website_url, field_visibility")
    .eq("organisation_id", organisationId)
    .eq("entity_kind", entityKind)
    .eq("entity_id", entityId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error(
      `[network] profile lookup failed for ${entityKind} ${entityId}:`,
      error.message,
    );
    return null;
  }
  if (!data) return null;
  return {
    id: String(data.id),
    status: data.status as ProfileStatus,
    displayName: String(data.display_name),
    city: (data.city as string | null) ?? null,
    country: (data.country as string | null) ?? null,
    websiteUrl: (data.website_url as string | null) ?? null,
    fieldVisibility: parseFieldVisibility(data.field_visibility),
  };
}

/** The full row the editor (app/(app)/[orgSlug]/network/profiles/[profileId])
 *  needs -- every column `components/network/profile-editor.tsx` renders a
 *  control for, plus the identifiers the write gate needs. */
export interface NetworkProfileDetail {
  id: string;
  entityKind: NetworkEntityKind;
  entityId: string;
  status: ProfileStatus;
  displayName: string;
  headline: string;
  bio: string;
  city: string;
  region: string;
  country: string;
  websiteUrl: string;
  contactEmail: string;
  fieldVisibility: FieldVisibility;
}

/**
 * This organisation's own profile, by ITS OWN id -- the editor's lookup.
 *
 * `organisation_id = organisationId` is repeated here for the SAME reason
 * every detail page in this codebase repeats it on an id lookup: RLS already
 * refuses a foreign tenant's row, but a caller who is an ADMIN OF TWO
 * organisations and typed the wrong org's slug into the URL would otherwise
 * see another one of their OWN workspaces' rows on the wrong page -- RLS
 * cannot tell that apart, because both memberships are genuinely theirs. Null
 * covers "no such profile", "another tenant's", and "soft-deleted" alike, on
 * purpose: the editor 404s the same way for all three (DESIGN.md § Error
 * pages' enumeration-oracle argument, applied to a profile rather than a CRM
 * record).
 */
export const loadNetworkProfileById = cache(async (
  organisationId: string,
  profileId: string,
): Promise<NetworkProfileDetail | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("network_profiles")
    .select(
      "id, entity_kind, entity_id, status, display_name, headline, bio, city, region, country, website_url, contact_email, field_visibility",
    )
    .eq("organisation_id", organisationId)
    .eq("id", profileId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error(`[network] profile-by-id lookup failed for ${profileId}:`, error.message);
    return null;
  }
  if (!data) return null;
  return {
    id: String(data.id),
    entityKind: data.entity_kind as NetworkEntityKind,
    entityId: String(data.entity_id),
    status: data.status as ProfileStatus,
    displayName: String(data.display_name),
    headline: (data.headline as string | null) ?? "",
    bio: (data.bio as string | null) ?? "",
    city: (data.city as string | null) ?? "",
    region: (data.region as string | null) ?? "",
    country: (data.country as string | null) ?? "",
    websiteUrl: (data.website_url as string | null) ?? "",
    contactEmail: (data.contact_email as string | null) ?? "",
    fieldVisibility: parseFieldVisibility(data.field_visibility),
  };
});

/** How many of its own published profiles the "Send from" choice lists (G6). */
export const OWN_PROFILES_LIMIT = 100;

/** One of this organisation's own PUBLISHED profiles, as the "Send from"
 *  picker (components/network/connect-button.tsx, Task 4) needs it. */
export interface OwnPublishedProfile {
  id: string;
  displayName: string;
  entityKind: NetworkEntityKind;
}

/**
 * This organisation's own live, PUBLISHED profiles -- Q78's "at least one
 * published profile of the sender's". `connect-button.tsx` uses the length of
 * this list to decide whether the request control is offered at all (empty
 * means "publish one first", the refusal-that-teaches this task's brief
 * requires), and its contents to build the "Send from" choice when there is
 * more than one.
 *
 * DRAFTS EXCLUDED (`status = 'published'`): a draft profile is not a
 * legitimate `from_network_profile_id` -- the INSERT policy's own inline
 * `exists` requires `status = 'published'` on both ends (20260904003000), so
 * offering a draft here would be a choice the database refuses a moment
 * later. Reads `network_profiles` filtered to `organisation_id =
 * organisationId`, the caller's own row through the SELECT (own) policy,
 * exactly as `loadNetworkProfileForEntity` does -- never the directory.
 */
export async function loadOwnPublishedProfiles(
  organisationId: string,
): Promise<{ profiles: OwnPublishedProfile[]; more: boolean }> {
  const supabase = await createClient();
  // G6: the first OWN_PROFILES_LIMIT by name, and `more` when there are others,
  // so the "Send from" choice says it is partial instead of going quiet.
  const { data, error } = await supabase
    .from("network_profiles")
    .select("id, display_name, entity_kind")
    .eq("organisation_id", organisationId)
    .eq("status", "published")
    .is("deleted_at", null)
    .order("display_name", { ascending: true })
    .limit(OWN_PROFILES_LIMIT + 1);

  if (error || !data) {
    if (error) {
      console.error(
        `[network] own-published-profiles lookup failed for org ${organisationId}:`,
        error.message,
      );
    }
    // Fail closed to "nothing to send from" -- the safe direction for a
    // control whose empty state is "publish a profile first", not a crash.
    return { profiles: [], more: false };
  }
  return {
    profiles: data.slice(0, OWN_PROFILES_LIMIT).map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      entityKind: row.entity_kind as NetworkEntityKind,
    })),
    more: data.length > OWN_PROFILES_LIMIT,
  };
}

/**
 * This organisation's own private record's current `name`, for the editor's
 * "View the record" link -- a courtesy, not a control. `null` when the record
 * is gone (deleted, or somehow no longer this organisation's), in which case
 * the editor renders no link rather than a broken one.
 */
export async function loadEntityName(
  organisationId: string,
  entityKind: NetworkEntityKind,
  entityId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(ENTITY_TABLE[entityKind])
    .select("name")
    .eq("id", entityId)
    .eq("organisation_id", organisationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return String(data.name);
}
