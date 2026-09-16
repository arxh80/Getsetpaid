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
