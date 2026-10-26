// LICENCE GATE (Phase 10 Task 9, G23). Fails on any production dependency whose
// licence is outside the allowlist. Run by CI's `scan` job:
//   pnpm licenses list --prod --json | node scripts/check-licenses.mjs
// The report comes in on stdin, not from a spawned pnpm: pnpm 11's npm-global
// install ships an extensionless native binary that Windows' cmd cannot launch,
// so spawning `pnpm` from Node is not portable. Its shape is
// { "<licence expression>": [{ name, versions, ... }], ... }.
import { readFileSync } from "node:fs";

export const ALLOWED = ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC-BY-4.0"];

// sharp's prebuilt binaries bundle libvips (LGPL), dynamically linked, which the
// LGPL permits without copyleft reaching this code. Admitted for @img/sharp-*
// ONLY: the Windows package declares the combined expression, the Linux
// libvips package (what CI installs) declares the LGPL alone.
export const SCOPED = [
  { licence: "Apache-2.0 AND LGPL-3.0-or-later", packages: /^@img\/sharp-/ },
  { licence: "LGPL-3.0-or-later", packages: /^@img\/sharp-/ },
];

/** Every package whose licence the allowlist does not admit, as "name (licence)". */
export function violations(report) {
  const out = [];
  for (const [licence, pkgs] of Object.entries(report)) {
    if (ALLOWED.includes(licence)) continue;
    for (const pkg of pkgs) {
      const scoped = SCOPED.some((s) => s.licence === licence && s.packages.test(pkg.name));
      if (!scoped) out.push(`${pkg.name} (${licence})`);
    }
  }
  return out.sort();
}

if (process.argv[1]?.endsWith("check-licenses.mjs")) {
  const report = JSON.parse(readFileSync(0, "utf8"));
  const count = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);
  if (count === 0) {
    console.error("check-licenses: the report lists no packages; refusing to pass an empty input.");
    process.exit(1);
  }
  const bad = violations(report);
  if (bad.length > 0) {
    console.error(`check-licenses: ${bad.length} package(s) outside the allowlist:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`check-licenses: ${count} production packages, all allowed.`);
}
