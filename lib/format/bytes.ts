// File sizes, formatted once, for a `tabular-nums` cell.
//
// DESIGN.md is emphatic that every file size in a table is rendered with
// `font-variant-numeric: tabular-nums` so the digits line up column to column.
// The formatter's job is only the number and its unit; the cell applies the
// numeric variant. Binary units (KiB/MiB), because the size cap and the
// bucket's file_size_limit are both stated in MiB (26214400 = 25 MiB), so the
// UI should speak the same units the limit is written in.

const UNITS = ["bytes", "KiB", "MiB", "GiB"] as const;

/**
 * A byte count as a short human string: "0 bytes", "512 bytes", "1.4 MiB".
 *
 * One decimal place above KiB, none for whole KiB and none for raw bytes --
 * "1,024 bytes" would be noise where "1 KiB" is the answer. A negative or
 * non-finite input (neither of which a `size_bytes >= 0` column can hold) is
 * clamped to "0 bytes" rather than rendering "-1 bytes" or "NaN".
 */
export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  if (bytes < 1024) {
    // Whole bytes only; a fractional byte is meaningless.
    const n = Math.round(bytes);
    return `${n} ${n === 1 ? "byte" : "bytes"}`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal, but drop a trailing ".0" so a clean value reads "5 MiB".
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}
