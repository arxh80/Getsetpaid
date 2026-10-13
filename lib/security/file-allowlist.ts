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

import { inflateRawSync } from "node:zlib";

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

/** The most central-directory entries an accepted OOXML file may carry. */
const OOXML_MAX_ENTRIES = 10_000;
/** The most bytes `[Content_Types].xml` may inflate to (a zip-bomb fence). */
const CONTENT_TYPES_MAX_BYTES = 1_048_576;

/** One central-directory record, as far as the allowlist needs it. */
interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly encrypted: boolean;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

/**
 * Read a ZIP's central directory, or return null for anything malformed,
 * truncated, ZIP64 or over `OOXML_MAX_ENTRIES`. Every offset is bounds-checked
 * against the buffer before it is read: this parses attacker-supplied bytes.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is 22 bytes plus a comment of at most 65 535.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  // 0xffff / 0xffffffff are the ZIP64 escape values: no Office file needs them.
  if (count === 0xffff || dirOffset === 0xffffffff || count > OOXML_MAX_ENTRIES) return null;
  if (dirOffset + dirSize > eocd) return null;

  const entries: ZipEntry[] = [];
  let at = dirOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localHeaderOffset = buf.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) return null;
    entries.push({
      name: buf.toString(flags & 0x0800 ? "utf8" : "latin1", at + 46, at + 46 + nameLength),
      method,
      encrypted: (flags & 0x0001) !== 0,
      compressedSize,
      localHeaderOffset,
    });
    at = next;
  }
  return entries;
}

/** Inflate one entry's bytes, capped; null if it cannot be read safely. */
function readEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Buffer | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lh = entry.localHeaderOffset;
  if (entry.encrypted || lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
    return null;
  }
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) return null;
  const raw = buf.subarray(start, end);
  if (entry.method === 0) return raw.length <= maxBytes ? raw : null;
  if (entry.method !== 8) return null;
  try {
    // maxOutputLength makes inflate THROW past the cap instead of allocating:
    // a 1 KB deflate stream that claims to be 4 GB stops at 1 MiB.
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
}

/** The main-part content type OOXML declares for each accepted document. */
const OOXML_MAIN_PART: ReadonlyArray<readonly [string, string]> = [
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
];

/**
 * Inspect an OOXML zip container and return its office MIME, or reject.
 *
 * A `.docx` and a `.docm` share the `PK\x03\x04` signature, so the zip magic
 * alone cannot tell a document from a macro-enabled one. This reads the
 * archive's CENTRAL DIRECTORY (every part's name) and INFLATES
 * `[Content_Types].xml` (every part's declared type), because the earlier
 * raw-byte substring scan could be walked past: Office lets the VBA part take
 * any name its relationships point at, and `[Content_Types].xml` is normally
 * deflated, so neither `vbaProject.bin` nor `macroEnabled` need appear in the
 * raw bytes of a working .docm saved as .docx.
 *
 *   - a part named `vbaProject.bin` / `vbaData.xml`, an ActiveX control part,
 *     or a content type naming a VBA project, ActiveX or `macroEnabled` =>
 *     macro file, REJECTED. Either the name or the type is decisive.
 *   - an encrypted entry, a malformed or ZIP64 directory, a missing or
 *     unreadable `[Content_Types].xml` => REJECTED as not a document.
 *   - the main part's content type picks docx / xlsx / pptx; anything else (a
 *     plain zip, a jar, a .dotx template) => REJECTED: only OOXML documents.
 */
function inspectOoxml(bytes: Uint8Array): SniffResult {
  const entries = readCentralDirectory(bytes);
  if (!entries) return { ok: false, reason: REJECT_UNKNOWN };

  if (entries.some((e) => e.encrypted)) return { ok: false, reason: REJECT_UNKNOWN };
  if (
    entries.some((e) => {
      const name = e.name.toLowerCase();
      return (
        name.endsWith("vbaproject.bin") ||
        name.endsWith("vbadata.xml") ||
        name.includes("/activex/")
      );
    })
  ) {
    return { ok: false, reason: REJECT_MACRO };
  }

  const manifest = entries.find((e) => e.name === "[Content_Types].xml");
  const xml = manifest ? readEntry(bytes, manifest, CONTENT_TYPES_MAX_BYTES) : null;
  if (!xml) return { ok: false, reason: REJECT_UNKNOWN };
  const types = xml.toString("utf8");
  if (/macroenabled|vbaproject|ms-office\.activex/i.test(types)) {
    return { ok: false, reason: REJECT_MACRO };
  }

  for (const [mainPart, mime] of OOXML_MAIN_PART) {
    if (types.includes(`"${mainPart}"`)) {
      return { ok: true, mime, ext: CANONICAL_EXT[mime] };
    }
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

/**
 * The filename a download is SAVED under: the display name, made to end in the
 * canonical extension of the type the bytes were sniffed as.
 *
 * The declared extension is never checked against the content at upload (text
 * has no magic bytes), so `payload.bat` or `page.html` is stored as text/plain
 * under its own name. Served as an attachment named `payload.bat`, one
 * double-click would run it on a colleague's machine. Appending the sniffed
 * extension -- `payload.bat.txt` -- makes the saved file open as what it is.
 * A name that already ends in its type's extension is left alone.
 */
export function downloadFilename(name: string, mime: string): string {
  const base = sanitiseFilename(name);
  const ext = CANONICAL_EXT[mime];
  if (!ext) return base;
  const accepted = mime === "image/jpeg" ? ["jpg", "jpeg"] : [ext];
  const dot = base.lastIndexOf(".");
  const current = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return accepted.includes(current) ? base : `${base}.${ext}`;
}
