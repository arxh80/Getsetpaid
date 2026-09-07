"use server";

// Notes: create, edit, soft-delete, restore.
//
// The five-step shape (lib/crm/events.ts / lib/crm/tasks.ts), with two things
// specific to a note:
//
//   * VISIBILITY IS PASSED THROUGH, NOT ENFORCED HERE. `private` vs `company`
//     is the PRD's binary and the DATABASE governs reads: `notes_select_by_visibility`
//     (20260902011000) hides a private note from everyone but its author, and
//     `notes_insert_*` pins `owner_user_id = auth.uid()` for everyone (a note is
//     always authored by its writer -- no create-on-behalf-of). So this action
//     validates the value is one of the two and writes it; it does not decide
//     who sees it.
//   * THE BODY IS SANITISED (Q48) THE WAY EVERY FREE-TEXT COLUMN IN THIS
//     CODEBASE IS: trimmed, length-capped, and rendered as TEXT (React escapes
//     it; nothing uses dangerouslySetInnerHTML -- CLAUDE.md § Non-negotiable
//     rules). The one genuine strip is the NUL byte, which Postgres `text`
//     cannot store at all (22P05) -- caught here so a pasted NUL is a quiet
//     removal rather than a fault. lib/crm/validate.ts's checkLongText header
//     states the philosophy: a length cap is not a content rewrite, and
//     stripping more would silently change what the user typed.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { NOTE_VISIBILITIES, type NoteVisibility } from "@/lib/crm/task-status";

const PERMISSION = "manage_notes";

/** A note runs longer than a paragraph -- it is the free-form record slot. */
const MAX_NOTE_BODY = 20000;

function isVisibility(v: string | null): v is NoteVisibility {
  return v !== null && (NOTE_VISIBILITIES as readonly string[]).includes(v);
}

/** Strip the one character Postgres `text` cannot store (NUL). See the header. */
function sanitiseBody(value: string): string {
  return value.split(String.fromCharCode(0)).join("");
}

interface NoteValues {
  body: string;
  visibility: NoteVisibility;
}

function readNote(
  formData: FormData,
):
  | { readonly ok: true; readonly values: NoteValues }
  | { readonly ok: false; readonly state: FormState } {
  // `field` trims and maps "" -> null; the NUL strip is on top of that.
  const raw = field(formData, "body");
  const body = raw === null ? null : sanitiseBody(raw);
  const visibility = field(formData, "visibility");
  const fieldErrors: Record<string, string> = {};

  if (body === null || body === "") {
    fieldErrors.body = "Write something for the note.";
  } else if (body.length > MAX_NOTE_BODY) {
    fieldErrors.body = `That note is too long — ${MAX_NOTE_BODY.toLocaleString("en-GB")} characters at most.`;
  }
  if (!isVisibility(visibility)) {
    fieldErrors.visibility = "Choose who can see this note.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }
  return {
    ok: true,
    values: { body: body as string, visibility: visibility as NoteVisibility },
  };
}

export async function createNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readNote(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notes")
    .insert({
      organisation_id: org.id,
      // Pinned to the author for everyone -- the INSERT policy requires it and
      // a note has no create-on-behalf-of.
      owner_user_id: user.id,
      body: parsed.values.body,
      visibility: parsed.values.visibility,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    console.error("[crm] create note failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/notes`);
  redirect(`/${org.slug}/notes/${data.id as string}`);
}

export async function updateNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const noteId = field(formData, "noteId");
  if (!noteId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readNote(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  // A company note is author-only EDITABLE (Q54): the UPDATE policy re-pins
  // `owner_user_id = auth.uid()` in USING and WITH CHECK, so a non-author's
  // update matches no row and this is a refusal, not a silent no-op.
  const result = await commitWrite(`update note ${noteId}`, () =>
    supabase
      .from("notes")
      .update(
        { body: parsed.values.body, visibility: parsed.values.visibility },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", noteId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/notes`);
    revalidatePath(`/${org.slug}/notes/${noteId}`);
    redirect(`/${org.slug}/notes/${noteId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const noteId = field(formData, "noteId");
  if (!noteId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete note ${noteId}`, () =>
    supabase
      .from("notes")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", noteId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/notes`);
    revalidatePath(`/${org.slug}/notes/deleted`);
    revalidatePath(`/${org.slug}/notes/${noteId}`);
  }
  return stateFor(
    result,
    "Deleted. It is out of the notes list; its links come back with it.",
    formData,
  );
}

export async function restoreNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const noteId = field(formData, "noteId");
  if (!noteId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore note ${noteId}`, () =>
    supabase
      .from("notes")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", noteId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/notes`);
    revalidatePath(`/${org.slug}/notes/deleted`);
    revalidatePath(`/${org.slug}/notes/${noteId}`);
  }
  return stateFor(result, "Restored. It is back in the notes list.", formData);
}
