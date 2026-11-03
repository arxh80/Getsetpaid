// The archive writer, read back by a DIFFERENT implementation.
//
// A zip test that only checked "the bytes came out" would pass for a file no
// tool on earth can open, which is the worst possible way to fail a statutory
// access request. So every assertion here parses the archive back from its
// END-OF-CENTRAL-DIRECTORY record — the way a real unzip does, not the way
// the writer laid it out — and inflates each entry with node:zlib.

import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { crc32, ExportTooLargeError, ZipWriter } from "@/lib/export/zip";

interface ReadEntry {
  name: string;
  data: Buffer;
  method: number;
}

/** A minimal ZIP reader: find the EOCD, walk the central directory. */
function readZip(archive: Buffer): ReadEntry[] {
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const out: ReadEntry[] = [];

  for (let n = 0; n < count; n += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("central directory record has the wrong signature");
    }
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`local header for ${name} has the wrong signature`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);

    expect(data.length, `${name}: the directory's uncompressed size is wrong`).toBe(
      uncompressedSize,
    );
    expect(crc32(data), `${name}: the CRC does not match the bytes`).toBe(crc);

    out.push({ name, data, method });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const AT = new Date("2026-09-27T12:34:56Z");

describe("ZipWriter", () => {
  it("writes an archive a reader can walk from its own directory", () => {
    const zip = new ZipWriter(1_000_000);
    zip.addJson("manifest.json", { schemaVersion: 1, note: "héllo — ünicode" }, AT);
    zip.addEntry("tables/contacts.json", Buffer.from("[]\n", "utf8"), AT);
    const archive = zip.finish();

    const entries = readZip(archive);
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", "tables/contacts.json"]);
    expect(JSON.parse(entries[0].data.toString("utf8"))).toEqual({
      schemaVersion: 1,
      note: "héllo — ünicode",
    });
    expect(entries[1].data.toString("utf8")).toBe("[]\n");
  });

  it("compresses compressible bytes and STORES incompressible ones", () => {
    const zip = new ZipWriter(10_000_000);
    zip.addEntry("compressible.json", Buffer.from("a".repeat(5000), "utf8"), AT);
    // Deterministic pseudo-random bytes: DEFLATE cannot shrink these, and a
    // naive writer would store a payload LARGER than the input and claim it
    // was deflated.
    const noise = Buffer.alloc(4096);
    let seed = 1;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed >> 16) & 0xff;
    }
    zip.addEntry("noise.bin", noise, AT);

    const entries = readZip(zip.finish());
    expect(entries[0].method, "a repetitive file was stored rather than deflated").toBe(8);
    expect(entries[1].method, "incompressible bytes were deflated and grew").toBe(0);
    expect(entries[1].data.equals(noise)).toBe(true);
  });

  it("round-trips an empty entry", () => {
    const zip = new ZipWriter(1000);
    zip.addEntry("empty.json", Buffer.alloc(0), AT);
    const entries = readZip(zip.finish());
    expect(entries[0].data.length).toBe(0);
  });

  it("throws the moment the ceiling is passed, and does not truncate", () => {
    // INCOMPRESSIBLE bytes on purpose. The first version of this test used
    // Buffer.alloc(4096) — 4 KiB of zeros, which DEFLATE turns into about
    // thirty bytes — and passed the 256-byte ceiling without noticing,
    // proving nothing. The ceiling is measured on what is WRITTEN.
    const zip = new ZipWriter(256);
    const noise = Buffer.alloc(4096);
    let seed = 7;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed >> 16) & 0xff;
    }
    expect(() => zip.addEntry("big.bin", noise, AT)).toThrow(ExportTooLargeError);
  });

  it("counts bytes a caller is still holding against the same ceiling", () => {
    const zip = new ZipWriter(1024);
    zip.hold(1000);
    expect(() => zip.addEntry("small.json", Buffer.from("[]"), AT)).toThrow(ExportTooLargeError);
    zip.releaseHold(1000);
    expect(() => zip.addEntry("small.json", Buffer.from("[]"), AT)).not.toThrow();
  });

  it("counts the central directory against the ceiling too", () => {
    // THE DIRECTORY IS PART OF THE DELIVERED FILE. `push()` guards every
    // local header and payload; the central directory and the 22-byte end
    // record are appended by finish(), so before Task 4's fix round the
    // archive HANDED TO STORAGE could exceed max_archive_bytes by ~46 bytes
    // plus the name per entry, plus 22 (review finding M4).
    //
    // A ceiling chosen to fit every entry and NOT the directory: the entry
    // costs 30 + name + payload, and the directory costs 46 + name.
    const name = "tables/notes.json";
    const payload = Buffer.from("[]");
    const entryBytes = 30 + name.length + payload.length;
    const ceiling = entryBytes + 10; // room for the entry, not for 46 + name + 22

    const zip = new ZipWriter(ceiling);
    zip.addEntry(name, payload, AT);
    expect(zip.byteLength).toBe(entryBytes); // the entry itself fitted
    expect(() => zip.finish()).toThrow(ExportTooLargeError);
  });

  it("still finishes when the directory fits, and the end record is correct", () => {
    // The positive control for the assertion above: with room for the
    // directory the archive is produced, and the end record's
    // central-directory OFFSET is the byte where the directory starts, not
    // the archive's length -- which is what the ceiling accounting must not
    // disturb. Read back through the test's own parser.
    const name = "tables/notes.json";
    const payload = Buffer.from("[]");
    const entryBytes = 30 + name.length + payload.length;
    const zip = new ZipWriter(entryBytes + 46 + name.length + 22);
    zip.addEntry(name, payload, AT);
    const bytes = zip.finish();
    expect(readZip(bytes).map((e) => e.name)).toEqual([name]);
    // offset of the central directory, from the end-of-central-directory record
    expect(bytes.readUInt32LE(bytes.length - 22 + 16)).toBe(entryBytes);
    expect(bytes.readUInt32LE(bytes.length - 22 + 12)).toBe(46 + name.length);
  });

  it("refuses to be finished twice", () => {
    const zip = new ZipWriter(1000);
    zip.addEntry("a.json", Buffer.from("1"), AT);
    zip.finish();
    expect(() => zip.finish()).toThrow(/already finished/);
    expect(() => zip.addEntry("b.json", Buffer.from("2"), AT)).toThrow(/already finished/);
  });

  it("crc32 agrees with the published check value", () => {
    // The CRC-32 of "123456789" is 0xCBF43926 in every reference
    // implementation, so this is a fixture nobody had to derive from ours.
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });
});

// ===========================================================================
// Q228: wouldFit -- the question a parted builder asks BEFORE it writes, so a
// part is closed before a ceiling would be passed instead of the job failing.
// ===========================================================================
function noiseOf(length: number, seed0: number): Buffer {
  const out = Buffer.alloc(length);
  let seed = seed0;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed >> 16) & 0xff;
  }
  return out;
}

describe("wouldFit", () => {
  // The ceiling is chosen so that EXACTLY `fitting` raw bytes of an
  // incompressible (stored) payload land the finished archive on the ceiling.
  // Three entries are added first, so the central directory already owes
  // 3 x (46 + name) bytes the check must count.
  const FILLERS = ["tables/a.json", "tables/bb.json", "tables/ccc.json"];
  const NAME = "files/documents/x.bin";
  const fillerBytes = 200;

  function filled(ceiling: number): ZipWriter {
    const zip = new ZipWriter(ceiling);
    FILLERS.forEach((n, i) => zip.addEntry(n, noiseOf(fillerBytes, 11 + i), AT));
    return zip;
  }
  const local = FILLERS.reduce((s, n) => s + 30 + n.length + fillerBytes, 0);
  const directory = FILLERS.reduce((s, n) => s + 46 + n.length, 0);
  const fitting = 1000;
  const ceiling = local + directory + 30 + NAME.length + fitting + 46 + NAME.length + 22;

  it("is true exactly up to the byte where addEntry + finish() lands on the ceiling", () => {
    const zip = filled(ceiling);
    expect(zip.wouldFit(NAME, fitting)).toBe(true);
    zip.addEntry(NAME, noiseOf(fitting, 99), AT);
    const archive = zip.finish();
    expect(archive.length).toBe(ceiling);
    expect(readZip(archive).map((e) => e.name)).toEqual([...FILLERS, NAME]);

    // One byte more, on a fresh copy, does not fit -- and really would not.
    const fresh = filled(ceiling);
    expect(fresh.wouldFit(NAME, fitting + 1)).toBe(false);
    fresh.addEntry(NAME, noiseOf(fitting + 1, 99), AT);
    expect(() => fresh.finish()).toThrow(ExportTooLargeError);
  });

  it("counts the central directory of the entries already added (mutant T1)", () => {
    // Without the three fillers' directory records the check would see
    // `directory` bytes of room that do not exist.
    const zip = filled(ceiling - 1);
    expect(zip.wouldFit(NAME, fitting)).toBe(false);
    expect(zip.wouldFit(NAME, fitting - 1)).toBe(true);
    const shortOfDirectory = filled(ceiling - directory);
    expect(shortOfDirectory.wouldFit(NAME, fitting - directory + 1)).toBe(false);
  });

  it("counts reserved bytes as if already written", () => {
    const zip = filled(ceiling);
    expect(zip.wouldFit(NAME, fitting - 100, 100)).toBe(true);
    expect(zip.wouldFit(NAME, fitting - 100, 101)).toBe(false);
  });

  it("refuses when entryCount + 1 + reserveEntries passes the entry ceiling", () => {
    const zip = new ZipWriter(1e6, 5);
    zip.addEntry("a", Buffer.from("1"), AT);
    zip.addEntry("b", Buffer.from("2"), AT);
    zip.addEntry("c", Buffer.from("3"), AT);
    expect(zip.wouldFit("d", 1, 0, 1)).toBe(true); // 3 + 1 + 1 = 5
    expect(zip.wouldFit("d", 1, 0, 2)).toBe(false); // 3 + 1 + 2 = 6
  });

  it("new ZipWriter(1e6, 3) lets three entries in and refuses the fourth", () => {
    const zip = new ZipWriter(1e6, 3);
    for (const n of ["a", "b", "c"]) {
      expect(zip.wouldFit(n, 1)).toBe(true);
      zip.addEntry(n, Buffer.from(n), AT);
    }
    expect(zip.wouldFit("d", 1)).toBe(false);
    expect(() => zip.addEntry("d", Buffer.from("d"), AT)).toThrow(/entries/);
  });

  it("caps the entry ceiling at 65 535, the most a zip without ZIP64 can hold", () => {
    expect(new ZipWriter(1e6, 70_000).entryLimit).toBe(65_535);
    expect(new ZipWriter(1e6).entryLimit).toBe(65_535);
    expect(new ZipWriter(1e6, 6).entryLimit).toBe(6);
  });
});
