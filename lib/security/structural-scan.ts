// The production scanner without an antivirus engine (founder Q286): the
// server has no room for ClamAV, so instead of matching signatures this
// refuses the places active content lives in the file types the allowlist
// admits. Images, text and CSV are inert once stored privately and served as
// a download from Storage's own origin; PDFs and Office files are where a
// document can carry code, so those are opened and inspected.
//
//   PDF   any JavaScript, launch, embedded-file, rich-media, XFA, form-submit
//         or additional-action name, in the file's own dictionaries or in an
//         object stream, with #xx name escapes decoded first. An object
//         stream in a filter this cannot read is refused: it could hide them.
//   OOXML an embedded OLE object (where an executable package rides) or an
//         external template, OLE link, frame or sub-document relationship
//         (the remote-template trick). Macros are already refused upstream by
//         the allowlist.
//   any   the EICAR test file, so the quarantine path stays provable.
//
// It runs AFTER sniffAndAllow, so the bytes are already one allowed type. It
// does not catch a malicious image or PDF that exploits a viewer bug with no
// active content: that is what an engine adds, and why ClamAV comes back if
// the host grows (docs/clamav.md).

import { inflateSync } from "node:zlib";
import { readCentralDirectory, readEntry } from "./file-allowlist";
import type { MalwareScanner, ScanResult } from "./malware-scan";

const EICAR_MARKER = "EICAR-STANDARD-" + "ANTIVIRUS-TEST-FILE";

const PDF_ACTIVE =
  /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|AA|SubmitForm|ImportData|GoToE)(?![A-Za-z0-9])/;
const PDF_STREAM = /(?<!end)stream\r?\n/g;
const OBJSTM_MAX_BYTES = 16 * 1024 * 1024;

const OOXML_PART_MAX_BYTES = 1024 * 1024;
const OOXML_EXTERNAL_RISKY =
  /Type="[^"]*\/(attachedTemplate|oleObject|frame|subDocument)"[^>]*TargetMode="External"|TargetMode="External"[^>]*Type="[^"]*\/(attachedTemplate|oleObject|frame|subDocument)"/;

const decodeNameEscapes = (text: string) =>
  text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function ascii85(text: string): Buffer {
  const src = text.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>[\s\S]*$/, "").replace(/z/g, "!!!!!");
  const out: number[] = [];
  for (let i = 0; i < src.length; i += 5) {
    const group = src.slice(i, i + 5);
    let n = 0;
    for (const c of group.padEnd(5, "u")) n = n * 85 + (c.charCodeAt(0) - 33);
    const four = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...four.slice(0, group.length - 1));
  }
  return Buffer.from(out);
}

/** Undo a filter chain this reads (Flate, ASCII85, ASCIIHex); null for any other, or a bad stream. */
function decodeStream(body: Buffer, filters: string[]): Buffer | null {
  let out = body;
  try {
    for (const f of filters) {
      if (f === "FlateDecode") out = inflateSync(out, { maxOutputLength: OBJSTM_MAX_BYTES });
      else if (f === "ASCII85Decode") out = ascii85(out.toString("latin1"));
      else if (f === "ASCIIHexDecode") {
        out = Buffer.from(out.toString("latin1").replace(/>[\s\S]*$/, "").replace(/[^0-9A-Fa-f]/g, ""), "hex");
      } else return null;
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Actions are PDF dictionaries, so they live in the file's plain text or
 * inside an object stream (/ObjStm), never in a page, font or image stream,
 * whose bytes would match an action name by chance. So those are the only
 * two places searched.
 */
function inspectPdf(buf: Buffer): ScanResult {
  const text = buf.toString("latin1");
  let outside = "";
  let from = 0;
  for (const m of text.matchAll(PDF_STREAM)) {
    if (m.index < from) continue; // "stream" inside a body already skipped
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) return "error";
    outside += text.slice(from, m.index);
    from = end + "endstream".length;
    const dict = text.slice(Math.max(0, text.lastIndexOf("obj", m.index)), m.index);
    if (!/\/Type\s*\/ObjStm/.test(dict)) continue;
    const spec = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/)?.[1] ?? "";
    const decoded = decodeStream(buf.subarray(start, end), [...spec.matchAll(/\/([A-Za-z0-9]+)/g)].map((f) => f[1]));
    if (!decoded) return "error";
    if (PDF_ACTIVE.test(decodeNameEscapes(decoded.toString("latin1")))) return "infected";
  }
  outside += text.slice(from);
  return PDF_ACTIVE.test(decodeNameEscapes(outside)) ? "infected" : "clean";
}

function inspectOoxml(bytes: Uint8Array): ScanResult {
  const entries = readCentralDirectory(bytes);
  if (!entries) return "error";
  for (const e of entries) {
    const name = e.name.toLowerCase();
    if (/(^|\/)embeddings\/.*\.bin$/.test(name) || /oleobject\d*\.bin$/.test(name)) return "infected";
    if (name.endsWith(".rels")) {
      const xml = readEntry(bytes, e, OOXML_PART_MAX_BYTES);
      if (!xml) return "error";
      if (OOXML_EXTERNAL_RISKY.test(xml.toString("utf8"))) return "infected";
    }
  }
  return "clean";
}

export class StructuralScanner implements MalwareScanner {
  async scan({ bytes }: { bytes: Uint8Array }): Promise<ScanResult> {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.toString("latin1").includes(EICAR_MARKER)) return "infected";
    if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return inspectPdf(buf);
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return inspectOoxml(bytes);
    return "clean";
  }
}
