import { describe, expect, it } from "vitest";
import { sanitiseFilename, sniffAndAllow } from "@/lib/security/file-allowlist";

// The magic-byte allowlist. The declared extension/Content-Type is the
// client's word and is never the authority for a binary type -- SECURITY.md
// § 6, "not just MIME/extension checks. No executables, no macro-enabled Office
// formats."

/** latin1 keeps each char at its byte value, matching what sniffAndAllow reads. */
function bytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "latin1"));
}

/**
 * A minimal OOXML-ish container. The sniffer does not unzip -- it relies on the
 * fact that a ZIP stores its ENTRY NAMES uncompressed in every header, so the
 * distinguishing part names appear verbatim in the raw bytes. These fixtures
 * therefore just prepend the PK signature to the marker strings the sniffer
 * looks for, which exercises exactly the sniffer's real code path.
 */
function ooxml(...markers: string[]): Uint8Array {
  return bytes("PK\x03\x04" + markers.join("\x00"));
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
    const docx = ooxml("[Content_Types].xml", "word/document.xml", "wordprocessingml.document");
    const rdocx = sniffAndAllow(docx, "brief.docx");
    expect(rdocx.ok).toBe(true);
    expect(rdocx.ok && rdocx.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Same document, but with the VBA part and the macro-enabled content type.
    const docm = ooxml(
      "[Content_Types].xml",
      "word/document.xml",
      "word/vbaProject.bin",
      "application/vnd.ms-word.document.macroEnabled.main+xml",
    );
    expect(sniffAndAllow(docm, "brief.docx").ok).toBe(false);
  });

  it("a plain .xlsx and .pptx are accepted", () => {
    expect(
      sniffAndAllow(ooxml("xl/workbook.xml", "spreadsheetml.sheet"), "book.xlsx").ok,
    ).toBe(true);
    expect(
      sniffAndAllow(ooxml("ppt/presentation.xml", "presentationml.presentation"), "deck.pptx").ok,
    ).toBe(true);
  });

  it("a plain zip that is not OOXML is rejected", () => {
    expect(sniffAndAllow(ooxml("random/file.txt"), "stuff.zip").ok).toBe(false);
  });

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
