import { describe, expect, it } from "vitest";
import { ZipWriter } from "@/lib/export/zip";
import {
  downloadFilename,
  sanitiseFilename,
  sniffAndAllow,
} from "@/lib/security/file-allowlist";

// The magic-byte allowlist. The declared extension/Content-Type is the
// client's word and is never the authority for a binary type -- SECURITY.md
// § 6, "not just MIME/extension checks. No executables, no macro-enabled Office
// formats."

/** latin1 keeps each char at its byte value, matching what sniffAndAllow reads. */
function bytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "latin1"));
}

const MAIN = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  docm: "application/vnd.ms-word.document.macroEnabled.main+xml",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
} as const;

/** A `[Content_Types].xml` naming `part` as the main part of type `main`. */
function contentTypes(part: string, main: string, extra = ""): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    extra +
    `<Override PartName="/${part}" ContentType="${main}"/>` +
    "</Types>"
  );
}

/**
 * A REAL zip, written by the export ZipWriter: names in the central directory,
 * parts deflated exactly as Office writes them. `[Content_Types].xml` is
 * compressible XML, so it is deflated here too -- which is why a raw-byte
 * substring scan cannot see the content types it declares.
 */
function zip(parts: Record<string, string>): Uint8Array {
  const w = new ZipWriter(64 * 1024 * 1024);
  for (const [name, body] of Object.entries(parts)) w.addEntry(name, Buffer.from(body, "utf8"));
  return Uint8Array.from(w.finish());
}

function ooxml(part: string, main: string, more: Record<string, string> = {}, extraTypes = "") {
  return zip({
    "[Content_Types].xml": contentTypes(part, main, extraTypes),
    "_rels/.rels": "<Relationships/>",
    [part]: "<document/>",
    ...more,
  });
}

describe("sniffAndAllow -- content sniff, not extension", () => {
  it("a real PDF header is accepted as application/pdf", () => {
    const r = sniffAndAllow(bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"), "contract.pdf");
    expect(r).toEqual({ ok: true, mime: "application/pdf", ext: "pdf" });
  });

  it("a PNG renamed .pdf is sniffed as PNG -- extension is NOT the authority", () => {
    // MUTATION GUARD: make sniffAndAllow trust the declared extension and this
    // goes red (it would report application/pdf, or reject).
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = sniffAndAllow(png, "totally-a.pdf");
    expect(r.ok).toBe(true);
    expect(r.ok && r.mime).toBe("image/png");
  });

  it("JPEG, GIF and WebP are recognised by their signatures", () => {
    expect(sniffAndAllow(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "p.jpg")).toMatchObject({
      ok: true,
      mime: "image/jpeg",
    });
    expect(sniffAndAllow(bytes("GIF89a....."), "p.gif")).toMatchObject({
      ok: true,
      mime: "image/gif",
    });
    expect(sniffAndAllow(bytes("RIFF\x00\x00\x00\x00WEBPVP8 "), "p.webp")).toMatchObject({
      ok: true,
      mime: "image/webp",
    });
  });

  it("an .exe (MZ) renamed .pdf is rejected", () => {
    // MUTATION GUARD: trusting the declared extension makes this go red too.
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const r = sniffAndAllow(exe, "invoice.pdf");
    expect(r.ok).toBe(false);
  });

  it("an ELF binary is rejected", () => {
    expect(sniffAndAllow(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 1]), "x.pdf").ok).toBe(false);
  });

  it("a plain .docx is accepted; the equivalent macro .docm is rejected", () => {
    const docx = ooxml("word/document.xml", MAIN.docx);
    const rdocx = sniffAndAllow(docx, "brief.docx");
    expect(rdocx.ok).toBe(true);
    expect(rdocx.ok && rdocx.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Same document, but with the VBA part and the macro-enabled content type.
    const docm = ooxml("word/document.xml", MAIN.docm, { "word/vbaProject.bin": "VBA" });
    expect(sniffAndAllow(docm, "brief.docx")).toMatchObject({ ok: false, reason: expect.stringMatching(/macro/i) });
  });

  it("a plain .xlsx and .pptx are accepted", () => {
    expect(sniffAndAllow(ooxml("xl/workbook.xml", MAIN.xlsx), "book.xlsx")).toMatchObject({
      ok: true,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(sniffAndAllow(ooxml("ppt/presentation.xml", MAIN.pptx), "deck.pptx")).toMatchObject({
      ok: true,
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  });

  it("a plain zip that is not OOXML is rejected", () => {
    expect(sniffAndAllow(zip({ "random/file.txt": "hello" }), "stuff.zip").ok).toBe(false);
  });

  it("a .dotx template is not one of the three accepted documents", () => {
    expect(sniffAndAllow(ooxml("word/document.xml", MAIN.dotx), "letter.docx").ok).toBe(false);
  });
});

describe("sniffAndAllow -- macros the old raw-byte scan could not see", () => {
  // MUTATION GUARD for all four: restore the raw-byte substring scan (look for
  // `vbaProject.bin` / `macroEnabled` in the undecoded bytes, accept on
  // `word/document.xml`) and each of these is ACCEPTED as a docx -- the
  // decisive strings live only inside the deflated [Content_Types].xml.

  it("a VBA part under another name, declared only by its deflated content type", () => {
    const sneaky = ooxml(
      "word/document.xml",
      MAIN.docx,
      { "word/innocuous.bin": "VBA" },
      '<Override PartName="/word/innocuous.bin" ContentType="application/vnd.ms-office.vbaProject"/>',
    );
    expect(sniffAndAllow(sneaky, "brief.docx")).toMatchObject({ ok: false, reason: expect.stringMatching(/macro/i) });
  });

  it("a macro-enabled main part declared only in the deflated content types", () => {
    expect(sniffAndAllow(ooxml("word/document.xml", MAIN.docm), "brief.docx")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/macro/i),
    });
  });

  it("an ActiveX control part is rejected by name", () => {
    const activex = ooxml("word/document.xml", MAIN.docx, { "word/activeX/activeX1.bin": "X" });
    expect(sniffAndAllow(activex, "brief.docx").ok).toBe(false);
  });

  it("vbaData.xml (the VBA project's data part) is rejected by name", () => {
    const vba = ooxml("word/document.xml", MAIN.docx, { "word/vbaData.xml": "<vba/>" });
    expect(sniffAndAllow(vba, "brief.docx").ok).toBe(false);
  });
});

describe("sniffAndAllow -- malformed and hostile zips", () => {
  it("a zip with no [Content_Types].xml is rejected", () => {
    expect(sniffAndAllow(zip({ "word/document.xml": "<document/>" }), "a.docx").ok).toBe(false);
  });

  it("a truncated zip (no end-of-central-directory record) is rejected", () => {
    const whole = ooxml("word/document.xml", MAIN.docx);
    expect(sniffAndAllow(whole.subarray(0, whole.length - 30), "a.docx").ok).toBe(false);
  });

  it("an encrypted entry is rejected", () => {
    const z = Buffer.from(ooxml("word/document.xml", MAIN.docx));
    // Set the encryption bit on the first central-directory record.
    const dir = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt16LE(z.readUInt16LE(dir + 8) | 0x0001, dir + 8);
    expect(sniffAndAllow(Uint8Array.from(z), "a.docx").ok).toBe(false);
  });

  it("a [Content_Types].xml that inflates past the 1 MiB fence is rejected, not allocated", () => {
    // ~2 MiB of padding deflates to a few KB: the zip-bomb shape.
    const bomb = ooxml("word/document.xml", MAIN.docx, {}, " ".repeat(2 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(sniffAndAllow(bomb, "a.docx").ok).toBe(false);
  });
});

describe("downloadFilename -- the name a download is saved under", () => {
  it("keeps a name that already ends in its sniffed type's extension", () => {
    expect(downloadFilename("contract.pdf", "application/pdf")).toBe("contract.pdf");
    expect(downloadFilename("Photo.JPEG", "image/jpeg")).toBe("Photo.JPEG");
    expect(downloadFilename("photo.jpg", "image/jpeg")).toBe("photo.jpg");
  });

  it("a script stored as text is saved as .txt, never under its runnable extension", () => {
    // MUTATION GUARD: return sanitiseFilename(name) unchanged and these go red.
    expect(downloadFilename("payload.bat", "text/plain")).toBe("payload.bat.txt");
    expect(downloadFilename("page.html", "text/plain")).toBe("page.html.txt");
    expect(downloadFilename("image.svg", "text/plain")).toBe("image.svg.txt");
  });

  it("a PNG uploaded as invoice.exe is saved as a .png", () => {
    expect(downloadFilename("invoice.exe", "image/png")).toBe("invoice.exe.png");
  });

  it("is sanitised like the display name", () => {
    expect(downloadFilename("../../x.pdf", "application/pdf")).toBe("x.pdf");
  });
});

describe("sniffAndAllow -- text and empty files", () => {
  it("UTF-8 text is accepted; the extension picks csv vs plain", () => {
    expect(sniffAndAllow(bytes("hello, world\nsecond line\n"), "notes.txt")).toMatchObject({
      ok: true,
      mime: "text/plain",
    });
    expect(sniffAndAllow(bytes("a,b,c\n1,2,3\n"), "data.csv")).toMatchObject({
      ok: true,
      mime: "text/csv",
    });
  });

  it("text with a NUL byte is rejected (a binary masquerading as text)", () => {
    expect(sniffAndAllow(bytes("abc\x00def"), "notes.txt").ok).toBe(false);
  });

  it("an empty file is rejected", () => {
    expect(sniffAndAllow(new Uint8Array(0), "empty.pdf").ok).toBe(false);
  });
});

describe("sanitiseFilename -- a DISPLAY string, never a storage key", () => {
  it("a traversing path becomes a flat safe name", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitiseFilename("C:\\Users\\me\\secret.pdf")).toBe("secret.pdf");
  });

  it("strips control characters and leading dots", () => {
    expect(sanitiseFilename("\u0000\u0001report.pdf")).toBe("report.pdf");
    expect(sanitiseFilename("...hidden")).toBe("hidden");
  });

  it("never returns an empty string", () => {
    expect(sanitiseFilename("..")).toBe("file");
    expect(sanitiseFilename("/")).toBe("file");
    expect(sanitiseFilename("")).toBe("file");
  });

  it("length-caps a very long name", () => {
    expect(sanitiseFilename("a".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
