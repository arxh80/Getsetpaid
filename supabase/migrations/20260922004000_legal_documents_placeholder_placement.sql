-- ===========================================================================
-- Phase 8 Task 1, fix round 1 (review finding M3): a placeholder is valid
-- only where it renders.
--
-- WHAT WAS WRONG. Two shapes passed every layer and rendered nothing useful:
--   1. `{{support_email}}` inside bold or link text -- `**{{support_email}}**`,
--      `[{{support_email}}](/legal/contact)`. The save-time check and
--      `legal_documents_required_blocks` both looked for the substring, so the
--      contact page "contained" its required placeholder while the parser
--      rendered the literal text: no address, and no "not configured"
--      sentence either.
--   2. `{{subprocessors}}` / `{{storage_inventory}}` in the middle of a line --
--      `Our providers: {{subprocessors}}`, `## {{storage_inventory}}`,
--      `- {{storage_inventory}}`. The CHECK accepted them; the parser renders
--      a block placeholder only when it stands alone on its line, and drops
--      it otherwise. So a direct RPC call could publish a Subprocessors page
--      with no table while satisfying "the database requires the placeholder".
--
-- THE RULE, now identical in all three layers (lib/legal/markup.ts is the
-- other two):
--   * `{{subprocessors}}` and `{{storage_inventory}}` stand ALONE on their
--     line -- spaces and tabs around them, nothing else;
--   * no `{{` inside bold (`**...**` on one line), inside link text, or
--     inside a link target.
-- `{{support_email}}` stays an INLINE placeholder (every seeded page uses it
-- mid-sentence); it simply may not sit inside bold or a link.
--
-- THE FIVE PATTERNS ARE lib/legal/markup.ts's PLACEMENT_PATTERNS, VERBATIM.
-- tests/integration/legal/legal-documents.test.ts reads this constraint from
-- the live catalogue and asserts each pattern string is in it, and
-- tests/unit/legal/markup-placement.test.ts proves the parser's linear scan
-- equals the same regexes on a generated corpus -- so "the editor accepts"
-- and "the database accepts" are the same set. The bold pattern is
-- conservative on purpose: a regex cannot know which `**` pairs the parser
-- matched, so `**a** {{support_email}} **b**` is refused by both, and nothing
-- the database accepts can render a raw placeholder in bold.
--
-- Bold and links never span a line break in the parser (fix round 1), which
-- is what makes line-bounded patterns sufficient. CR counts as a line break
-- here because the parser normalises CR and CRLF to LF before it reads.
--
-- `legal_documents_required_blocks_standalone` adds the positional half of
-- the required-block rule for the two pages whose whole content is a
-- generated table. The original `legal_documents_required_blocks` stays (it
-- is still true, and it is what requires `{{support_email}}` on the contact
-- and vulnerability-disclosure pages; with the placement rule beside it, a
-- present `{{support_email}}` is one the parser renders).
--
-- EXISTING ROWS. Both constraints are added VALIDATED, so this migration
-- fails rather than applies if any stored version breaks them. Checked
-- against the fifteen seeded versions before it was written (none does); a
-- failure here on another deployment means a version published there since
-- -- which is immutable, and would need a DBA decision, not a NOT VALID.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

alter table public.legal_documents
  add constraint legal_documents_body_placeholders_placed check (
        body !~ '[^\n\r \t][ \t]*\{\{(subprocessors|storage_inventory)\}\}'
    and body !~ '\{\{(subprocessors|storage_inventory)\}\}[ \t]*[^\n\r \t]'
    and body !~ '\*\*[^*\n\r]*\{\{[^*\n\r]*\*\*'
    and body !~ '\[[^\]\n\r]*\{\{[^\]\n\r]*\]\('
    and body !~ '\]\([^)\n\r]*\{\{'
  ),
  add constraint legal_documents_required_blocks_standalone check (
        (slug <> 'cookies'
         or body ~ '(^|[\n\r])[ \t]*\{\{storage_inventory\}\}[ \t]*([\n\r]|$)')
    and (slug <> 'subprocessors'
         or body ~ '(^|[\n\r])[ \t]*\{\{subprocessors\}\}[ \t]*([\n\r]|$)')
  );

comment on constraint legal_documents_body_placeholders_placed on public.legal_documents is
  'A placeholder only where it renders: {{subprocessors}} and {{storage_inventory}} alone on their line; no {{ inside bold, link text or a link target. The five patterns are lib/legal/markup.ts PLACEMENT_PATTERNS verbatim (20260922004000, fix round 1 M3).';

comment on constraint legal_documents_required_blocks_standalone on public.legal_documents is
  'The Cookie Policy and Subprocessors page each carry their generated table as a block the parser renders -- alone on its own line -- not merely somewhere in the text (20260922004000, fix round 1 M3).';
