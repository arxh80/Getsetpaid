// The upload allowlist: a magic-byte content sniff, NOT an extension check.
//
// ===========================================================================
// THE CLIENT'S CONTENT-TYPE AND EXTENSION ARE BOTH UNTRUSTED
// ===========================================================================
// CLAUDE.md § Non-negotiable rules / SECURITY.md § 6: "Accept only a strict
// allowlist of file types (documents, images, PDFs) -- not just MIME/extension
// checks. No executables, no macro-enabled Office formats." A browser sets the
// multipart Content-Type from the file's extension, so trusting it lets an
// attacker rename `payload.exe` to `invoice.pdf` and have it stored as a PDF.
// This module reads the LEADING BYTES and matches a magic-byte signature; the
// sniffed type is what documents.mime_type stores. The declared filename's
// extension is consulted for ONE thing only -- telling text/csv from
// text/plain, which share their bytes -- and is never the authority: a PNG
// renamed `.pdf` is stored as image/png, not rejected and not believed.
//
// The accepted set is exactly the bucket's allowed_mime_types
// (20260902030000): PDF, PNG, JPEG, WebP, GIF, plain text, CSV, and the three
// modern OOXML documents (docx/xlsx/pptx). Macro-enabled OOXML
// (.docm/.xlsm/.pptm) and every executable are rejected.

export interface SniffOk {
  readonly ok: true;
  /** The SNIFFED content type -- what documents.mime_type stores. */
  readonly mime: string;
  /** The canonical extension for the sniffed type (no leading dot). */
  readonly ext: string;
}
export interface SniffRejected {
  readonly ok: false;
  /** A sentence the upload action can show the user. */
  readonly reason: string;
}
export type SniffResult = SniffOk | SniffRejected;

/** The canonical extension for each allowed sniffed MIME. */
const CANONICAL_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

const REJECT_UNKNOWN =
  "That file type isn’t accepted. Upload a PDF, image (PNG, JPEG, WebP, GIF), plain text, CSV, or a Word, Excel or PowerPoint document.";
const REJECT_MACRO =
  "Macro-enabled Office files (.docm, .xlsm, .pptm) aren’t accepted. Save the document without macros and try again.";
const REJECT_EXECUTABLE =
  "Executable files aren’t accepted.";
const REJECT_EMPTY = "That file is empty.";

/** Does `bytes` begin with this exact byte prefix? */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** Bytes `at..at+ascii.length` equal this ASCII string? */
function asciiAt(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (bytes.length < at + ascii.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[at + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

const SIG = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  gif87: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  gif89: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  zip: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04 -- OOXML container
  // Executables, rejected with a specific reason rather than the generic one.
  mz: [0x4d, 0x5a], // DOS/PE (.exe, .dll)
  elf: [0x7f, 0x45, 0x4c, 0x46], // ELF
  machoLe: [0xcf, 0xfa, 0xed, 0xfe],
  machoBe: [0xfe, 0xed, 0xfa, 0xcf],
  javaClass: [0xca, 0xfe, 0xba, 0xbe],
} as const;

/**
 * Inspect an OOXML zip container and return its office MIME, or reject.
 *
 * A `.docx` and a `.docm` share the `PK\x03\x04` signature, so the zip magic
 * alone cannot tell a document from a macro-enabled one. This does NOT unzip:
 * a ZIP stores its ENTRY NAMES uncompressed in every local file header and in
 * the central directory, and OOXML's `[Content_Types].xml` (which names the
 * main-part content type) is customarily stored too -- so the distinguishing
 * strings appear verbatim in the raw bytes whether or not the parts are
 * deflated. We scan for them:
 *
 *   - a `vbaProject.bin` part or a `macroEnabled` content type => macro file,
 *     REJECTED. This is the entry name Office writes for the VBA blob and the
 *     content-type token it writes for .docm/.xlsm/.pptm; either is decisive.
 *   - `word/document.xml` / `wordprocessingml.document`  => docx
 *   - `xl/workbook.xml`   / `spreadsheetml.sheet`        => xlsx
 *   - `ppt/presentation.xml` / `presentationml.presentation` => pptx
 *   - anything else (a plain zip, a jar) => REJECTED: only OOXML is allowed.
 */
function inspectOoxml(bytes: Uint8Array): SniffResult {
  // latin1 keeps every byte 1:1 as a char code, so a substring search over
  // this string is a substring search over the raw bytes.
  const text = Buffer.from(bytes).toString("latin1");
  if (text.includes("vbaProject.bin") || /macroenabled/i.test(text)) {
    return { ok: false, reason: REJECT_MACRO };
  }
  if (text.includes("word/document.xml") || text.includes("wordprocessingml.document")) {
    const mime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return { ok: true, mime, ext: CANONICAL_EXT[mime] };
  }
  if (text.includes("xl/workbook.xml") || text.includes("spreadsheetml.sheet")) {
    const mime =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return { ok: true, mime, ext: CANONICAL_EXT[mime] };
  }
  if (text.includes("ppt/presentation.xml") || text.includes("presentationml.presentation")) {
    const mime =
      "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return { ok: true, mime, ext: CANONICAL_EXT[mime] };
  }
  return { ok: false, reason: REJECT_UNKNOWN };
}

/** The declared filename's lowercased extension, or "" if it has none. */
function declaredExt(name: string): string {
  const base = sanitiseFilename(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Is `bytes` valid UTF-8 with no NUL byte? A NUL is the cheapest tell that a
 * "text" upload is really a binary one; and a strict (fatal) UTF-8 decode
 * rejects arbitrary byte soup that a lenient decode would smuggle through as
 * replacement characters.
 */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0x00)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sniff `bytes`, allow or reject. `declaredName` informs only the text/csv vs
 * text/plain split; it is never the authority for a binary type.
 */
export function sniffAndAllow(bytes: Uint8Array, declaredName: string): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: REJECT_EMPTY };

  // Executables first, so they get the specific sentence, not the generic one.
  if (
    startsWith(bytes, SIG.mz) ||
    startsWith(bytes, SIG.elf) ||
    startsWith(bytes, SIG.machoLe) ||
    startsWith(bytes, SIG.machoBe) ||
    startsWith(bytes, SIG.javaClass)
  ) {
    return { ok: false, reason: REJECT_EXECUTABLE };
  }

  if (startsWith(bytes, SIG.pdf)) {
    return { ok: true, mime: "application/pdf", ext: "pdf" };
  }
  if (startsWith(bytes, SIG.png)) {
    return { ok: true, mime: "image/png", ext: "png" };
  }
  if (startsWith(bytes, SIG.jpeg)) {
    return { ok: true, mime: "image/jpeg", ext: "jpg" };
  }
  if (startsWith(bytes, SIG.gif87) || startsWith(bytes, SIG.gif89)) {
    return { ok: true, mime: "image/gif", ext: "gif" };
  }
  // RIFF....WEBP: bytes 0-3 "RIFF", bytes 8-11 "WEBP" (4-7 are the size).
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return { ok: true, mime: "image/webp", ext: "webp" };
  }
  if (startsWith(bytes, SIG.zip)) {
    return inspectOoxml(bytes);
  }

  // No binary signature matched. The one remaining allowed family is text,
  // which has no magic bytes -- so it is defined by "decodes as UTF-8, no NUL".
  if (isPlainText(bytes)) {
    // Extension picks csv vs plain: same bytes, and the ONLY thing that can
    // distinguish them. Still not "the authority" -- both are accepted, this
    // just records which the user meant.
    const mime = declaredExt(declaredName) === "csv" ? "text/csv" : "text/plain";
    return { ok: true, mime, ext: CANONICAL_EXT[mime] };
  }

  return { ok: false, reason: REJECT_UNKNOWN };
}

/**
 * A safe DISPLAY filename. NEVER a storage key (that is buildStorageKey).
 *
 * Strips any directory part (so `../../etc/passwd` becomes `passwd`), removes
 * control characters, drops leading dots (so `..` / `.bashrc` cannot produce a
 * traversal fragment or a hidden name), trims, and length-caps. Always returns
 * a non-empty string -- "file" if nothing survives -- because documents.filename
 * has a `btrim(filename) <> ''` CHECK and an empty display name helps nobody.
 */
export function sanitiseFilename(name: string): string {
  // Basename: split on BOTH separators, since a Windows client sends
  // backslashes. Take the last non-empty segment.
  const segments = name.split(/[/\\]/);
  let base = segments[segments.length - 1] ?? "";
  base = base.replace(/[\u0000-\u001f\u007f]/g, "");
  base = base.replace(/^\.+/, ""); // leading dots: hidden files, `.`, `..`
  base = base.trim();
  if (base.length > 200) base = base.slice(0, 200);
  base = base.trim();
  return base === "" ? "file" : base;
}
