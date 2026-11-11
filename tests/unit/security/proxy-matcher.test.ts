import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Audit 2026-11-09: the matcher used to exclude any path ending in an image
// suffix, so /anything.png skipped the proxy. That response carried no CSP and
// a client-supplied x-pathname reached currentPath(). Exclusions are by name.
//
// Read from source, not imported: proxy.ts pulls in next/server. Next anchors
// a matcher source with ^ and $, which is what this rebuilds.
const source = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
const literal = /^\s*("\/\(\(\?!.*")\s*,\s*$/m.exec(source)?.[1];
const matcher = new RegExp(`^${JSON.parse(literal ?? '""')}$`);

describe("proxy matcher", () => {
  it("found exactly one matcher in proxy.ts", () => {
    expect(literal).toBeTruthy();
    expect(source.match(/"\/\(\(\?!/g)).toHaveLength(1);
  });

  it.each(["/", "/login", "/acme/contacts", "/super/audit-log", "/api/stripe/webhook"])(
    "runs on the app route %s (the control)",
    (path) => expect(matcher.test(path)).toBe(true),
  );

  it.each(["/x.png", "/acme/contacts/a.svg", "/super/b.jpg", "/favicon.ico", "/acme/icon.svg", "/c.webp"])(
    "runs on %s: an image suffix is not a way round the proxy",
    (path) => expect(matcher.test(path)).toBe(true),
  );

  it.each(["/_next/static/chunks/a.js", "/_next/image", "/icon.svg"])("skips the static asset %s", (path) =>
    expect(matcher.test(path)).toBe(false),
  );
});
