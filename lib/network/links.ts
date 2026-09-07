"use server";

// Network links: create and remove. Q82.
//
// A link is one organisation's private note that a network identity is the same
// entity as one of its own records -- "this Beta Bookings profile is the agency
// already in my address book". Two things about it decide the whole module.
//
// ===========================================================================
// 1. IT IS PRIVATE TO THE LINKING ORGANISATION, AND THERE IS NO OTHER SIDE
// ===========================================================================
// The profile's owner is never told, there is no notification, no reciprocal
// row, and NO POLICY giving them any read of public.network_links
// (20260904003000). Knowing who has filed you in their CRM is itself
// commercially sensitive information, and it is not the network's to disclose.
//
// THAT MEANS THIS MODULE HAS NO "NOTIFY" STEP AND MUST NEVER GROW ONE. The
// absence is the control, and it is asserted rather than trusted:
// rls_phase6_network.sql § NS4 asserts the SELECT policy's body contains no
// occurrence of `network_profiles` at all, and § NL4 drives it behaviourally --
// the profile's owner reads zero links to their own profile, with the linking
// organisation's own read as the paired control.
//
// ===========================================================================
// 2. LINKING IS NOT CONNECTING, AND THE TWO MUST NOT BE CONFLATED
// ===========================================================================
// A link unlocks NOTHING. It does not send a request, it does not resolve a
// single `connections`-level field, and it grants no access to anything. It is
// a pointer the linking organisation keeps for its own use, so that its private
// record and the network identity can be shown side by side.
//
// The two share a permission key (manage_network_connections, Q77) because they
// are the same job in a user's head -- "wire my CRM up to the network" -- and
// they share the tier gate for the same reason. They share nothing else, and
// the copy in this file is careful never to say "connected".
//
// ===========================================================================
// WHAT THE DATABASE CHECKS THAT THIS FILE DOES NOT
// ===========================================================================
// The INSERT policy carries four terms and none of them is re-implemented here:
// the role, the tier, `private.entity_is_manageable(private_entity_type,
// private_entity_id, organisation_id)` on the polymorphic private end, and an
// inline `exists` that the target profile is PUBLISHED and LIVE. In particular
// there is NO application pre-check that the private record is manageable,
// deliberately: a pre-check read through the caller's own client would answer
// "I cannot see it" for a record-scoped user and turn a legitimate link into a
// confusing refusal -- the artists-end argument 20260901011000 makes for
// event_lineup, applied to the same shape of problem.

import { revalidatePath } from "next/cache";
import { getCurrentUser, getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { getNetworkConnectionAccess } from "@/lib/network/access";
import {
  isNetworkEntityKind,
  NETWORK_ENTITY_URL_SEGMENT,
  type NetworkEntityKind,
} from "@/lib/network/fields";

/**
 * Resolve the organisation and check CONNECTION write access.
 *
 * The same gate sending and accepting use (getNetworkConnectionAccess), for the
 * reason the header gives: linking and connecting are one job to a user, so
 * they share a key and a tier. Kept as its own local function rather than
 * imported from lib/network/connections.ts because that module is
 * `"use server"` -- every export of it is a server action, so a shared helper
 * could not live there.
 */
async function authoriseLinks(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };

  const access = await getNetworkConnectionAccess(org);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * Both routes a link write changes -- ADDED BY TASK 4.
 *
 * When this action module shipped in Task 1, the only place a link could be
 * seen was the network hub (`/${org.slug}/network`), so that was the only
 * path revalidated. Task 4 built the actual UI (`linked-identity.tsx` /
 * `link-picker.tsx`) on the private record's OWN detail page instead
 * (companies/[id], artists/[id], venues/[id], agencies/[id]) and on the hub's
 * new "Your linked records" list -- so a link created or removed there now
 * also revalidates the entity page whose identity row it changes.
 * `NETWORK_ENTITY_URL_SEGMENT` is the same shared map the profile page and
 * `linked-identity.tsx` use, so this cannot drift from where the UI actually
 * lives (Constraint 19).
 */
function revalidateLinkSurfaces(
  orgSlug: string,
  entityType: NetworkEntityKind,
  entityId: string,
) {
  revalidatePath(`/${orgSlug}/network`);
  revalidatePath(`/${orgSlug}/${NETWORK_ENTITY_URL_SEGMENT[entityType]}/${entityId}`);
}

/**
 * Create a link from a private record to a published network profile.
 *
 * `networkProfileId` comes from the directory, where it is the ONLY identifier
 * the masking view exposes -- neither view projects organisation_id or
 * entity_id, so this is the whole of what Task 3's UI can hand over, which is
 * the design working rather than a limitation.
 */
export async function createNetworkLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseLinks(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const networkProfileId = field(formData, "networkProfileId");
  const privateEntityType = field(formData, "privateEntityType");
  const privateEntityId = field(formData, "privateEntityId");

  // The private end's TYPE is checked against the vocabulary here so a
  // hand-crafted post naming `contact` (which the CHECK rejects -- a contact is
  // a person in an address book, not an industry identity, Q74) is refused
  // before any statement runs rather than surfacing as a raw 23514. The ID and
  // the profile id are hidden fields: a missing one is structural, so
  // FAILED_MESSAGE rather than a field error.
  if (!networkProfileId || !privateEntityId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!isNetworkEntityKind(privateEntityType)) {
    return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
  }

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { error } = await supabase.from("network_links").insert({
    organisation_id: org.id,
    network_profile_id: networkProfileId,
    private_entity_type: privateEntityType,
    private_entity_id: privateEntityId,
    // Explicit, though the column defaults to auth.uid(); same discipline as
    // every other created_by in the codebase.
    created_by: user.id,
  });

  if (error) {
    // 23505 is network_links_unique: this pair is already linked. A better
    // sentence than "refused", because nothing is wrong -- the user has already
    // done the thing they are asking for.
    if (error.code === "23505") {
      return {
        error: "That record is already linked to this profile.",
        values: echoedValues(formData),
      };
    }
    // 42501 is the RLS refusal, and its most likely actionable cause is the
    // inline `exists`: the profile has been unpublished or deleted since the
    // directory page was loaded. The others (tier, role, an unmanageable
    // private record) are not distinguishable from the client, and telling them
    // apart would be the oracle lib/crm/write.ts declines to build.
    if (error.code === "42501") {
      return {
        error:
          "That profile can’t be linked from here — it may have been unpublished. Reload the network directory and try again.",
        values: echoedValues(formData),
      };
    }
    console.error("[network] create network link failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidateLinkSurfaces(org.slug, privateEntityType, privateEntityId);
  return {
    message: "Linked. This profile now shows against your own record.",
  };
}

/**
 * Remove a link.
 *
 * A SOFT DELETE, like every other delete in this schema: `deleted_at` moves and
 * the row stays. There is no DELETE grant and no DELETE policy on
 * public.network_links.
 *
 * The partial unique index (`where deleted_at is null`) means a removed link
 * does not block re-linking the same pair later, which is why removing is safe
 * to offer as a plain button rather than behind a confirmation: it costs
 * nothing and is fully reversible by doing it again.
 */
export async function removeNetworkLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseLinks(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const linkId = field(formData, "linkId");
  if (!linkId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  // TASK 4, REVALIDATION ONLY -- NEVER AUTHORISATION. `linked-identity.tsx`
  // (the only caller, rendered on the private record's own detail page) hands
  // these back as hidden fields so the correct entity page can be
  // revalidated without a second SELECT of the link row this action is about
  // to soft-delete. The actual write below is still scoped by
  // `organisation_id = org.id` and `id = linkId` alone -- these two values
  // decide NOTHING about whether the write is permitted, only which extra
  // path gets revalidated on success, and an invalid or absent pair simply
  // means one fewer path is revalidated (the hub still is).
  const entityType = field(formData, "privateEntityType");
  const entityId = field(formData, "privateEntityId");

  const supabase = await createClient();
  const result = await commitWrite(`remove network link ${linkId}`, () =>
    supabase
      .from("network_links")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", linkId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    if (isNetworkEntityKind(entityType) && entityId) {
      revalidateLinkSurfaces(org.slug, entityType, entityId);
    } else {
      revalidatePath(`/${org.slug}/network`);
    }
  }
  return stateFor(
    result,
    "Unlinked. You can link them again at any time.",
    formData,
  );
}
