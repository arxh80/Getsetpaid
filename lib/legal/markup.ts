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
 *   - `https://` followed by a parseable URL (the scheme compared in lower
 *     case, so `JavaScript:` and `HTTPS://` are both judged on what they are);
 *   - `mailto:` followed by a single address;
 *   - a same-site path: `/` followed by anything that is not a second `/` or a
 *     `\` (both of which a browser treats as a scheme-relative URL to another
 *     host), from a conservative character set.
 * Everything else -- `javascript:`, `data:`, `vbscript:`, `http:`, `//host`,
 * a bare word, a target with whitespace in it -- is refused.
 */
export function safeHref(raw: string): string | null {
  if (raw === "" || /[\s\p{Cc}]/u.test(raw)) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith("https://")) {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && url.hostname !== "" ? raw : null;
    } catch {
      return null;
    }
  }
  if (lower.startsWith("mailto:")) {
    return /^mailto:[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/i.test(raw) ? raw : null;
  }
  if (/^\/(?![/\\])[A-Za-z0-9\-._~/#?=&%]*$/.test(raw)) {
    return raw;
  }
  return null;
}

function describeTarget(raw: string): string {
  const shown = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  return `“${shown}”`;
}

/** Parse the inline content of one line or paragraph. */
function parseInline(source: string, problems: string[]): Inline[] {
  const out: Inline[] = [];
  const pushText = (text: string) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + text };
    } else {
      out.push({ kind: "text", text });
    }
  };

  // One alternation, scanned left to right, so the earliest construct wins and
  // nothing is parsed twice.
  const pattern =
    /\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\n]*)\)|(\{\{[^{}\n]*\}\})/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    pushText(source.slice(cursor, at));
    cursor = at + match[0].length;

    if (match[1] !== undefined) {
      out.push({ kind: "strong", text: match[1] });
    } else if (match[2] !== undefined) {
      const target = match[3] ?? "";
      const href = safeHref(target);
      if (href === null) {
        problems.push(
          `The link ${describeTarget(target)} is not allowed. Links must start with https://, mailto: or a single / for a page on this site.`,
        );
        // DROPPED TO ITS TEXT, never kept as a link.
        pushText(match[2]);
      } else {
        out.push({ kind: "link", text: match[2], href });
      }
    } else if (match[4] === SUPPORT_EMAIL_TOKEN) {
      out.push({ kind: "support-email" });
    } else {
      const token = match[4] ?? "";
      problems.push(
        token === SUBPROCESSORS_TOKEN || token === STORAGE_INVENTORY_TOKEN
          ? `${token} must be on a line of its own.`
          : `${describeTarget(token)} is not a known placeholder. The placeholders are ${KNOWN_TOKENS.join(", ")}.`,
      );
      // Dropped entirely.
    }
  }
  pushText(source.slice(cursor));
  return out;
}

type Pending =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
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
      const content = parseInline(pending.lines.join(" "), problems);
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
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const hashes = heading[1].length;
      if (hashes !== 2 && hashes !== 3) {
        problems.push(
          `“${"#".repeat(hashes)}” headings are not allowed. Use ## for a section and ### for a sub-section — the page title is the document title.`,
        );
      }
      blocks.push({
        kind: "heading",
        level: hashes <= 2 ? 2 : 3,
        content: parseInline(heading[2], problems),
      });
      continue;
    }

    if (trimmed === SUBPROCESSORS_TOKEN || trimmed === STORAGE_INVENTORY_TOKEN) {
      flush();
      blocks.push({
        kind: trimmed === SUBPROCESSORS_TOKEN ? "subprocessors" : "storage-inventory",
      });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    const indented = /^\s/.test(line);

    if ((bullet || numbered) && !(indented && pending?.kind === "list")) {
      const ordered = Boolean(numbered);
      const item = (bullet ?? numbered)![1];
      if (pending?.kind === "list" && pending.ordered === ordered) {
        pending.items.push(item);
      } else {
        flush();
        pending = { kind: "list", ordered, items: [item] };
      }
      continue;
    }

    if (pending?.kind === "list" && indented) {
      const last = pending.items.length - 1;
      pending.items[last] = `${pending.items[last]} ${trimmed}`;
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

  return { blocks, problems };
}

/** The plain text of an inline run -- for tests and for metadata. */
export function inlineText(content: readonly Inline[], supportEmailText: string): string {
  return content
    .map((part) => (part.kind === "support-email" ? supportEmailText : part.text))
    .join("");
}
