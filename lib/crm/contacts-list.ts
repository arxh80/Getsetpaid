import { defineListSpec } from "@/lib/list/spec";

// The Contacts list specification.
//
// This is the file Task 4 copies four times, so the shape matters more than
// the contents. Every field that could be treated as paperwork is one that
// changes behaviour, and each is justified where it sits.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` is selected even though nothing renders it, because the
 * "Owner: mine" filter and the RLS record-scope term both key on it and a
 * later reviewer should be able to see that the page had it in hand. It is
 * NOT rendered: showing which colleague owns a record is a members-directory
 * question, and `profiles` would need a second query with its own visibility
 * rules (see the members page's note on why an embed is impossible here).
 *
 * `socials` and `tags` are deliberately absent. They are the two columns that
 * carry unvalidated user content -- `socials` values have no constraint at all
 * (20260827232510) and URL-protocol validation is an open Task 4 item in
 * FOLLOW-UPS.md -- so a list that does not select them cannot be the surface
 * that renders a `javascript:` URL.
 */
export const CONTACT_SELECT =
  "id, name, email, phone, title, location, owner_user_id, updated_at";

export interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  location: string | null;
  updatedAt: string;
}

export const CONTACT_LIST = defineListSpec({
  entity: "contacts",
  noun: { one: "contact", many: "contacts" },

  // PRD § 6.2 makes `name` the identity of a contact, and it is the only
  // NOT NULL free-text column on the table. Searching email as well would
  // need a second `or` branch whose value is user text in a logic tree -- the
  // grammar lib/list/postgrest.ts exists to get right -- and there is no
  // measurement yet saying it plans acceptably. Task 4 can add it with one.
  searchColumn: "name",
  searchLabel: "Search by name",

  sort: {
    // `name` is NOT NULL (`check (btrim(name) <> '')` on top of it), so the
    // keyset comparison can never hit a NULL.
    name: {
      column: "name",
      label: "Name",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      notNull: true,
      backedBy: "contacts_org_name_id_live_idx",
    },
    // `updated_at` is NOT NULL and, since 20260828121500, is maintained by a
    // trigger and NOT client-writable -- which is what makes it safe to order
    // by. Before that trigger a client could PATCH an arbitrary timestamp
    // through PostgREST and pin its own records to the top of every
    // colleague's "recently updated" list.
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      // Not "Z–A". See SortOption.directionLabels: a date column read as
      // an alphabet is a line the reader has to decode rather than read.
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "contacts_org_updated_at_id_live_idx",
    },
    // NOT `email`. It is the obvious third sort for a contacts list and it is
    // NULLABLE, which silently breaks keyset pagination -- see
    // lib/list/spec.ts's `notNull`. NOT `created_at` either: it has no index
    // and `backedBy` has nowhere honest to point.
  },
  defaultSort: "name",

  filters: {
    // ONE filter, and it is a real one rather than three invented ones.
    //
    // "Mine" is the query a booker actually runs, and it is the only filter
    // whose meaning is identical across all five entities Task 4 will build,
    // so it is the right one to prove the mechanism with. The mechanism is
    // plural (`filters` is a record, the toolbar renders N of them); the
    // contents are not, because a filter nobody asked for is a control that
    // has to be maintained forever.
    //
    // NOTE FOR EVERY ENTITY: the first choice must be the one that filters
    // nothing. A list whose default state hides rows misreports how many
    // records the organisation has, and the count line above the table would
    // be quietly wrong.
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type ContactSortKey = keyof (typeof CONTACT_LIST)["sort"];
export type ContactFilterKey = keyof (typeof CONTACT_LIST)["filters"];
