/** GetSetPaid's application fee in minor units: round half up of gross × bps / 10 000. */
export function applicationFeeMinor(grossMinor: number, bps: number): number {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || !Number.isInteger(bps) || bps < 0 || bps > 1000) {
    throw new RangeError("applicationFeeMinor: gross must be a non-negative integer and bps 0..1000");
  }
  return Math.floor((grossMinor * bps + 5000) / 10000);
}
