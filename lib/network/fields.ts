// THE NETWORK FIELD VOCABULARY, AND NOTHING ELSE.
//
// `network_profiles_visibility_vocabulary` and the CHECK behind it,
// private.network_visibility_is_valid() (supabase/migrations/
// 20260904000000_network_tables.sql), are the ENFORCEMENT -- a key or a level
// outside these sets is a 23514 at write time, for every writer including one
// that reaches PostgREST directly with the anon key. These constants exist
// because a request cannot consult a CHECK constraint: Task 2's publish editor
// and Task 3's result card both have to render and validate before any
// statement runs.
//
// BOUND TO THE DATABASE, NOT TRUSTED:
// tests/integration/network/field-vocabulary-matches-db.test.ts reads the CHECK
// and the function body out of the live catalog and asserts each set equals the
// tuple below. That is the `tiers-match-db` pattern, and the reason it is the
// pattern: a test comparing this file to a SECOND HARDCODED OBJECT written in
// the test file would prove nothing at all -- it would restate the same
// literals twice and stay green after someone widened the CHECK in a migration
// and forgot this file. Adding a field in a migration without adding it here
// turns that test red naming this file, and vice versa.
//
// DELIBERATELY DATA + PRESENTATION, NO REACT -- mirrors lib/crm/task-status.ts
// and lib/crm/finance-category.ts. A tone is a NAME; the chip component (Task
// 2) maps the name to a DESIGN.md token, so this module stays importable from a
// Server Component, a Client Component and a vitest file alike.
//
// NOT `"use server"`. Every export of a `"use server"` module becomes a server
// action, which would make this vocabulary unreachable from a Client Component
// and from a unit test alike. It is PURE, and that is load-bearing.

// ===========================================================================
// THE TWO SETS THE DATABASE ENFORCES
// ===========================================================================

/**
 * The three visibility levels a publishable field can carry. Q71.
 *
 * `hidden` is the default for every field, and it is not merely a read-time
 * mask: N3 requires that a hidden field stores NULL in its value column, which
 * `network_profiles_hidden_fields_are_null` enforces. A masked-but-stored value
 * is one policy bug away from a leak; a NULL is not.
 *
 * THE ORDER IS THE ESCALATION ORDER, least to most exposed, and it is the order
 * the editor's radio group reads in. That is deliberate: the control whose
 * misreading publishes someone's address should read as a ladder, not as an
 * arbitrary list.
 */
export const VISIBILITY_LEVELS = ["hidden", "connections", "network"] as const;

export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/**
 * The seven fields whose visibility a publisher chooses. Q71.
 *
 * These are exactly the keys `private.network_visibility_is_valid()` accepts,
 * and exactly the columns `network_profiles_hidden_fields_are_null` constrains.
 * They are also the seven that both masking views mask -- so a field added here
 * without a `case when` arm in 20260904004000 would be published unmasked, and
 * the vocabulary test plus the view's own column-list assertion are what catch
 * that.
 *
 * The ORDER is the form's order (identity, then place, then how to reach them),
 * which is this file's to choose; the test sorts before comparing, because what
 * has to match the database is the SET.
 */
export const PUBLISHABLE_FIELDS = [
  "headline",
  "bio",
  "city",
  "region",
  "country",
  "website_url",
  "contact_email",
] as const;

export type PublishableField = (typeof PUBLISHABLE_FIELDS)[number];

/**
 * The two fields that are ALWAYS network-visible and have no level at all. Q71.
 *
 * `display_name` and `entity_kind` are projected unconditionally by both views
 * -- a profile with no name and no kind is not a discoverable identity, so
 * there is nothing to publish. They are therefore REJECTED as keys by
 * private.network_visibility_is_valid(), which is the point rather than an
 * omission: A LEVEL THAT CANNOT BE SET CANNOT BE MIS-SET.
 *
 * The editor renders them as fixed "Always shown" rows rather than omitting
 * them, because a user deciding what to publish needs to see everything that
 * will be published -- including the parts they do not control.
 */
export const ALWAYS_NETWORK_FIELDS = ["display_name", "entity_kind"] as const;

export type AlwaysNetworkField = (typeof ALWAYS_NETWORK_FIELDS)[number];

/**
 * The four kinds of private record a network profile can speak for. Q74.
 *
 * Mirrors `network_profiles_entity_kind_check`. CONTACTS ARE ABSENT ON PURPOSE:
 * a contact is a PERSON inside someone's address book, and publishing a
 * person's details as an industry identity is a consent question this MVP does
 * not answer.
 */
export const NETWORK_ENTITY_KINDS = [
  "company",
  "artist",
  "venue",
  "agency",
] as const;

export type NetworkEntityKind = (typeof NETWORK_ENTITY_KINDS)[number];

/**
 * The two states a profile can be in. Q81.
 *
 * Mirrors `network_profiles_status_check`. A profile is a draft until it is
 * published; publishing is the act that makes it discoverable, and it is
 * reversible.
 */
export const PROFILE_STATUSES = ["draft", "published"] as const;

export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/**
 * The four states a connection request can be in. Q79.
 *
 * Mirrors `network_connection_requests_status_check`. `declined` is TERMINAL;
 * `withdrawn` frees the pair for exactly one retry. The transition guard
 * (private.network_request_status_transition_guard) makes all three terminal
 * states immutable once reached.
 */
export const CONNECTION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "withdrawn",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * A profile's field -> level map, as it is stored and as the editor edits it.
 *
 * PARTIAL BY CONSTRUCTION. An absent key means `hidden` -- both masking views
 * test for an exact level string, so a missing key yields NULL there, and
 * `network_profiles_hidden_fields_are_null` coalesces an absent key to
 * `'hidden'` for exactly the same reason. `visibilityOf()` below is the one
 * place that reading is written down.
 */
export type FieldVisibility = Partial<Record<PublishableField, VisibilityLevel>>;

// ===========================================================================
// THE PRESENTATION LAYER
// ===========================================================================
// Labels and chip TONES, in the same file as the constants they describe --
// exactly as finance-category.ts holds its labels beside its vocabularies.
// Still NO REACT.
//
// EVERY MAP IS A `Record` KEYED ON ITS UNION, so a value added to the CHECK and
// to the constant above makes the missing label and tone a COMPILE error here
// rather than an empty chip in a browser nobody opened.
//
// NO NEW COLOUR TOKEN. Every tone below is one DESIGN.md has already measured,
// so `python scripts/contrast.py` gains no row and stays at 16.

/**
 * The chip tones a network state can carry, as NAMES.
 *
 * The same tone vocabulary as lib/crm/finance-category.ts's FinanceTone, so the
 * network chips draw from the identical DESIGN.md token set and no new colour
 * is introduced. `active` is the accent BORDER with ink text (never accent
 * text, which DESIGN.md forbids); `muted` is the hairline-and-grey neutral.
 */
export type NetworkTone = "active" | "muted" | "success" | "warning" | "danger";

/**
 * The three levels as a publisher reads them.
 *
 * SENTENCE CASE AND EXPLICIT ABOUT AUDIENCE, because this is the most
 * consequential control in the product: "Network" and "Connections" mean
 * nothing on their own, and a user misreading them publishes their address.
 * The editor renders these labels beside a longer description (Task 2); these
 * are the chip-length forms.
 */
export const VISIBILITY_LABELS: Record<VisibilityLevel, string> = {
  hidden: "Hidden",
  connections: "Connections only",
  network: "Everyone on the network",
};

/**
 * The tone a level carries.
 *
 *   muted     hidden       -- not published; the neutral resting state.
 *   active    connections  -- published, but gated behind an accepted
 *                             connection. The accent rail marks the middle rung.
 *   warning   network      -- published to every logged-in customer of the
 *                             product. This is the one that needs to catch the
 *                             eye, and `warning` rather than `success` is
 *                             deliberate: publishing is not an achievement to
 *                             be congratulated, it is an exposure to be noticed.
 *
 * DESIGN.md § Working palette forbids colour-only status, and this vocabulary
 * needs a NON-COLOUR CUE more than any other in the product -- the chip always
 * carries its LABEL, and Task 2's editor additionally renders the levels as a
 * labelled radio ladder rather than as coloured dots.
 */
export const VISIBILITY_TONE: Record<VisibilityLevel, NetworkTone> = {
  hidden: "muted",
  connections: "active",
  network: "warning",
};

/** The seven publishable fields as a human reads them. */
export const PUBLISHABLE_FIELD_LABELS: Record<PublishableField, string> = {
  headline: "Headline",
  bio: "About",
  city: "City",
  region: "Region",
  country: "Country",
  website_url: "Website",
  contact_email: "Contact email",
};

/** The two always-visible fields as a human reads them. */
export const ALWAYS_NETWORK_FIELD_LABELS: Record<AlwaysNetworkField, string> = {
  display_name: "Name",
  entity_kind: "Type",
};

/** The four entity kinds as a human reads them. */
export const NETWORK_ENTITY_KIND_LABELS: Record<NetworkEntityKind, string> = {
  company: "Company",
  artist: "Artist",
  venue: "Venue",
  agency: "Agency",
};

/** The two profile states as a human reads them. Q81. */
export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  draft: "Draft",
  published: "Published",
};

/**
 * The tone a profile state carries.
 *
 *   muted    draft      -- nobody outside this workspace can see it.
 *   warning  published  -- every logged-in customer can. Same reasoning as
 *                          VISIBILITY_TONE.network: the published state is the
 *                          one worth noticing, not the one worth celebrating.
 */
export const PROFILE_STATUS_TONE: Record<ProfileStatus, NetworkTone> = {
  draft: "muted",
  published: "warning",
};

/** The four request states as a human reads them. Q79. */
export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  pending: "Pending",
  accepted: "Connected",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/**
 * The tone a request state carries.
 *
 *   active   pending    -- waiting on somebody; the accent rail marks the row
 *                          that still needs an answer.
 *   success  accepted   -- the connection exists. THIS one IS an achievement.
 *   danger   declined   -- terminal, and the pair cannot be retried (Q79).
 *   muted    withdrawn  -- retracted by the sender; the pair is free again.
 */
export const CONNECTION_STATUS_TONE: Record<ConnectionStatus, NetworkTone> = {
  pending: "active",
  accepted: "success",
  declined: "danger",
  withdrawn: "muted",
};

// ===========================================================================
// THE PREDICATES
// ===========================================================================

/**
 * True iff `value` is a field whose visibility a publisher may set.
 *
 * THE NAME MATTERS: it is `isPublishableField`, not `isNetworkField`, because
 * `display_name` and `entity_kind` are network fields and are NOT publishable
 * -- they have no level to set. Every action in lib/network/profiles.ts filters
 * submitted visibility keys through this before writing, so a hand-crafted form
 * post naming `display_name` (or `phone`, or anything else) is dropped in the
 * request rather than reaching the CHECK as a raw 23514.
 */
export function isPublishableField(
  value: string | null,
): value is PublishableField {
  return (
    value !== null && (PUBLISHABLE_FIELDS as readonly string[]).includes(value)
  );
}

/** True iff `value` is a level the database will accept. */
export function isVisibilityLevel(
  value: string | null,
): value is VisibilityLevel {
  return (
    value !== null && (VISIBILITY_LEVELS as readonly string[]).includes(value)
  );
}

/** True iff `value` is an entity kind a profile may speak for. Q74. */
export function isNetworkEntityKind(
  value: string | null,
): value is NetworkEntityKind {
  return (
    value !== null &&
    (NETWORK_ENTITY_KINDS as readonly string[]).includes(value)
  );
}

/** True iff `value` is a profile status the database will accept. Q81. */
export function isProfileStatus(value: string | null): value is ProfileStatus {
  return (
    value !== null && (PROFILE_STATUSES as readonly string[]).includes(value)
  );
}

/** True iff `value` is a connection status the database will accept. Q79. */
export function isConnectionStatus(
  value: string | null,
): value is ConnectionStatus {
  return (
    value !== null &&
    (CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The level a field is at, reading an ABSENT key as `hidden`.
 *
 * THE ONE PLACE THAT READING IS WRITTEN DOWN, and it agrees with the database
 * in both directions: `network_profiles_hidden_fields_are_null` coalesces a
 * missing key to `'hidden'`, and both masking views test for an exact level
 * string so a missing key yields NULL there too. Every renderer and every
 * action goes through this rather than indexing the map, so "the key is
 * missing" can never be shown as an empty chip.
 */
export function visibilityOf(
  visibility: FieldVisibility | null | undefined,
  field: PublishableField,
): VisibilityLevel {
  return visibility?.[field] ?? "hidden";
}

/**
 * Read an arbitrary stored `field_visibility` value into the typed map.
 *
 * DEFENSIVE ABOUT SHAPE AS WELL AS VOCABULARY, for lib/crm/urls.ts's
 * `parseSocials` reason: the column is jsonb, PostgREST hands it back as
 * `unknown`, and although the CHECK constrains what can be STORED, this
 * function is also what a test fixture and a future import path flow through.
 * An unknown key or an unknown level is DROPPED rather than carried, which is
 * the fail-closed direction here -- a dropped key reads as `hidden`.
 *
 * PURE, so the round trip is a unit test rather than a browser walk.
 */
export function parseFieldVisibility(raw: unknown): FieldVisibility {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FieldVisibility = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPublishableField(key)) continue;
    if (typeof value !== "string" || !isVisibilityLevel(value)) continue;
    out[key] = value;
  }
  return out;
}
