// The legal-document markup: a deliberately tiny Markdown subset, parsed into
// DATA, never into HTML.
//
// ===========================================================================
// WHY A SUBSET, AND WHY OUR OWN PARSER
// ===========================================================================
// A legal document is edited by the platform superuser (and, through them,
// counsel) in a textarea at /super/legal. Superuser input is still untrusted
// input (CLAUDE.md § Non-negotiable rules: "Treat all user content as
// untrusted ... validate URL protocols (reject javascript:, data:); avoid
// dangerouslySetInnerHTML"). A general Markdown library would bring raw-HTML
// passthrough, images, autolinks and a sanitiser configuration that has to be
// right forever. This grammar has none of that to get wrong:
//
//   ## Heading            a section heading (<h2>)
//   ### Heading           a sub-heading (<h3>)
//   - item                an unordered list item (one line each; an indented
//                         line continues the item above it)
//   1. item               an ordered list item
//   plain lines           a paragraph; a blank line ends it
//   **text**              strong emphasis
//   [text](target)        a link -- https://, mailto: or a same-site /path only
//   {{support_email}}     the configured contact address (lib/legal/contact.ts)
//   {{subprocessors}}     on a line of its own: the subprocessor table
//   {{storage_inventory}} on a line of its own: the cookie/storage table
//
// Everything else is literal text, and React escapes literal text. The output
// is a list of typed blocks that components/legal/legal-body.tsx maps to
// elements one by one -- there is no HTML string anywhere in the path, so
// there is nothing for `dangerouslySetInnerHTML` to be tempted by.
//
// ===========================================================================
// THREE LAYERS, SO NO SINGLE ONE IS THE WHOLE CONTROL
// ===========================================================================
//   1. SAVE TIME: lib/legal/admin-actions.ts refuses a draft whose `problems`
//      list is non-empty, with the sentences below, before it reaches the
//      database.
//   2. THE DATABASE: `legal_documents` carries CHECK constraints refusing a
//      link target outside https:// / mailto: / a same-site path, any raw tag
//      opener, and any {{token}} not in the closed set -- so a direct RPC call
//      that skips (1) is refused too (20260922000000).
//   3. RENDER TIME: this parser runs again on every page view and DROPS what
//      it would have refused -- a disallowed link renders as its text only, a
//      stripped tag renders as nothing. So a row that somehow got past (1)
//      and (2) still cannot become an executable link or markup.

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | { readonly kind: "support-email" };

export type Block =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly content: readonly Inline[] }
  | { readonly kind: "paragraph"; readonly content: readonly Inline[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly kind: "subprocessors" }
  | { readonly kind: "storage-inventory" };

export interface ParsedMarkup {
  readonly blocks: readonly Block[];
  /** Human-readable reasons the source is not acceptable as written. Empty
   *  means the source round-trips with nothing dropped. */
  readonly problems: readonly string[];
}

export const SUPPORT_EMAIL_TOKEN = "{{support_email}}";
export const SUBPROCESSORS_TOKEN = "{{subprocessors}}";
export const STORAGE_INVENTORY_TOKEN = "{{storage_inventory}}";

/** Every token the grammar knows. Mirrored by the
 *  `legal_documents_body_tokens_known` CHECK constraint. */
export const KNOWN_TOKENS = [
  SUPPORT_EMAIL_TOKEN,
  SUBPROCESSORS_TOKEN,
  STORAGE_INVENTORY_TOKEN,
] as const;

/** Upper bound on a stored body, mirrored by `legal_documents_body_length`. */
export const MAX_BODY_LENGTH = 100_000;
/** Upper bound on a stored title, mirrored by `legal_documents_title_length`. */
export const MAX_TITLE_LENGTH = 200;

// A tag OPENER: `<` followed by a letter, `/` or `!`. Mirrors the
// `legal_documents_body_no_markup` CHECK (`body !~ '<[A-Za-z/!]'`). A bare
// `<` before a digit or a space ("fewer than <5") is ordinary text.
const TAG_OPENER = /<[A-Za-z/!]/;
const TAG = /<[A-Za-z/!][^>\n]*>?/g;

/**
 * The one link-target check, used at save time AND render time.
 *
 * Returns the target to use, or null when it is not allowed. Allowed:
 *   - `https://` followed by a parseable URL;
 *   - `mailto:` followed by a single address;
 *   - a same-site path: `/` followed by anything that is not a second `/` or a
 *     `\` (both of which a browser treats as a scheme-relative URL to another
 *     host), from a conservative character set.
 * Everything else -- `javascript:`, `data:`, `vbscript:`, `http:`, `//host`,
 * a bare word, a target with whitespace in it -- is refused.
 *
 * THE SCHEME IS MATCHED IN LOWER CASE ONLY (fix round 1, M4). This used to
 * compare case-insensitively and so accepted `HTTPS://…` and `MAILTO:…`,
 * which the database's `legal_documents_body_links_allowlisted` CHECK -- a
 * case-sensitive regex -- refuses: the editor said "fine" and the RPC then
 * failed with a generic sentence. The two now agree on the STRICTER rule
 * rather than loosening the database: a lower-case scheme costs an author
 * nothing, the refusal names it, every stored version already complies, and
 * a security CHECK is not the place to widen what counts as a link. Every
 * other spelling of every other scheme was already refused and still is.
 */
export function safeHref(raw: string): string | null {
  if (raw === "" || /[\s\p{Cc}]/u.test(raw)) {
    return null;
  }
  if (raw.startsWith("https://")) {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && url.hostname !== "" ? raw : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("mailto:")) {
    return isMailtoAddress(raw.slice("mailto:".length)) ? raw : null;
  }
  if (/^\/(?![/\\])[A-Za-z0-9\-._~/#?=&%]*$/.test(raw)) {
    return raw;
  }
  return null;
}

// ===========================================================================
// LINEAR HELPERS (fix round 2, M5)
// ===========================================================================
// Every regex below that could backtrack over a run of repeated characters
// was replaced by one of these. The render path parses a stored body on every
// public page view, and the database accepts bodies up to 100 000 characters,
// so a quadratic step is a denial of service on an anonymous page. Each
// helper states the regex it replaces and decides exactly what it decided;
// tests/unit/legal/markup-placement.test.ts times the shapes that used to be
// slow and compares each helper with its regex on a generated corpus.

/** Characters an address part may hold: not whitespace, `@ < > " ' ( )`. */
const ADDRESS_FORBIDDEN = /[\s@<>"'()]/;

/**
 * `/^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/` -- the address after
 * `mailto:` -- decided without backtracking. The regex was quadratic because
 * `.` is both in the domain's class and the separator: `a@` + 100 000 dots +
 * `<` took seconds, and the database's link CHECK accepts that target (it
 * asks only that a link start with `mailto:`). Stated directly: exactly one
 * `@`, not first; no forbidden character anywhere; and the domain has a `.`
 * with at least one character on each side.
 */
export function isMailtoAddress(address: string): boolean {
  const at = address.indexOf("@");
  if (at < 1 || address.indexOf("@", at + 1) !== -1) return false;
  if (ADDRESS_FORBIDDEN.test(address.slice(0, at)) || ADDRESS_FORBIDDEN.test(address.slice(at + 1))) {
    return false;
  }
  const domain = address.slice(at + 1);
  const dot = domain.indexOf(".", 1);
  return dot !== -1 && dot < domain.length - 1;
}

/** `text.replace(/[ \t]+$/, "")`, linear. */
export function trimSpacesAndTabsEnd(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(0, end);
}

/** `text.replace(/^[ \t]+/, "")`, linear. */
export function trimSpacesAndTabsStart(text: string): string {
  let start = 0;
  while (start < text.length && (text[start] === " " || text[start] === "\t")) start++;
  return text.slice(start);
}

/**
 * `/^PREFIX\s+(.*)$/.exec(line)?.[1] ?? null`, linear, for a line with no
 * `\n` or `\r` in it.
 *
 * The regex form is quadratic when the rest of the line holds a U+2028 or
 * U+2029: `.` does not match those but `\s` does, so `.*$` fails and `\s+`
 * gives back one character at a time, re-scanning the rest each time. Giving
 * whitespace back can never help -- the rest only grows and still holds the
 * separator -- so the regex matches exactly when `^PREFIX\s+` matches and the
 * text after the WHOLE whitespace run has no separator, and that text is the
 * capture. `prefix` is passed as `^PREFIX\s+`; its own backtracking is bounded
 * (`#{1,6}`, `[-*]`, or a digit run that must be followed by `.`).
 */
export function matchLinePrefix(prefix: RegExp, line: string): string | null {
  const head = prefix.exec(line);
  if (head === null) return null;
  const rest = line.slice(head[0].length);
  return /[\u2028\u2029]/.test(rest) ? null : rest;
}

function describeTarget(raw: string): string {
  const shown = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  return `“${shown}”`;
}

const LINK_REFUSED = (target: string) =>
  `The link ${describeTarget(target)} is not allowed. Links must start with https:// or mailto: (in lower case), or a single / for a page on this site.`;
const TOKEN_UNKNOWN = (token: string) =>
  `${describeTarget(token)} is not a known placeholder. The placeholders are ${KNOWN_TOKENS.join(", ")}.`;
const BLOCK_TOKEN_ALONE =
  "A {{subprocessors}} or {{storage_inventory}} placeholder must be on a line of its own.";
const TOKEN_IN_BOLD =
  "A {{placeholder}} cannot sit between two ** markers on the same line — put it outside the bold text.";
const TOKEN_IN_LINK =
  "A {{placeholder}} cannot be part of a link's text or its target — put it outside the link.";

// ===========================================================================
// WHERE A PLACEHOLDER MAY STAND (fix round 1, M3)
// ===========================================================================
// A placeholder inside bold or link text used to pass all three layers and
// render as the literal `{{support_email}}` -- so the contact page could
// "contain" its required placeholder while showing no address and no
// "not configured" sentence. And the database accepted `{{subprocessors}}`
// in the middle of a sentence, which the parser drops, so a direct RPC call
// could publish a Subprocessors page with no table while satisfying "the
// database requires the placeholder".
//
// The rule, identical in all three layers:
//   * `{{subprocessors}}` and `{{storage_inventory}}` stand ALONE on their
//     line (spaces and tabs around them only);
//   * no `{{` inside bold (`**…**` on one line), inside link text, or inside
//     a link target.
// These are the FIVE REFUSING PATTERNS below, as regular-expression source
// the database uses verbatim (CHECK `legal_documents_body_placeholders_placed`,
// 20260922004000; tests/integration/legal/legal-documents.test.ts reads the
// live constraint and asserts each source is in it). JavaScript does NOT
// evaluate them as regexes on a stored body -- three of them backtrack
// quadratically on a hostile line -- but through placementProblems(), a
// linear scan that tests/unit/legal/markup.test.ts proves equal to the regex
// on a generated corpus.
//
// The bold rule is deliberately CONSERVATIVE: "**a** {{support_email}} **b**"
// is refused even though the parser would render it, because a regex cannot
// know which `**` pairs the parser matched. The author reads a sentence; the
// renderer can never show a raw placeholder in bold for a body the database
// accepted.
export const PLACEMENT_PATTERNS = {
  blockTokenAfterText: String.raw`[^\n\r \t][ \t]*\{\{(subprocessors|storage_inventory)\}\}`,
  blockTokenBeforeText: String.raw`\{\{(subprocessors|storage_inventory)\}\}[ \t]*[^\n\r \t]`,
  tokenInBold: String.raw`\*\*[^*\n\r]*\{\{[^*\n\r]*\*\*`,
  tokenInLinkText: String.raw`\[[^\]\n\r]*\{\{[^\]\n\r]*\]\(`,
  tokenInLinkTarget: String.raw`\]\([^)\n\r]*\{\{`,
} as const;

export type PlacementRule = keyof typeof PLACEMENT_PATTERNS;

const BLOCK_TOKEN_LINE = /^[ \t]*\{\{(?:subprocessors|storage_inventory)\}\}[ \t]*$/;
const BLOCK_TOKEN_ANYWHERE = /\{\{(?:subprocessors|storage_inventory)\}\}/;

/**
 * Which of the five placement rules a body breaks -- linear in its length.
 * Exported for the equivalence test; validateDraft() reads it through
 * parseLegalMarkup().problems.
 */
export function placementViolations(source: string): Set<PlacementRule> {
  const found = new Set<PlacementRule>();
  // The database treats CR as a line break too; so does the parser.
  for (const line of source.split(/\r\n?|\n/)) {
    if (BLOCK_TOKEN_ANYWHERE.test(line) && !BLOCK_TOKEN_LINE.test(line)) {
      // Some other non-blank character shares the line with a block token, so
      // it stands before an occurrence or after one (or both). Every
      // occurrence is checked in both directions.
      const all = /\{\{(?:subprocessors|storage_inventory)\}\}/g;
      for (const m of line.matchAll(all)) {
        // Linear trims (fix round 2): `.replace(/[ \t]+$/, "")` here was
        // quadratic over a long run of spaces before an occurrence.
        const before = trimSpacesAndTabsEnd(line.slice(0, m.index));
        const after = trimSpacesAndTabsStart(line.slice(m.index + m[0].length));
        if (before !== "") found.add("blockTokenAfterText");
        if (after !== "") found.add("blockTokenBeforeText");
      }
    }
    if (line.includes("{{")) scanTokenPlacement(line, found);
  }
  return found;
}

/** Rules 3-5 over ONE line, in one pass with O(1) work per position. */
function scanTokenPlacement(line: string, found: Set<PlacementRule>): void {
  const n = line.length;
  // nextStar[i]: the first '*' at or after i (n if none); likewise ']'.
  const nextStar = new Int32Array(n + 2).fill(n);
  const nextClose = new Int32Array(n + 2).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    nextStar[i] = line[i] === "*" ? i : nextStar[i + 1];
    nextClose[i] = line[i] === "]" ? i : nextClose[i + 1];
  }
  let lastStar = -1; // the last '*' seen
  let lastOpen = -1; // the last '[' seen
  let lastCloseBracket = -1; // the last ']' seen
  let lastLinkStart = -1; // index just past the last "](" seen
  let lastParen = -1; // the last ')' seen
  for (let i = 0; i < n; i++) {
    const c = line[i];
    if (c === "{" && line[i + 1] === "{") {
      // Rule 3: `**` + no '*' + `{{` + no '*' + `**`. The opener is the last
      // '*' before here, which must itself follow a '*'; the closer is the
      // first '*' after the `{{`, which must be followed by a '*'.
      if (lastStar >= 1 && line[lastStar - 1] === "*") {
        const close = nextStar[i + 2];
        if (close < n - 1 && line[close + 1] === "*") found.add("tokenInBold");
      }
      // Rule 4: `[` + no ']' + `{{` + no ']' + `](`.
      if (lastOpen > lastCloseBracket) {
        const close = nextClose[i + 2];
        if (close < n && line[close + 1] === "(") found.add("tokenInLinkText");
      }
      // Rule 5: `](` + no ')' + `{{`.
      if (lastLinkStart !== -1 && lastLinkStart > lastParen) found.add("tokenInLinkTarget");
    }
    if (c === "*") lastStar = i;
    else if (c === "[") lastOpen = i;
    else if (c === "]") {
      lastCloseBracket = i;
      if (line[i + 1] === "(") lastLinkStart = i + 2;
    } else if (c === ")") lastParen = i;
  }
}

const PLACEMENT_SENTENCES: Record<PlacementRule, string> = {
  blockTokenAfterText: BLOCK_TOKEN_ALONE,
  blockTokenBeforeText: BLOCK_TOKEN_ALONE,
  tokenInBold: TOKEN_IN_BOLD,
  tokenInLinkText: TOKEN_IN_LINK,
  tokenInLinkTarget: TOKEN_IN_LINK,
};

/** Strip every `{{…}}` from text that must not carry one (bold, link text). */
function withoutTokens(text: string): string {
  return text.replace(/\{\{[^{}]*\}\}/g, "");
}

/**
 * Parse the inline content of ONE LINE.
 *
 * A LINEAR SCAN (fix round 1, M5). This was one alternation regex, and its
 * link branch `\[([^\]\n]+)\]\(` backtracked along the rest of the line from
 * every `[`: a 100 000-character body of `[`s took 5.8 s to parse, and the
 * parse runs on every public page view. The scan below makes the same
 * leftmost-first decisions with O(1) work per position, using "next X at or
 * after i" tables built in one backward pass.
 *
 * ONE LINE AT A TIME, so bold and links never span a line break -- which is
 * what lets the database's line-bounded placement patterns see every bold or
 * link span the parser could produce.
 */
function parseInlineLine(source: string, problems: string[], out: Inline[]): void {
  const pushText = (text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + text };
    } else {
      out.push({ kind: "text", text });
    }
  };

  const n = source.length;
  const nextStar = new Int32Array(n + 2).fill(n);
  const nextBracket = new Int32Array(n + 2).fill(n);
  const nextParen = new Int32Array(n + 2).fill(n);
  const nextBrace = new Int32Array(n + 2).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const c = source[i];
    nextStar[i] = c === "*" ? i : nextStar[i + 1];
    nextBracket[i] = c === "]" ? i : nextBracket[i + 1];
    nextParen[i] = c === ")" ? i : nextParen[i + 1];
    nextBrace[i] = c === "{" || c === "}" ? i : nextBrace[i + 1];
  }

  let cursor = 0; // start of the pending literal text
  let i = 0;
  while (i < n) {
    const c = source[i];

    // **strong** -- content is one or more characters, none of them '*'.
    if (c === "*" && source[i + 1] === "*") {
      const close = nextStar[i + 2];
      if (close > i + 2 && close < n - 1 && source[close + 1] === "*") {
        pushText(source.slice(cursor, i));
        const inner = source.slice(i + 2, close);
        if (inner.includes("{{")) problems.push(TOKEN_IN_BOLD);
        out.push({ kind: "strong", text: withoutTokens(inner) });
        i = close + 2;
        cursor = i;
        continue;
      }
    }

    // [text](target) -- text is one or more characters, none of them ']';
    // target is any characters but ')'.
    if (c === "[") {
      const closeText = nextBracket[i + 1];
      if (closeText > i + 1 && closeText < n && source[closeText + 1] === "(") {
        const closeTarget = nextParen[closeText + 2];
        if (closeTarget < n) {
          pushText(source.slice(cursor, i));
          const label = source.slice(i + 1, closeText);
          const target = source.slice(closeText + 2, closeTarget);
          const href = target.includes("{{") ? null : safeHref(target);
          if (label.includes("{{") || target.includes("{{")) problems.push(TOKEN_IN_LINK);
          if (href === null) {
            if (!target.includes("{{")) problems.push(LINK_REFUSED(target));
            // DROPPED TO ITS TEXT, never kept as a link.
            pushText(withoutTokens(label));
          } else {
            out.push({ kind: "link", text: withoutTokens(label), href });
          }
          i = closeTarget + 1;
          cursor = i;
          continue;
        }
      }
    }

    // {{placeholder}}
    if (c === "{" && source[i + 1] === "{") {
      const close = nextBrace[i + 2];
      if (close < n - 1 && source[close] === "}" && source[close + 1] === "}") {
        pushText(source.slice(cursor, i));
        const token = source.slice(i, close + 2);
        if (token === SUPPORT_EMAIL_TOKEN) {
          out.push({ kind: "support-email" });
        } else if (token !== SUBPROCESSORS_TOKEN && token !== STORAGE_INVENTORY_TOKEN) {
          problems.push(TOKEN_UNKNOWN(token));
        }
        // Otherwise dropped entirely. A block placeholder that reached inline
        // parsing is not alone on its line; placementViolations() says so.
        i = close + 2;
        cursor = i;
        continue;
      }
      // An unclosed `{{` is not a placeholder, and the database refuses it
      // (`legal_documents_body_tokens_known`); it stays as text here.
      problems.push(TOKEN_UNKNOWN(source.slice(i, Math.min(n, i + 20))));
    }

    i++;
  }
  pushText(source.slice(cursor));
}

/** Parse the inline content of one or more lines, joined by a space. */
function parseInline(lines: readonly string[], problems: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      const last = out[out.length - 1];
      if (last && last.kind === "text") out[out.length - 1] = { kind: "text", text: `${last.text} ` };
      else out.push({ kind: "text", text: " " });
    }
    parseInlineLine(line, problems, out);
  });
  return out;
}

type Pending =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[][] }
  | null;

/**
 * Parse a stored legal-document body.
 *
 * Total: every input produces blocks, and `problems` says what was dropped or
 * would be refused at save time. The render path ignores `problems`; the save
 * path refuses on any.
 */
export function parseLegalMarkup(source: string): ParsedMarkup {
  const problems: string[] = [];
  const blocks: Block[] = [];

  let text = source.replace(/\r\n?/g, "\n");
  if (TAG_OPENER.test(text)) {
    problems.push(
      "HTML tags are not allowed and have been removed. Use ## for headings, - for lists and **bold** for emphasis.",
    );
    text = text.replace(TAG, "");
  }

  let pending: Pending = null;
  const flush = () => {
    if (pending === null) return;
    if (pending.kind === "paragraph") {
      const content = parseInline(pending.lines, problems);
      if (content.length > 0) blocks.push({ kind: "paragraph", content });
    } else {
      blocks.push({
        kind: "list",
        ordered: pending.ordered,
        items: pending.items.map((item) => parseInline(item, problems)),
      });
    }
    pending = null;
  };

  for (const rawLine of text.split("\n")) {
    // trimEnd() strips exactly the set `/\s+$/` did (ECMAScript WhiteSpace
    // plus LineTerminator), in linear time. The regex was quadratic on a long
    // whitespace run followed by anything else: `" " x 99 990 + "x"` took
    // 4-6 s on every public view (fix round 2, M5).
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      continue;
    }

    const headingText = matchLinePrefix(/^#{1,6}\s+/, trimmed);
    if (headingText !== null) {
      flush();
      const hashes = /^#{1,6}/.exec(trimmed)![0].length;
      if (hashes !== 2 && hashes !== 3) {
        problems.push(
          `“${"#".repeat(hashes)}” headings are not allowed. Use ## for a section and ### for a sub-section — the page title is the document title.`,
        );
      }
      blocks.push({
        kind: "heading",
        level: hashes <= 2 ? 2 : 3,
        content: parseInline([headingText], problems),
      });
      continue;
    }

    // A block placeholder is a block only when it is ALONE on its line,
    // spaces and tabs aside -- exactly the database's rule (M3). Anything
    // else falls through to inline parsing, which drops it and says so.
    if (BLOCK_TOKEN_LINE.test(rawLine)) {
      flush();
      blocks.push({
        kind: trimmed === SUBPROCESSORS_TOKEN ? "subprocessors" : "storage-inventory",
      });
      continue;
    }

    const bullet = matchLinePrefix(/^[-*]\s+/, trimmed);
    const numbered = matchLinePrefix(/^\d+\.\s+/, trimmed);
    const indented = /^\s/.test(line);

    if ((bullet !== null || numbered !== null) && !(indented && pending?.kind === "list")) {
      const ordered = numbered !== null;
      const item = (bullet ?? numbered)!;
      if (pending?.kind === "list" && pending.ordered === ordered) {
        pending.items.push([item]);
      } else {
        flush();
        pending = { kind: "list", ordered, items: [[item]] };
      }
      continue;
    }

    if (pending?.kind === "list" && indented) {
      pending.items[pending.items.length - 1].push(trimmed);
      continue;
    }

    if (pending?.kind === "paragraph") {
      pending.lines.push(trimmed);
    } else {
      flush();
      pending = { kind: "paragraph", lines: [trimmed] };
    }
  }
  flush();

  // The placement rules are checked over the whole body as well, because the
  // bold rule is deliberately wider than what the scan above can see (see
  // PLACEMENT_PATTERNS). Repeats are folded: one sentence per kind.
  for (const rule of placementViolations(text)) problems.push(PLACEMENT_SENTENCES[rule]);
  return { blocks, problems: [...new Set(problems)] };
}

/** The plain text of an inline run -- for tests and for metadata. */
export function inlineText(content: readonly Inline[], supportEmailText: string): string {
  return content
    .map((part) => (part.kind === "support-email" ? supportEmailText : part.text))
    .join("");
}
