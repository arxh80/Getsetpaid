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

/** Every tenant-owned table that carries the generic audit_crm_change pair,
 *  by audit target_type, with whether the table carries a `deleted_at`
 *  column (soft-delete/restore actions exist only for those). The eleven
 *  mutable Phase 2 CRM tables since Phase 7 Task 6b (20260912000000);
 *  sixteen more since Phase 8 Task 7 (20261006000000, Q122) -- the Phase
 *  3-6 tables the brief named plus three the DERIVED census found outside
 *  it (membership, subscription, merge_candidate). `merges` is append-only
 *  and audited as `records.merged` since 20260828141000 -- it is in NEITHER
 *  list on purpose. The physical-table map is CRM_AUDIT_TARGET_TABLE below;
 *  the tables a client can write that deliberately do NOT carry the pair are
 *  AUDIT_COVERAGE_EXCUSALS, and tests/integration/admin/
 *  crm-audit-coverage-census.test.ts derives the whole denominator from the
 *  live catalogue and refuses a table that is in neither. */
export const CRM_AUDIT_TARGETS = {
  // Phase 2 (20260912000000).
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
  // Phase 3 (20261006000000).
  event: { softDeletable: true },
  event_lineup: { softDeletable: true },
  // Phase 4.
  task: { softDeletable: true },
  meeting: { softDeletable: true },
  note: { softDeletable: true },
  document: { softDeletable: true },
  task_link: { softDeletable: true },
  meeting_link: { softDeletable: true },
  note_link: { softDeletable: true },
  document_link: { softDeletable: true },
  // Phase 5.
  financial_entry: { softDeletable: true },
  // Phase 6.
  network_profile: { softDeletable: true },
  network_link: { softDeletable: true },
  // Found by the derived census, outside the Q122 list.
  membership: { softDeletable: false },
  subscription: { softDeletable: false },
  merge_candidate: { softDeletable: true },
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
  event: "events",
  event_lineup: "event_lineup",
  task: "tasks",
  meeting: "meetings",
  note: "notes",
  document: "documents",
  task_link: "task_links",
  meeting_link: "meeting_links",
  note_link: "note_links",
  document_link: "document_links",
  financial_entry: "financial_entries",
  network_profile: "network_profiles",
  network_link: "network_links",
  membership: "organisation_memberships",
  subscription: "organisation_subscriptions",
  merge_candidate: "merge_candidates",
};

/** The tenant-owned tables a client role can write that deliberately do NOT
 *  carry the generic audit_crm_change pair, each with how its writes ARE
 *  covered -- or, for the one `unaudited` entry, why not and where the
 *  decision is queued. `private.audit_coverage()` (20261006000000) derives
 *  the denominator and the coverage from the live catalogue; the census test
 *  asserts that every table it reports is either a CRM_AUDIT_TARGET_TABLE
 *  value with coverage `generic` or is listed here with the coverage it
 *  claims, in both directions, so a stale excusal is as red as a missing
 *  one. A dedicated writer's triggers are named so the test can check each
 *  one still exists and still fires on the operations the client can
 *  perform -- a structural check; the behavioural half (one row per
 *  effective write) is the psql suites. */
export const AUDIT_COVERAGE_EXCUSALS: Record<
  string,
  { coverage: "dedicated" | "rpc_only" | "unaudited"; triggers: readonly string[]; reason: string }
> = {
  feedback: {
    coverage: "dedicated",
    triggers: ["feedback_audit_submission", "feedback_audit_status_change"],
    reason:
      "Phase 7 Task 6 (20260911000000): feedback.submitted on INSERT and feedback.status_changed on the " +
      "status-only UPDATE, with the message never in the payload.",
  },
  incident_alerts: {
    coverage: "dedicated",
    triggers: ["incident_alerts_audit_resolution"],
    reason:
      "Phase 7 Task 5 fix round 1 (20260909080000): the only client write is UPDATE(resolved_at, " +
      "resolved_by), audited as incident_alert.resolved / .reopened.",
  },
  erasure_jobs: {
    coverage: "dedicated",
    triggers: ["erasure_jobs_after_insert_audit"],
    reason:
      "Phase 8 Task 5 (20260930001000): the only client write is INSERT(kind), audited as " +
      "erasure_job.requested; the job's later states are written by the sessionless runner and " +
      "recorded by account.erased / organisation.erased.",
  },
  export_jobs: {
    coverage: "dedicated",
    triggers: ["export_jobs_after_insert_audit"],
    reason:
      "Phase 8 Task 4 (20260927001000): the only client write is INSERT(kind, organisation_id), " +
      "audited as export_job.requested; progress is the sessionless runner's.",
  },
  network_connection_requests: {
    coverage: "dedicated",
    triggers: ["audit_network"],
    reason:
      "Spans TWO tenants and has no organisation_id column, so the generic writer cannot file it. " +
      "private.audit_network_row() files INSERT and every status transition against the side whose " +
      "member acted (sender: requested / withdrawn; recipient: accepted / declined) and any other " +
      "effective UPDATE as a name-only network_connection.updated (20261006000000).",
  },
  organisation_billing_overrides: {
    coverage: "rpc_only",
    triggers: ["organisation_billing_overrides_guard"],
    reason:
      "Phase 7 Task 4 (20260908050000): every INSERT/UPDATE policy requires " +
      "private.override_transition_in_progress(), which only the four audited grant/revoke RPCs " +
      "set, and private.override_table_guard() refuses a direct write beneath the policy.",
  },
  organisation_feature_overrides: {
    coverage: "rpc_only",
    triggers: ["organisation_feature_overrides_guard"],
    reason: "As organisation_billing_overrides.",
  },
  organisations: {
    coverage: "unaudited",
    triggers: [],
    reason:
      "THE ONE OPEN HOLE, QUEUED NOT HIDDEN (DECISIONS-QUEUE Q189). An Owner's own edit of the " +
      "workspace's name or slug (organisations_update_manage_organisation) writes no audit row. " +
      "The lifecycle transitions ARE audited (organisation.suspended / .deleted / .reinstated " +
      "through the marker-guarded policy) and create_organisation() writes organisation.created, " +
      "so attaching the generic pair would write a second organisation.created per workspace and " +
      "a .soft_deleted / .restored beside every lifecycle summary row, changing the shape of every " +
      "lifecycle thread. Which shape is wanted is a decision, not a default.",
  },
};

/** Every action the generic CRM write trigger can emit, derived. */
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
  // Phase 8 Task 7 (20261006000000): removing a member is a HARD delete that
  // `authenticated` can perform, and the generic INSERT/UPDATE pair cannot
  // see it. Same trigger function as the first two (private.audit_crm_row).
  "membership.deleted",
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
  // ... and the connection-request half of the same writer. The first three
  // have been written since 20260904005000 and were on NEITHER side of the
  // catalogue until Phase 8 Task 7 (report finding 1): the founder's filter
  // could not suggest them and the retention suite's planted catalogue
  // omitted them. `.withdrawn` and `.updated` are new in 20261006000000.
  "network_connection.requested",
  "network_connection.accepted",
  "network_connection.declined",
  "network_connection.withdrawn",
  "network_connection.updated",
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
  // Phase 8 Task 9c -- public.close_my_workspace()
  "organisation.closed_by_owner",
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
  // ... and its workspace twin, added in fix round 1 (review finding M2):
  // private.erase_organisation() wrote no summary row at all, although the
  // requirement asked every erasure for one. Same shape as account.erased --
  // counts, never content, actor = the tombstone -- with the workspace's id
  // in the payload as well as in target_id, because organisation_id on the
  // audit row is a foreign key to a workspace that has just been deleted.
  "organisation.erased",

  // Phase 8 Task 6 (20261003001000): the retention job's kill switch. The
  // before/after are the two booleans plus the operator's mandatory reason --
  // the organisation_billing_overrides shape, and for the same reason: a
  // destructive scheduled job that was switched off (or back on) with no
  // recorded why is a decision nobody can reason about six months later.
  "retention_settings.changed",
  // ... and the run itself (20261003004000). ONE summary row per run, counts
  // and never content, actor = the Q130 tombstone, on the run's own
  // correlation thread — the 20260908030000 § 6 pattern requirement 3 asks
  // for. A DRY run writes one too, marked `"mode": "dry"`: the founder
  // previewing what would be deleted is itself a thing the audit log should
  // be able to answer. It is written DIRECTLY into public.audit_events,
  // because private.log_audit_event() requires auth.uid() and a scheduled
  // retention run has nobody on it.
  "retention.swept",
  // Phase 8 Task 9a (20261010000000, Q184, founder 2026-09-30): the aal2
  // superuser releasing the audit purge's sanity ceiling for 72 hours. The
  // before/after are the release window; the after carries the operator's
  // mandatory reason. One row per release -- the settings row holds only the
  // latest, so this is the history of every release.
  "retention.audit_ceiling_released",
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
