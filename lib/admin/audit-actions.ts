// The catalogue of audit action names the product writes, and the CRM
// half's derivation.
//
// ===========================================================================
// WHY A CATALOGUE EXISTS BESIDE A FREE-TEXT FILTER
// ===========================================================================
// lib/admin/audit-log.ts's action filter is deliberately free text (a
// length-capped exact match) so a legacy or one-off action is still
// findable. That is the right allowlist SHAPE for a filter and the wrong one
// for DISCOVERY: Phase 7 Task 6b added forty action names in one migration
// (four verbs over the nine soft-deletable CRM tables, two over the other
// two), and "an action the founder
// cannot filter for is an action they cannot find" cuts both ways -- a filter
// that accepts any string is no help to someone who does not know the
// string. So the filter stays free text and the form offers this catalogue
// as a <datalist>: typing "contact." completes to the four contact actions.
//
// ===========================================================================
// THE CRM HALF IS DERIVED, NOT LISTED, AND BOUND TO THE DATABASE
// ===========================================================================
// The trigger side is `private.audit_crm_change('<target>')`, which emits
// `<target>.created`, `.updated`, and -- for tables with a deleted_at column
// -- `.soft_deleted` and `.restored`. This file derives the same set from the
// same two facts (the target list and which targets soft-delete), so the two
// cannot disagree in SHAPE; tests/integration/admin/audit-actions-match-db.
// test.ts reads the live pg_trigger arguments and the live column list and
// asserts the two agree in CONTENT. The rest of the catalogue (organisation,
// impersonation, feedback, ...) is a plain list, and the same test asserts
// every literal action name any database function passes to
// private.log_audit_event() is in it.

/** The eleven mutable Phase 2 CRM tables, by audit target_type, with whether
 *  the table carries a `deleted_at` column (soft-delete/restore actions exist
 *  only for those). `merges` is append-only and audited as `records.merged`
 *  since 20260828141000 -- it is in NEITHER list on purpose. */
export const CRM_AUDIT_TARGETS = {
  company: { softDeletable: true },
  contact: { softDeletable: true },
  contact_company: { softDeletable: false },
  agency: { softDeletable: true },
  artist: { softDeletable: true },
  artist_representation: { softDeletable: true },
  artist_fee: { softDeletable: true },
  venue: { softDeletable: true },
  venue_room: { softDeletable: true },
  custom_field_definition: { softDeletable: true },
  custom_field_value: { softDeletable: false },
} as const;

export type CrmAuditTarget = keyof typeof CRM_AUDIT_TARGETS;

/** The verbs private.audit_crm_change() emits, in the order they read best
 *  in a list. `soft_deleted`, not `deleted`: the latter already means a HARD
 *  delete on the two tables that have one. */
export const CRM_AUDIT_VERBS = ["created", "updated", "soft_deleted", "restored"] as const;
export type CrmAuditVerb = (typeof CRM_AUDIT_VERBS)[number];

/** The audit table's physical name for a target type -- what the integration
 *  test joins pg_trigger against. */
export const CRM_AUDIT_TARGET_TABLE: Record<CrmAuditTarget, string> = {
  company: "companies",
  contact: "contacts",
  contact_company: "contact_companies",
  agency: "agencies",
  artist: "artists",
  artist_representation: "artist_representations",
  artist_fee: "artist_fee_history",
  venue: "venues",
  venue_room: "venue_rooms",
  custom_field_definition: "custom_field_definitions",
  custom_field_value: "custom_field_values",
};

/** Every action the CRM write triggers can emit, derived. */
export function crmAuditActions(): readonly string[] {
  const out: string[] = [];
  for (const [target, { softDeletable }] of Object.entries(CRM_AUDIT_TARGETS)) {
    for (const verb of CRM_AUDIT_VERBS) {
      if (!softDeletable && (verb === "soft_deleted" || verb === "restored")) continue;
      out.push(`${target}.${verb}`);
    }
  }
  return out;
}

/** The two hard-DELETE actions and the merge pair (20260828141000,
 *  20260829020000): CRM, but not derived, because they predate the verb
 *  scheme and their names are load-bearing in existing suites. */
export const CRM_IRREVERSIBLE_AUDIT_ACTIONS = [
  "contact_company.deleted",
  "custom_field_value.deleted",
  "records.merged",
  "records.merged.fields",
] as const;

/** Every non-CRM action the database writes, by feature, in the order the
 *  features shipped. A name here and not in a migration is a typo; a name in
 *  a migration and not here fails audit-actions-match-db.test.ts. */
export const PLATFORM_AUDIT_ACTIONS = [
  // Foundation / membership
  "organisation.created",
  "membership.accepted",
  // Phase 4 documents (public.audit_document_action's closed set)
  "document_uploaded",
  "document_downloaded",
  "document_deleted",
  "document_quarantined",
  // Phase 6 network
  "network_profile.published",
  "network_profile.unpublished",
  "network_profile.visibility_changed",
  // Phase 7 Task 1
  "audit_log.viewed",
  // Phase 7 Task 2
  "impersonation.requested",
  "impersonation.accepted",
  "impersonation.declined",
  "impersonation.started",
  "impersonation.page_viewed",
  "impersonation.ended",
  "impersonation.expired",
  // Phase 7 Task 3
  "organisation.suspended",
  "organisation.deleted",
  "organisation.reinstated",
  // Phase 7 Task 4
  "organisation.billing_override_granted",
  "organisation.billing_override_revoked",
  "organisation.feature_override_granted",
  "organisation.feature_override_revoked",
  // Phase 7 Task 5
  "platform_health.viewed",
  "incident_alert.resolved",
  "incident_alert.reopened",
  // Phase 7 Task 6
  "feedback.submitted",
  "feedback.status_changed",
  "feedback.screenshot_viewed",
  // Phase 8 Task 1 (20260922000000): the legal document store. Identifiers
  // only -- slug and version, never the text or the reviewer's name.
  "legal_document.draft_created",
  "legal_document.draft_updated",
  "legal_document.published",
  "legal_document.counsel_review_recorded",
  // Phase 8 Task 2 (20260923000000): the consent ledger. Account-level, so
  // no organisation; identifiers and enums only (purpose, policy version,
  // mechanism).
  "consent.granted",
  "consent.withdrawn",
  // Phase 8 Task 3 (20260924000000): data subject requests. Identifiers,
  // enums and timestamps only -- never the requester's words, never a
  // rejection reason, never a note's body (the audit log is read across every
  // tenant). The six state actions are `'data_subject_request.' || new.status`
  // built in private.audit_dsr_transition(), so the scanner below finds only
  // the two literal ones; all of them are listed by hand, the same way
  // impersonation.ended/.expired are. There is no `.open`: `open` is where a
  // request starts, never a state it transitions INTO.
  "data_subject_request.submitted",
  "data_subject_request.in_progress",
  "data_subject_request.routed",
  "data_subject_request.fulfilled",
  "data_subject_request.rejected",
  "data_subject_request.withdrawn",
  "data_subject_request.fulfilment_recorded",
  "data_subject_request.note_added",
  // Fix round 1 (review finding I7 / Q160c): correcting the workspace a
  // routed request names. Not a transition -- the status is `routed` before
  // and after -- so it has its own action, carrying both workspaces.
  "data_subject_request.rerouted",

  // Phase 8 Task 4 (20260927001000, 20260927005000): data exports. TWO
  // actions and not four, because the other two events have no actor: a job
  // SUCCEEDS or FAILS in a session with no person on it, and
  // private.log_audit_event() refuses an unattributable row
  // (audit_events.actor_user_id is NOT NULL and there is no system actor).
  // The job row carries status, timestamps, counts and any failure reason,
  // and it is the record of those.
  "export_job.requested",
  "export_job.downloaded",

  // Phase 8 Task 5 (20260930001000, 20260930003000): erasure. TWO actions,
  // and the second one is unlike every other row in this table: it is the
  // SUMMARY of a completed account erasure, its payload is counts and never
  // content, and its actor is the Q130 TOMBSTONE -- because the person who
  // asked no longer exists by the time it is written. It is deliberately not
  // "written by nobody": audit_events.actor_user_id is NOT NULL and there is
  // no system actor, and an erasure that left no record of itself would
  // destroy the evidence that a statutory deletion was performed.
  "erasure_job.requested",
  "account.erased",
] as const;

/** The whole catalogue, deduplicated, in catalogue order: CRM writes first
 *  (they are the bulk of the table), then the irreversible CRM actions, then
 *  the platform's own. */
export function knownAuditActions(): readonly string[] {
  return Array.from(
    new Set<string>([
      ...crmAuditActions(),
      ...CRM_IRREVERSIBLE_AUDIT_ACTIONS,
      ...PLATFORM_AUDIT_ACTIONS,
    ]),
  );
}
