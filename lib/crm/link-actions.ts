"use server";

// The two writes on the four *_links tables: attach a CRM record to a
// task/meeting/note (and, from Task 6, a document), and detach it.
//
// ===========================================================================
// WHERE AUTHORISATION HAPPENS, AND WHERE THE TARGET IS CHECKED
// ===========================================================================
// `addLinkAction` authorises on the PARENT's key -- linking a task to an event
// is a `manage_tasks` write, not a `manage_events` one (the plan's Q22 model and
// Task 2 § OF). The application then leaves the TARGET end to the database: the
// INSERT policy calls `private.entity_is_visible(entity_type, entity_id, org)`,
// so a link to a record the caller cannot see is refused as a 42501 whatever
// this file does. The app half is a good sentence, not the control.
//
// `liveInOrg` on the PARENT gives the refusal its sentence: a link write onto a
// soft-deleted task is refused by the policy (`p.deleted_at is null` in the
// via-parent policy, Task 2 § OF7) as an `ok(0)`/42501, which would otherwise
// reach the user as the vague REFUSED_MESSAGE. The target end gets no such
// pre-check on purpose -- its liveness/visibility is the polymorphic policy's,
// and a pre-check here would be a second, weaker copy of it.
//
// ADD IS AN INSERT (a refusal is a loud 403); REMOVE IS A SOFT-DELETE through
// write.ts with { count: "exact" }, so a removal that matched no row is a
// refusal, never a success (a 204 is not a save).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, liveInOrg, refusedEndState } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import {
  isLinkParent,
  parseLinkTarget,
  PERMISSION_FOR_LINK_PARENT,
  type LinkParent,
} from "@/lib/crm/links";

/** The parent table -> its link table. Local, because queries.ts's copy is not exported. */
const LINK_TABLE: Record<LinkParent, string> = {
  tasks: "task_links",
  meetings: "meeting_links",
  notes: "note_links",
  documents: "document_links",
};

/** Where the parent record's detail page lives, for revalidation. */
const PARENT_PATH: Record<LinkParent, string> = {
  tasks: "tasks",
  meetings: "meetings",
  notes: "notes",
  documents: "documents",
};

export async function addLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parentTable = field(formData, "parentTable");
  if (!isLinkParent(parentTable)) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    PERMISSION_FOR_LINK_PARENT[parentTable],
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parentId = field(formData, "parentId");
  if (!parentId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const target = parseLinkTarget(field(formData, "target"));
  if (target === null) {
    return {
      fieldErrors: { target: "Choose a record to link to." },
      values: echoedValues(formData),
    };
  }

  const supabase = await createClient();

  // The PARENT end, for the sentence. A link onto a deleted parent is refused
  // by the policy too (Task 2 § OF7); this turns the vague refusal into the
  // one about the record being gone.
  const presence = await liveInOrg(supabase, parentTable, org.id, parentId);
  const blocked = refusedEndState([presence], formData);
  if (blocked) return blocked;

  const { error } = await supabase.from(LINK_TABLE[parentTable]).insert({
    organisation_id: org.id,
    parent_id: parentId,
    entity_type: target.entityType,
    entity_id: target.entityId,
  });

  if (error) {
    // The live-unique index (`<x>_links_live_unique`) -- already linked. Not a
    // fault and not a conflict: it is the answer, so it reads as one.
    if (error.code === "23505") {
      return {
        fieldErrors: { target: "That record is already linked." },
        values: echoedValues(formData),
      };
    }
    // 42501: the target is not visible to this caller (or the parent's own
    // gate refused). 23514/23503: a forged type or a target that is not a real
    // tenant row. All are refusals the user cannot act on beyond choosing
    // something else.
    if (error.code === "42501" || error.code === "23514" || error.code === "23503") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[crm] add link failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // The parent's page (the link list) and the target's page (its related
  // panel) both change.
  revalidatePath(`/${org.slug}/${PARENT_PATH[parentTable]}/${parentId}`);
  return { message: "Linked." };
}

export async function removeLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parentTable = field(formData, "parentTable");
  if (!isLinkParent(parentTable)) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const auth = await authoriseOrg(
    field(formData, "orgSlug"),
    formData,
    PERMISSION_FOR_LINK_PARENT[parentTable],
  );
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const linkId = field(formData, "linkId");
  const parentId = field(formData, "parentId");
  if (!linkId || !parentId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const result = await commitWrite(`remove ${parentTable} link ${linkId}`, () =>
    supabase
      .from(LINK_TABLE[parentTable])
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", linkId)
      // Scope to the parent too, so a link id from another parent cannot be
      // soft-deleted through this form. The composite FK and the policy both
      // back this; the term is the app's own belt.
      .eq("parent_id", parentId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/${PARENT_PATH[parentTable]}/${parentId}`);
    return { message: "Link removed." };
  }
  // count === 0 is a refusal, not a success -- the row was already gone, or the
  // caller may not write it.
  return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
}
