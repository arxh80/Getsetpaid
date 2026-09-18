"use server";

// The operator's three writes on /super/data-requests: move a request through
// its states, route a processor request to the workspace that is its
// controller (Q132), and add a working note the requester cannot read.
//
// NOTHING HERE IS THE ENFORCEMENT except the step-up check. Each RPC carries
// its own `has_platform_permission('oversee_data_subject_requests')` guard —
// allowlisted superuser at aal2 — and the BEFORE UPDATE trigger behind it is
// the transition table, the who-may-do-it check and the stamper. What this
// file adds:
//
//   1. STEP-UP ON REJECTION, and on nothing else. `amr` freshness lives in the
//      JWT, which the database cannot see, so this is the only place it can
//      live (the split lib/legal/admin-actions.ts documents). Refusing a
//      statutory right is the one action here that a person cannot undo and
//      that has a legal consequence for them — CLAUDE.md § Session security's
//      "any high-risk admin/superuser function". Marking a request
//      in-progress, routing it (which is the correct answer for a processor
//      request, not a refusal) and adding a note are ordinary casework, and
//      a step-up prompt on every one of them is a prompt people learn to
//      click through.
//   2. A sentence per refusal, and revalidatePath.

import { revalidatePath } from "next/cache";
import { isSuperuser } from "@/lib/admin/superuser";
import { createClient } from "@/lib/supabase/server";
import { checkStepUp } from "@/lib/auth/step-up-gate";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE } from "@/lib/crm/write";
import {
  DSR_NOTE_MAX,
  DSR_REJECTION_REASON_MAX,
  DSR_STATUS_LABELS,
  SUPER_DATA_REQUESTS_PATH,
  UUID_RE,
  isDsrStatus,
} from "./contract";

const NOT_ALLOWED =
  "That can’t be done from here. Reload the page — the request may have changed since it was opened.";

const STEP_UP_REQUIRED =
  "Confirm it’s you before refusing a statutory request. Use the re-authentication prompt on this page, then try again.";

function refuse(
  message: string,
  formData: FormData,
  fieldErrors?: Record<string, string>,
): FormState {
  return { error: message, fieldErrors, values: echoedValues(formData) };
}

function rpcRefusal(code: string | undefined, hint: string | undefined, formData: FormData): FormState {
  if (code === "42501") return refuse(NOT_ALLOWED, formData);
  if (code === "22023") {
    switch (hint) {
      case "unknown_request":
        return refuse("That request no longer exists. Reload the page.", formData);
      case "illegal_transition":
        return refuse(
          "That request has already moved on — reload the page to see where it is now.",
          formData,
        );
      case "rejection_needs_reason":
        return refuse("A refusal must say why.", formData, {
          rejectionReason: "The requester reads this. Say why, and under which law.",
        });
      case "not_a_processor_request":
        return refuse(
          "Only a request about a business’s own records can be passed to that business.",
          formData,
        );
      case "routing_needs_workspace":
        return refuse("Name the workspace this goes to.", formData, {
          organisationSlug: "Type the workspace’s slug.",
        });
      case "fulfilment_not_recorded":
        return refuse(
          "This request cannot be marked answered until the export or erasure has actually run.",
          formData,
        );
    }
  }
  return refuse(FAILED_MESSAGE, formData);
}

export async function transitionDataSubjectRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Picks the sentence a non-superuser gets; the RPC's own guard and the
  // trigger are the enforcement.
  if (!(await isSuperuser())) return refuse(FAILED_MESSAGE, formData);

  const requestId = field(formData, "requestId") ?? "";
  const status = field(formData, "status") ?? "";
  if (!UUID_RE.test(requestId) || !isDsrStatus(status)) return refuse(FAILED_MESSAGE, formData);
  if (status === "withdrawn") {
    return refuse(
      "Only the person who made a request can withdraw it.",
      formData,
    );
  }

  const reason = (field(formData, "rejectionReason") ?? "").trim();
  if (status === "rejected") {
    // STEP-UP: the one high-risk action on this page.
    if (!(await checkStepUp())) return refuse(STEP_UP_REQUIRED, formData);
    if (reason === "") {
      return refuse("A refusal must say why.", formData, {
        rejectionReason: "The requester reads this. Say why, and under which law.",
      });
    }
    if (reason.length > DSR_REJECTION_REASON_MAX) {
      return refuse("That reason is too long.", formData, {
        rejectionReason: `Keep it under ${DSR_REJECTION_REASON_MAX.toLocaleString("en-GB")} characters.`,
      });
    }
  }

  const supabase = await createClient();

  // ROUTING takes a workspace SLUG typed into a text box rather than a select
  // of every workspace on the platform — that select would be the unbounded
  // list "paginate everything" forbids (the feedback list's own reasoning).
  let routeTo: string | null = null;
  if (status === "routed") {
    const slug = (field(formData, "organisationSlug") ?? "").trim().toLowerCase();
    if (slug === "") {
      return refuse("Name the workspace this goes to.", formData, {
        organisationSlug: "Type the workspace’s slug.",
      });
    }
    const { data: org, error: orgError } = await supabase
      .from("organisations")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (orgError) {
      console.error("[dsr] workspace lookup failed:", orgError.message);
      return refuse(FAILED_MESSAGE, formData);
    }
    if (!org) {
      return refuse("No workspace has that slug.", formData, {
        organisationSlug: "Check the spelling — it is the name in the workspace’s address bar.",
      });
    }
    routeTo = org.id as string;
  }

  const { error } = await supabase.rpc("transition_data_subject_request", {
    p_request_id: requestId,
    p_status: status,
    p_rejection_reason: status === "rejected" ? reason : null,
    p_route_to_organisation_id: routeTo,
  });

  if (error) {
    console.error("[dsr] transition failed:", error.code, error.message);
    return rpcRefusal(error.code, error.hint ?? undefined, formData);
  }

  revalidatePath(SUPER_DATA_REQUESTS_PATH);
  return { message: `Marked ${DSR_STATUS_LABELS[status]}.`, values: {} };
}

export async function addDataSubjectRequestNoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!(await isSuperuser())) return refuse(FAILED_MESSAGE, formData);

  const requestId = field(formData, "requestId") ?? "";
  const body = (field(formData, "note") ?? "").trim();
  if (!UUID_RE.test(requestId)) return refuse(FAILED_MESSAGE, formData);
  if (body === "") {
    return refuse("Write the note first.", formData, { note: "An empty note is not a note." });
  }
  if (body.length > DSR_NOTE_MAX) {
    return refuse("That note is too long.", formData, {
      note: `Keep it under ${DSR_NOTE_MAX.toLocaleString("en-GB")} characters.`,
    });
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("add_data_subject_request_note", {
    p_request_id: requestId,
    p_body: body,
  });
  if (error) {
    console.error("[dsr] add note failed:", error.code, error.message);
    return rpcRefusal(error.code, error.hint ?? undefined, formData);
  }

  revalidatePath(SUPER_DATA_REQUESTS_PATH);
  return { message: "Note added. The requester never sees it.", values: {} };
}
