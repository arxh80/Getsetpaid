import { describe, expect, it } from "vitest";
import { ClamdScanner } from "@/lib/security/malware-scan";
import { ZipWriter } from "@/lib/export/zip";

// The REAL-ENGINE proof for Q42: the same ClamdScanner the upload actions use,
// against a running clamd. Opt-in, because it needs the ClamAV container
// (docker compose -f docker/clamav/compose.yml up -d, then wait for the
// signatures to load) -- set CLAMAV_LIVE_HOST=127.0.0.1 to run it. Skipped
// otherwise, so `pnpm test` stays green on a machine without ClamAV.
const host = process.env.CLAMAV_LIVE_HOST;
const port = Number(process.env.CLAMAV_LIVE_PORT ?? 3310);

// Assembled from fragments so this source file never holds the contiguous
// EICAR signature (a developer's own antivirus would quarantine it).
const EICAR = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}" + "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!" + "$H+H*",
  "latin1",
);

describe.runIf(host)("ClamdScanner against a live clamd", () => {
  const scanner = new ClamdScanner({ host: host!, port, timeoutMs: 60_000 });

  it("passes a clean PDF-shaped file", async () => {
    expect(await scanner.scan({ bytes: Buffer.from("%PDF-1.7\nhello\n%%EOF\n") })).toBe("clean");
  });

  it("flags the EICAR test file", async () => {
    expect(await scanner.scan({ bytes: EICAR })).toBe("infected");
  });

  it("flags EICAR hidden inside a zip (the shape of a docx)", async () => {
    // Deflated by hand so the archive does NOT contain the EICAR bytes
    // verbatim: only an engine that unpacks the zip can find it. ZipWriter
    // would store a 68-byte entry uncompressed (deflate does not shrink it),
    // so the padding makes deflate win.
    const zip = new ZipWriter(1024 * 1024);
    zip.addEntry("word/document.xml", Buffer.concat([EICAR, Buffer.alloc(4096, 0x20)]));
    const bytes = zip.finish();
    expect(bytes.includes(EICAR)).toBe(false);
    expect(await scanner.scan({ bytes })).toBe("infected");
  });

  it("scans a file at the 25 MiB upload cap without a size-limit error", async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 0x41);
    expect(await scanner.scan({ bytes })).toBe("clean");
  });

  it("flags EICAR placed at the very end of a 25 MiB file", async () => {
    const bytes = Buffer.concat([Buffer.alloc(25 * 1024 * 1024 - EICAR.length, 0x20), EICAR]);
    expect(await scanner.scan({ bytes })).toBe("infected");
  });
});
