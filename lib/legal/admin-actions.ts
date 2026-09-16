"use server";

// The legal-document editor's WRITE half: four Server Actions over the four
// guarded RPCs 20260922000000 ships.
//
// NOTHING HERE IS THE ENFORCEMENT, with one exception. Each RPC carries its
// own superuser-at-aal2 guard, its own validation and its own audit write, and
// the table itself refuses every client write and every change to a published
// version. What this file adds:
//   1. STEP-UP on publishing and on recording counsel's review -- the two
//      actions that change what the public reads. `amr` freshness lives in the
//      JWT, which the database cannot see, so this is the only place it can
//      live (the same split lib/admin/overrides.ts documents). Creating and
//      editing a DRAFT is not step-up gated: a draft is invisible to everyone
//      but the superuser, and publishing it is the gated step.
//   2. Save-time validation (lib/legal/draft-validation.ts), so a refused
//      link or a missing placeholder is a sentence beside the textarea.
//   3. A sentence per refusal, and revalidatePath.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import { isSuperuser } from "@/lib/admin/superuser";
import { isLegalSlug, legalDocumentHref, type LegalSlug } from "./documents";
import { validateDraft } from "./draft-validation";

const NOT_ALLOWED =
  "That can’t be done from here. Reload the page — the document may have changed since it was opened.";

const STEP_UP_REQUIRED =
  "Confirm it’s you before changing what the public reads. Use the re-authentication prompt on this page, then try again.";

function refuse(message: string, formData: FormData, fieldErrors?: Record<string, string>): FormState {
  return { error: message, fieldErrors, values: echoedValues(formData) };
}

/** The 23514s are told apart by OUR constraint names, not by user text. */
function checkViolation(message: string): string | null {
  if (message.includes("legal_documents_body_links_allowlisted")) {
    return "A link in the text points somewhere that isn’t allowed. Links must start with https://, mailto: or a single /.";
  }
  if (message.includes("legal_documents_body_no_markup")) {
    return "The text contains an HTML tag. Use ## for headings, - for lists and **bold** for emphasis.";
  }
  if (message.includes("legal_documents_body_tokens_known")) {
    return "The text contains a {{placeholder}} the page doesn’t know.";
  }
  if (message.includes("legal_documents_body_placeholders_placed")) {
    return "A {{placeholder}} is somewhere it can’t render. Put {{subprocessors}} and {{storage_inventory}} on a line of their own, and keep placeholders out of bold text and links.";
  }
  // Also matches legal_documents_required_blocks_standalone (fix round 1).
  if (message.includes("legal_documents_required_blocks")) {
    return "This document must keep its generated placeholder.";
  }
  if (message.includes("legal_documents_title_length") || message.includes("legal_documents_body_length")) {
    return "The title or the text is empty or too long.";
  }
  return null;
}

function rpcRefusal(context: string, code: string | undefined, message: string, formData: FormData): FormState {
  if (code === "42501") return refuse(NOT_ALLOWED, formData);
  if (code === "23514") {
    const sentence = checkViolation(message);
    if (sentence) return refuse(sentence, formData);
  }
  if (code === "22023" || code === "23505") {
    if (message.includes("draft already exists") || code === "23505") {
      return refuse("There is already a draft of this document — edit that one.", formData);
    }
    if (message.includes("no draft with that id")) {
      return refuse("That draft no longer exists — it may already have been published. Reload the page.", formData);
    }
    if (message.includes("name the reviewing counsel")) {
      return refuse("Name the counsel who reviewed this version.", formData, {
        reviewer: "Name the firm or person who reviewed it.",
      });
    }
    if (message.includes("no unreviewed draft or current version")) {
      return refuse(
        "That version can’t be marked reviewed — it is superseded or already marked. Reload the page.",
        formData,
      );
    }
    if (message.includes("no published document")) return refuse(NOT_ALLOWED, formData);
  }
  console.error(`[legal] ${context} failed:`, code, message);
  return refuse(FAILED_MESSAGE, formData);
}

async function authorise(
  formData: FormData,
  { stepUp }: { stepUp: boolean },
): Promise<{ readonly ok: true; readonly slug: LegalSlug } | { readonly ok: false; readonly state: FormState }> {
  if (!(await getCurrentUser())) return { ok: false, state: refuse(FAILED_MESSAGE, formData) };
  if (!(await isSuperuser())) return { ok: false, state: refuse(NOT_ALLOWED, formData) };
  const slug = field(formData, "slug");
  if (!isLegalSlug(slug)) return { ok: false, state: refuse(NOT_ALLOWED, formData) };
  if (stepUp && !(await checkStepUp())) {
    return { ok: false, state: refuse(STEP_UP_REQUIRED, formData) };
  }
  return { ok: true, slug };
}

function revalidateLegal(slug: LegalSlug): void {
  revalidatePath("/super/legal");
  revalidatePath("/legal");
  revalidatePath(legalDocumentHref(slug));
}

export async function createLegalDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const gate = await authorise(formData, { stepUp: false });
  if (!gate.ok) return gate.state;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_legal_document_draft", { p_slug: gate.slug });
  if (error) return rpcRefusal("create_legal_document_draft", error.code, error.message, formData);

  revalidateLegal(gate.slug);
  return { message: "Draft created from the current version. Nothing public has changed." };
}

export async function saveLegalDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const gate = await authorise(formData, { stepUp: false });
  if (!gate.ok) return gate.state;

  const documentId = field(formData, "documentId");
  if (!documentId) return refuse(NOT_ALLOWED, formData);
  const checked = validateDraft(gate.slug, {
    title: field(formData, "title") ?? "",
    // Not field(): a legal text's leading/trailing whitespace is the author's.
    body: typeof formData.get("body") === "string" ? (formData.get("body") as string) : "",
    effectiveDate: field(formData, "effectiveDate") ?? "",
  });
  if (!checked.ok) {
    return refuse("The draft wasn’t saved. Fix the fields marked below.", formData, checked.fieldErrors);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_legal_document_draft", {
    p_document_id: documentId,
    p_title: checked.value.title,
    p_body: checked.value.body,
    p_effective_date: checked.value.effectiveDate,
  });
  if (error) return rpcRefusal("update_legal_document_draft", error.code, error.message, formData);

  revalidateLegal(gate.slug);
  return { message: "Draft saved. It is not public until you publish it.", values: echoedValues(formData) };
}

export async function publishLegalDocumentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const gate = await authorise(formData, { stepUp: true });
  if (!gate.ok) return gate.state;

  if (formData.get("confirm") !== "yes") {
    return refuse("Tick the box to confirm you want this draft to become the public version.", formData, {
      confirm: "Required.",
    });
  }

  const documentId = field(formData, "documentId");
  if (!documentId) return refuse(NOT_ALLOWED, formData);

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_legal_document", {
    p_document_id: documentId,
  });
  if (error) return rpcRefusal("publish_legal_document", error.code, error.message, formData);

  revalidateLegal(gate.slug);
  return { message: "Published. The public page now shows this version." };
}

export async function recordCounselReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const gate = await authorise(formData, { stepUp: true });
  if (!gate.ok) return gate.state;

  const documentId = field(formData, "documentId");
  if (!documentId) return refuse(NOT_ALLOWED, formData);
  const reviewer = field(formData, "reviewer") ?? "";
  const fieldErrors: Record<string, string> = {};
  if (reviewer === "") fieldErrors.reviewer = "Name the firm or person who reviewed it.";
  else if (reviewer.length > 200) fieldErrors.reviewer = "Keep it to 200 characters.";
  if (formData.get("confirm") !== "yes") {
    fieldErrors.confirm = "Required.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return refuse("The review wasn’t recorded. Fix the fields marked below.", formData, fieldErrors);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("record_legal_document_counsel_review", {
    p_document_id: documentId,
    p_reviewer: reviewer,
  });
  if (error) {
    return rpcRefusal("record_legal_document_counsel_review", error.code, error.message, formData);
  }

  revalidateLegal(gate.slug);
  return { message: "Counsel’s review recorded. This version no longer shows the draft notice." };
}
