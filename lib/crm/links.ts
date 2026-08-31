// THE LINK-TARGET ALLOWLIST, WRITTEN FOUR TIMES IN SQL, MIRRORED HERE ONCE.
//
// The four *_links tables (task_links, meeting_links, note_links,
// document_links -- supabase/migrations/20260902002000_operations_link_tables.sql)
// each carry an identical CHECK on `entity_type`:
//
//   check (entity_type in ('company','contact','agency','artist','venue','event'))
//
// That is the enforcement -- a link naming any other target is a 23514. This
// constant is the copy the create-link UI's picker and the link write path
// (later Phase 4 tasks) read, because a request cannot consult a CHECK.
//
// THE ALLOWLIST IS THE SIX MAJOR CRM ENTITIES AND NOTHING ELSE. It deliberately
// EXCLUDES task/meeting/note/document themselves (Q49): no link-to-link, no
// note-attached-to-note, no document attached to another operational object. A
// document attaches to a CRM record. The reversal is one CHECK migration per
// table plus one dispatch arm, and forgetting any of the four tables turns
// link-allowlist-matches-db.test.ts red.
//
// IT EQUALS THE SIX-VALUE SET ActivitySubjectType / SUBJECT_NOUN (lib/crm/activity.ts)
// AND CUSTOM_FIELD_ENTITY_TYPES (lib/crm/custom-fields.ts) ALREADY CARRY -- the
// links' target end is exactly the set the private.entity_is_visible /
// _manageable / _live dispatch validates it against, which is why no dispatch
// TARGET arm and no SUBJECT_NOUN entry are added for this phase. They are
// deliberately kept as separate constants rather than aliased: the reasons the
// three sets are equal today are independent (custom fields are per-entity;
// links target per-entity; the timeline subject is per-entity), and aliasing
// would couple three decisions that can diverge -- exactly the trap
// MERGE_ENTITY_TYPES fell into when it aliased CUSTOM_FIELD_ENTITY_TYPES and
// then had to stop.
//
// BOUND TO THE DATABASE, NOT TRUSTED:
// tests/integration/crm/link-allowlist-matches-db.test.ts reads all four CHECK
// definitions and asserts each equals LINK_ENTITY_TYPES and that all four are
// identical to each other.

/**
 * The six CRM entities a task/meeting/note/document may be linked to.
 *
 * Order matches the SQL CHECK for readability; the binding test sorts before
 * comparing, so the SET is the contract and the order is this file's to choose.
 */
export const LINK_ENTITY_TYPES = [
  "company",
  "contact",
  "agency",
  "artist",
  "venue",
  "event",
] as const;

export type LinkEntityType = (typeof LINK_ENTITY_TYPES)[number];
