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

// ===========================================================================
// PHASE 4 TASK 3: the link PARENTS, their permission keys, and target parsing
// ===========================================================================
// This module stays PURE -- constants, a permission map and a pure parser -- so
// the client picker (components/crm/entity-link-picker.tsx) and the server
// loaders (lib/crm/queries.ts) can both import from it. The two Server Actions
// that WRITE a link live in lib/crm/link-actions.ts ("use server"): a "use
// server" module may export only async functions, and `LINK_ENTITY_TYPES` above
// is a value the picker needs on the client, so the two cannot share a file.

/**
 * The four tables a link hangs off, and the permission key each authorises on.
 *
 * `addLinkAction` authorises on the PARENT's key -- linking a task to an event
 * is a task write (`manage_tasks`), not an event write -- and the DB policy then
 * re-checks the TARGET with `entity_is_visible` (Task 2 § OF). `document` is
 * here for completeness (the document link write path is Task 6); its key is
 * seeded and its policies exist, so naming it now costs nothing and keeps the
 * map total over the four parents.
 *
 * This is the operations analogue of custom-fields.ts's PERMISSION_FOR_ENTITY
 * (which maps the six CRM entity types to their keys); it is deliberately a
 * SEPARATE map, because the two sets of entities and the two sets of keys are
 * independent -- aliasing would couple decisions that can diverge.
 */
export const PERMISSION_FOR_LINK_PARENT = {
  tasks: "manage_tasks",
  meetings: "manage_meetings",
  notes: "manage_notes",
  documents: "manage_documents",
} as const;

export type LinkParent = keyof typeof PERMISSION_FOR_LINK_PARENT;

export const LINK_PARENTS = Object.keys(
  PERMISSION_FOR_LINK_PARENT,
) as readonly LinkParent[];

export function isLinkParent(value: string | null): value is LinkParent {
  return value !== null && value in PERMISSION_FOR_LINK_PARENT;
}

export function isLinkEntityType(value: string | null): value is LinkEntityType {
  return value !== null && (LINK_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The picker submits its choice as one `type:id` token, so a single native
 * `<select>` grouped by entity type is the whole control (see the picker's
 * header for why a `type:id` token rather than two separate `<select>`s: with
 * JavaScript off there is no cascade to keep a second select in step). This is
 * the parse, and it is STRICT: the type must be one of the six, and the id must
 * be present. Anything else is null, which the action turns into a refusal.
 *
 * The id is NOT validated for uuid shape here -- `liveInOrg`/the policy answer
 * "gone" for an unparseable uuid exactly as for a record in another workspace,
 * so a separate "not a uuid" message would be a second, more precise answer to
 * a question the phase answers vaguely on purpose.
 */
export function parseLinkTarget(
  token: string | null,
): { entityType: LinkEntityType; entityId: string } | null {
  if (token === null) return null;
  const sep = token.indexOf(":");
  if (sep === -1) return null;
  const entityType = token.slice(0, sep);
  const entityId = token.slice(sep + 1);
  if (!isLinkEntityType(entityType) || entityId === "") return null;
  return { entityType, entityId };
}

/** The inverse: the token an option carries for a target. */
export function linkTargetToken(entityType: LinkEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}
