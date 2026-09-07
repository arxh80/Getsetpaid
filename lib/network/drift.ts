// Q75's drift affordance: "the published copy of this record differs from
// what is here now." Pure comparison, no React and no query -- the four
// detail pages call this over TWO OBJECTS THEY ALREADY LOADED SEPARATELY (the
// private record, and this organisation's own network_profiles row for it),
// which is what the brief means by "inside the server component that already
// loads both" and why this file introduces no database path from
// network_profiles to a private table: there isn't one here to introduce.
//
// ===========================================================================
// WHAT "DRIFT" CAN EVEN MEAN, GIVEN Q75
// ===========================================================================
// A network profile carries its OWN COPY of every published value (Q75) --
// never a pointer into the private record -- so editing the private record
// does NOT silently republish anything (20260904000000's header, in as many
// words). That is a feature, not a bug: a publisher may deliberately want the
// network-facing "About" to read differently from the private notes. So drift
// is not "are these the same field" in general; it is narrower and more
// honest: for the HANDFUL of columns that share an obvious identity between a
// private record and its profile (a company's name IS its display name), has
// the private side moved since the profile was written down.
//
// THE FOUR PRIVATE TABLES DO NOT SHARE ONE SHAPE. companies and agencies have
// only `name`; artists have name/country/city/website; venues have name/
// website and no `city` column at all (their free-text `location` is not the
// same thing as a network `city` and comparing them would manufacture false
// drift). So the comparison is PER FIELD, each one only checked when BOTH
// sides have a column for it -- `undefined` on the entity snapshot means "this
// kind has no such column", and it is skipped rather than compared against
// null.
//
// A HIDDEN PUBLISHED FIELD IS NOT "DRIFTED", EVER. `network_profiles_hidden_
// fields_are_null` (N3) means a hidden field's stored value is NULL
// regardless of what the private record says today -- there is nothing
// published to go stale. So every publishable-field comparison below is
// skipped when the profile's stored value is null, and only `displayName` (an
// ALWAYS_NETWORK_FIELD, never hidden) is compared unconditionally.

import { normaliseWebsite } from "@/lib/crm/urls";

/** The private record's own values, for the columns THIS KIND actually has.
 *  `undefined` (not `null`) means "no such column on this table" -- see the
 *  header on why that distinction matters. */
export interface EntitySnapshot {
  name: string;
  country?: string | null;
  city?: string | null;
  website?: string | null;
}

/** The stored profile's own values, exactly as loadNetworkProfileForEntity
 *  reads them back. `null` on a publishable field means hidden (N3) or never
 *  set -- both read the same way here, and both mean "nothing to compare". */
export interface ProfileSnapshot {
  displayName: string;
  country: string | null;
  city: string | null;
  websiteUrl: string | null;
}

/**
 * A rough same-site comparison for `website`/`website_url`, tolerant of the
 * scheme and trailing-slash differences a private free-text column and a
 * normalised profile column would otherwise disagree about even when a human
 * would call them the same address.
 *
 * Routes BOTH sides through `normaliseWebsite` -- the SAME function
 * lib/network/profiles.ts already applies to a submitted website_url, so the
 * profile side's shape is exactly what that function produces and this is a
 * like-for-like comparison rather than a second, divergent parser. A private
 * value that fails to normalise (free text that isn't a URL at all) falls
 * back to a raw string compare, because "unparseable" and "unparseable in a
 * new way" are not drift.
 */
function sameWebsite(a: string, b: string): boolean {
  const na = normaliseWebsite(a);
  const nb = normaliseWebsite(b);
  if (na.ok && nb.ok) return na.value === nb.value;
  return a === b;
}

/**
 * True iff the private record has changed, on at least one comparable field,
 * since the profile's stored copy was written.
 *
 * Field by field, and EVERY comparison is short-circuited by two guards: the
 * private column has to exist on this kind (`!== undefined`), and the
 * profile's own value has to be something other than null (hidden/unset).
 * `displayName` is the one unconditional comparison, because it is an
 * ALWAYS_NETWORK_FIELD (lib/network/fields.ts) and can never be null on a
 * live profile -- `network_profiles.display_name` is NOT NULL.
 */
export function profileHasDrifted(
  entity: EntitySnapshot,
  profile: ProfileSnapshot,
): boolean {
  if (entity.name !== profile.displayName) return true;
  if (
    entity.country !== undefined &&
    profile.country !== null &&
    entity.country !== profile.country
  ) {
    return true;
  }
  if (
    entity.city !== undefined &&
    profile.city !== null &&
    entity.city !== profile.city
  ) {
    return true;
  }
  if (entity.website !== undefined && profile.websiteUrl !== null) {
    // `entity.website === null` means the private column HAS the concept but
    // is currently empty -- itself a real drift against a profile that still
    // carries a published website, so it does not fall through to
    // `sameWebsite`, which requires two strings.
    const changed =
      entity.website === null || !sameWebsite(entity.website, profile.websiteUrl);
    if (changed) return true;
  }
  return false;
}
