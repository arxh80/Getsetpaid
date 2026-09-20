"use server";

// The operator's three writes on /super/data-requests: move a request through
// its states, route a processor request to the workspace that is its
// controller (Q132), and add a working note the requester cannot read.
//
// ROUTING IS ITS OWN ACTION SINCE FIX ROUND 1 (review finding I7, Q160a),
// because it is no longer one UPDATE with a label on it:
//
//   * it calls public.route_data_subject_request(), which writes the routing
//     and the mandatory handover note in ONE transaction (a deferred
//     constraint trigger refuses a routing with no note, from any writer);
//   * it CONFIRMS THE WORKSPACE BY NAME before it writes. A slug is typed,
//     and a typo that happens to match another workspace used to be
//     uncorrectable and invisible: the operator saw the slug they typed and
//     the requester was told "we passed this on". Now the first submission
//     resolves the slug and hands the NAME back for the operator to check,
//     and only a submission that carries that same slug back as
//     `confirmedSlug` writes anything;
//   * the same action CORRECTS a routed request (Q160c) -- the database reads
//     a different workspace on a routed row as a re-route.
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
  ROUTING_CONFIRMED_SLUG_KEY,
  ROUTING_RESOLVED_NAME_KEY,
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
      case "use_route_data_subject_request":
        return refuse(
          "Passing a request to a business has its own form, which records the handover.",
          formData,
        );
      case "handover_note_required":
      case "routing_needs_handover_note":
        return refuse("Say how you told the workspace. Nothing in this product tells it.", formData, {
          handoverNote: "Write down the address you emailed and when.",
        });
      case "not_a_transition":
        return refuse(
          "That request already names that workspace. Name a different one, or leave it as it is.",
          formData,
          { organisationSlug: "This is the workspace it was already passed to." },
        );
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
  if (status === "routed") {
    // The RPC refuses it by name too (22023 use_route_data_subject_request);
    // this names the reason without a round trip.
    return refuse(
      "Passing a request to a business has its own form, which records the handover.",
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

  const { error } = await supabase.rpc("transition_data_subject_request", {
    p_request_id: requestId,
    p_status: status,
    p_rejection_reason: status === "rejected" ? reason : null,
  });

  if (error) {
    console.error("[dsr] transition failed:", error.code, error.message);
    return rpcRefusal(error.code, error.hint ?? undefined, formData);
  }

  revalidatePath(SUPER_DATA_REQUESTS_PATH);
  return { message: `Marked ${DSR_STATUS_LABELS[status]}.`, values: {} };
}

/**
 * Pass a `workspace_records` request to the workspace that is its controller
 * -- or correct the workspace a routed one names (Q160c).
 *
 * TWO SUBMISSIONS, DELIBERATELY. The first resolves the typed slug and hands
 * the workspace's NAME back for the operator to read; only a submission whose
 * `confirmedSlug` equals the slug it resolves writes anything. A slug is a
 * typed identifier that can silently match a DIFFERENT real workspace, and
 * the consequence of routing the wrong one is telling a business that a named
 * person made a privacy request.
 *
 * NOT BEHIND STEP-UP, as built, for the reason the review agreed with: today
 * a routing discloses nothing to anybody, because nothing is sent. THE DAY
 * ROUTING NOTIFIES A WORKSPACE IN-PRODUCT it becomes a disclosure of personal
 * data to a third party chosen by a typed slug, and it goes behind step-up
 * with the confirmation step kept (Q160).
 */
export async function routeDataSubjectRequestAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!(await isSuperuser())) return refuse(FAILED_MESSAGE, formData);

  const requestId = field(formData, "requestId") ?? "";
  if (!UUID_RE.test(requestId)) return refuse(FAILED_MESSAGE, formData);

  const slug = (field(formData, "organisationSlug") ?? "").toLowerCase();
  if (slug === "") {
    return refuse("Name the workspace this goes to.", formData, {
      organisationSlug: "Type the workspace’s slug.",
    });
  }

  const handoverNote = field(formData, "handoverNote") ?? "";
  if (handoverNote === "") {
    return refuse("Say how you told the workspace. Nothing in this product tells it.", formData, {
      handoverNote: "Write down the address you emailed and when.",
    });
  }
  if (handoverNote.length > DSR_NOTE_MAX) {
    return refuse("That note is too long.", formData, {
      handoverNote: `Keep it under ${DSR_NOTE_MAX.toLocaleString("en-GB")} characters.`,
    });
  }

  // A SELECT of every workspace on the platform would be the unbounded list
  // "paginate everything" forbids (the feedback list's own reasoning), so the
  // slug is typed -- and therefore has to be confirmed by name below.
  const supabase = await createClient();
  const { data: org, error: orgError } = await supabase
    .from("organisations")
    .select("id, name")
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
  const organisationName = org.name as string;

  if ((field(formData, ROUTING_CONFIRMED_SLUG_KEY) ?? "").toLowerCase() !== slug) {
    // NOT AN ERROR AND NOT A SUCCESS: the form renders the name and asks for
    // one more press. Nothing has been written.
    return {
      values: {
        ...echoedValues(formData),
        [ROUTING_RESOLVED_NAME_KEY]: organisationName,
        [ROUTING_CONFIRMED_SLUG_KEY]: slug,
      },
    };
  }

  const { error } = await supabase.rpc("route_data_subject_request", {
    p_request_id: requestId,
    p_organisation_id: org.id as string,
    p_handover_note: handoverNote,
  });
  if (error) {
    console.error("[dsr] routing failed:", error.code, error.message);
    return rpcRefusal(error.code, error.hint ?? undefined, formData);
  }

  revalidatePath(SUPER_DATA_REQUESTS_PATH);
  return {
    message:
      `Recorded as passed to ${organisationName}. Nothing was sent — email their Owner yourself if you have not already.`,
    values: {},
  };
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
