// RFC 4226 (HOTP) / RFC 6238 (TOTP), the standard algorithm every
// authenticator app implements -- SHA-1, 30-second step, 6 digits, which are
// GoTrue's defaults. Reimplemented here rather than pulled in as a runtime
// dependency: it is ~40 lines, it is only ever used by tests, and adding a
// package to package.json for it would put it in the production dependency
// graph of a product that never generates codes, only verifies them.
//
// WHY IT EXISTS AT ALL: so a test can produce a code that genuinely matches
// the secret enroll() just returned, and have the LIVE GoTrue verifier accept
// it. That is the opposite of mocking the verification -- a suite that stubbed
// challengeAndVerify() would prove nothing about the control it claims to
// test.
//
// EXTRACTED to tests/support/ in the final fix wave, when a second suite
// needed it: tests/integration/rls/support/fixtures.ts now has to raise its
// privileged personas to aal2, because
// supabase/migrations/20260827210000_mfa_aal_permission_gate.sql makes an
// Owner's permissions conditional on having actually presented a factor. It
// was previously private to tests/integration/mfa/mfa-lifecycle.test.ts.
//
// NOT FOR PRODUCTION USE. There is no constant-time comparison here and no
// clock-skew window, because nothing here verifies anything -- it only
// generates. Never import this from lib/ or app/.
import { createHmac } from "node:crypto";

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** The 6-digit code an authenticator app would show for `secretBase32` now. */
export function totpCode(secretBase32: string, at: number = Date.now()): string {
  const stepSeconds = 30;
  const digits = 6;
  const counter = Math.floor(at / 1000 / stepSeconds);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const key = base32Decode(secretBase32);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binCode % 10 ** digits).toString().padStart(digits, "0");
}
