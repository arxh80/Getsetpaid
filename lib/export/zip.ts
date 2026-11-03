// A ZIP writer, in about a hundred and fifty lines and with no dependency.
//
// WHY NOT A LIBRARY. `package.json`'s runtime dependencies are eight, every
// one of them declared in tests/unit/legal/storage-census.test.ts with what it
// stores in a browser, and adding a ninth to write a well-documented 1989
// container format would be a real supply-chain decision for very little. The
// format used here is the smallest legal subset: local file headers, DEFLATE
// from node:zlib, a central directory and an end-of-central-directory record.
// No ZIP64, no encryption, no data descriptors.
//
// THAT SUBSET HAS A CEILING AND IT IS CHECKED, not assumed: without ZIP64 an
// archive cannot exceed 4 GiB, hold more than 65 535 entries or contain an
// entry over 4 GiB. `private.export_limits().max_archive_bytes` is 40 MiB, so
// none is reachable — but every one is refused anyway, because "a limit we are
// far below" is how a silent corruption ships two years later.
//
// WHAT IS AND IS NOT IN MEMORY, stated exactly rather than as "streaming":
// rows arrive a page at a time and are serialised to bytes as they arrive, so
// no table's rows are ever all held as OBJECTS; the serialised bytes of one
// table are held until that table's entry is closed, and the finished archive
// is held whole, because Supabase Storage's upload takes a body rather than a
// stream and a temporary file would be a second place for personal data to
// live. Both are bounded by the same ceiling: `push()` throws the moment the
// running total passes it, so the job FAILS with a recorded reason instead of
// truncating.

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what a ZIP header carries. */
function dosDateTime(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time:
      (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  };
}

const MAX_ENTRIES = 65_535;
const MAX_UINT32 = 0xffffffff;
/** The end-of-central-directory record is a fixed 22 bytes (no comment). */
const END_RECORD_BYTES = 22;

interface Entry {
  readonly name: string;
  readonly offset: number;
  readonly crc: number;
  readonly method: number;
  readonly compressed: number;
  readonly uncompressed: number;
  readonly date: number;
  readonly time: number;
}

/**
 * Thrown the moment the archive passes its ceiling, so the job fails with a
 * recorded reason rather than truncating. A truncated statutory access
 * response is a wrong answer given with confidence.
 */
export class ExportTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly ceiling: number,
  ) {
    super(
      `The archive passed its ${ceiling}-byte ceiling while it was being written (${bytes} bytes). Nothing was truncated: the export failed instead.`,
    );
    this.name = "ExportTooLargeError";
  }
}

export class ZipWriter {
  private readonly chunks: Buffer[] = [];
  private readonly entries: Entry[] = [];
  private size = 0;
  private held = 0;
  /** 46 + name bytes per entry already added: what finish() will append. */
  private directoryBytes = 0;
  private finished = false;
  private readonly entryCeiling: number;

  /**
   * `byteCeiling` bounds BOTH the archive written so far and the serialised
   * bytes being held for an entry that is still open, so neither half can
   * grow without the job failing.
   *
   * `entryCeiling` (Q228) bounds the entry count, and is capped at 65 535 --
   * the most a zip without ZIP64 can hold -- whatever a caller asks for.
   */
  constructor(
    private readonly byteCeiling: number,
    entryCeiling: number = MAX_ENTRIES,
  ) {
    this.entryCeiling = Math.min(MAX_ENTRIES, entryCeiling);
  }

  /** The entry ceiling in force, after the 65 535 cap. */
  get entryLimit(): number {
    return this.entryCeiling;
  }

  /** The central-directory bytes finish() will append for the entries so far. */
  get directoryByteLength(): number {
    return this.directoryBytes;
  }

  /**
   * Q228: WOULD THIS ENTRY STILL LEAVE A FINISHABLE ARCHIVE? The question a
   * parted builder asks BEFORE writing, so it can close a part instead of
   * failing the job.
   *
   * True when, with `rawBytes` written under `name` and `reserveBytes` /
   * `reserveEntries` still owed (the part's manifest), the finished archive --
   * local headers, payloads, the WHOLE central directory including every entry
   * already added, and the end record -- stays within `byteCeiling`, and the
   * entry count within the entry ceiling. `rawBytes` is the input's length,
   * an upper bound: a stored payload is never larger than its input and a
   * deflated one is only kept when it is smaller.
   */
  wouldFit(name: string, rawBytes: number, reserveBytes = 0, reserveEntries = 0): boolean {
    const nameLen = Buffer.byteLength(name, "utf8");
    const bytes =
      this.size +
      this.held +
      30 +
      nameLen +
      rawBytes +
      this.directoryBytes +
      46 +
      nameLen +
      END_RECORD_BYTES +
      reserveBytes;
    return bytes <= this.byteCeiling && this.entries.length + 1 + reserveEntries <= this.entryCeiling;
  }

  get byteLength(): number {
    return this.size;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  /** Accounts for bytes a caller is holding for an entry it has not closed. */
  hold(bytes: number): void {
    this.held += bytes;
    this.checkCeiling();
  }

  releaseHold(bytes: number): void {
    this.held = Math.max(0, this.held - bytes);
  }

  addEntry(
    name: string,
    data: Uint8Array,
    at: Date = new Date(),
    options: { readonly store?: boolean } = {},
  ): void {
    if (this.finished) throw new Error("zip: the archive is already finished");
    if (this.entries.length >= this.entryCeiling) {
      throw new Error(
        this.entryCeiling === MAX_ENTRIES
          ? `zip: more than ${MAX_ENTRIES} entries needs ZIP64`
          : `zip: more than ${this.entryCeiling} entries passes this archive's entry ceiling`,
      );
    }
    if (data.length > MAX_UINT32) {
      throw new Error("zip: an entry over 4 GiB needs ZIP64");
    }
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 0xffff) throw new Error("zip: entry name is too long");

    const crc = crc32(data);
    // level 6 is zlib's default: the difference to 9 on JSON is a percent or
    // two of size for several times the CPU, and this runs on a request's
    // tail.
    //
    // `store` (Q228) skips DEFLATE: the closure-backup index states its own
    // part's byte length, which is only computable in advance when the
    // manifest's payload length is its input length.
    const deflated =
      data.length === 0 || options.store ? Buffer.alloc(0) : deflateRawSync(data, { level: 6 });
    // DEFLATE can be LARGER than its input on already-compressed bytes (a PDF,
    // a PNG). Store those rather than growing them.
    const stored = options.store === true || deflated.length >= data.length;
    const payload = stored ? Buffer.from(data) : deflated;
    const method = stored ? 0 : 8;

    const { date, time } = dosDateTime(at);
    const offset = this.size;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    this.push(header);
    this.push(nameBytes);
    this.push(payload);

    this.directoryBytes += 46 + nameBytes.length;
    this.entries.push({
      name,
      offset,
      crc,
      method,
      compressed: payload.length,
      uncompressed: data.length,
      date,
      time,
    });
  }

  addJson(name: string, value: unknown, at: Date = new Date()): void {
    this.addEntry(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), at);
  }

  /** The finished archive. */
  finish(): Buffer {
    if (this.finished) throw new Error("zip: the archive is already finished");
    this.finished = true;

    const directory: Buffer[] = [];
    let directorySize = 0;
    for (const entry of this.entries) {
      const nameBytes = Buffer.from(entry.name, "utf8");
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.uncompressed, 24);
      record.writeUInt16LE(nameBytes.length, 28);
      record.writeUInt16LE(0, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      record.writeUInt32LE(0, 38);
      record.writeUInt32LE(entry.offset, 42);
      directory.push(record, nameBytes);
      directorySize += record.length + nameBytes.length;
    }

    // The byte at which the central directory starts, captured BEFORE the
    // ceiling accounting below adds the directory to the running total: the
    // end record carries this offset and it is not the archive's length.
    const directoryOffset = this.size;

    if (this.size > MAX_UINT32) throw new Error("zip: an archive over 4 GiB needs ZIP64");

    // THE DIRECTORY COUNTS TOO. `push()` guards every local header and every
    // payload, but the central directory and the end record are appended
    // here, so without this the DELIVERED archive could exceed
    // private.export_limits().max_archive_bytes by ~46 bytes plus the name
    // per entry, plus 22. Today that is about two kilobytes against ten
    // mebibytes of headroom between the 40 MiB job ceiling and the 50 MiB
    // bucket limit -- unreachable, and exactly the argument this file's own
    // header rejects when it declines ZIP64 ("a limit we are far below is how
    // a silent corruption ships two years later"). Task 4 review, finding M4.
    //
    // It is counted through `size`/`checkCeiling()` rather than compared by
    // hand, so the one ceiling expression stays in one place and a job that
    // trips it fails with the same ExportTooLargeError and the same recorded
    // reason as one that tripped on a row.
    this.size += directorySize + END_RECORD_BYTES;
    this.checkCeiling();

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...this.chunks, ...directory, end]);
  }

  private push(chunk: Buffer): void {
    this.size += chunk.length;
    this.checkCeiling();
    this.chunks.push(chunk);
  }

  private checkCeiling(): void {
    if (this.size + this.held > this.byteCeiling) {
      throw new ExportTooLargeError(this.size + this.held, this.byteCeiling);
    }
  }
}
