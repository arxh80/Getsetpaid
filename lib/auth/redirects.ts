// Redirect-target sanitising.
//
// `?next=` on the login page, and the invite/OAuth callback's own redirect
// target, both come from the URL -- which means from the user, or from
// whoever sent them the link. Handing that string to redirect() unchecked is
// a textbook open redirect: a phishing page links to
// /login?next=https://getsetpaid.example.evil/, the user signs in on the real
// product, and is then delivered to the attacker's clone with the trust of
// having just authenticated.
//
// So: only same-origin PATHS survive, and they are reconstructed from parts
// rather than pattern-matched. The blocked shapes, each of which defeats a
// naive `startsWith("/")` check:
//
//   https://evil.test/x   absolute
//   //evil.test/x         protocol-relative -- starts with "/", still off-site
//   /\evil.test/x         backslash; several browsers normalise \ to /
//   javascript:alert(1)   scheme injection
//
// The URL parser handles all of them: parse against a throwaway origin and
// keep the result only if the origin came back unchanged.

const FALLBACK = "/";

export function safeNextPath(
  candidate: string | null | undefined,
  fallback: string = FALLBACK,
): string {
  if (!candidate) return fallback;

  // Reject before parsing: a leading "//" or "/\" is same-origin-looking but
  // resolves off-site, and URL() would happily normalise it for us.
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;

  try {
    // The base is arbitrary and never used in the output -- it exists only so
    // a relative path can be parsed at all.
    const base = "https://gsp.invalid";
    const url = new URL(candidate, base);
    if (url.origin !== base) return fallback;
    // Rebuild from parts. Anything that survived parsing but is not path,
    // query or fragment is discarded rather than trusted.
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Checked AGAIN after parsing (Phase 10 Task 2 F5): dot-segment removal
    // turns "/.//evil.test" into "//evil.test", which the pre-parse check
    // above never saw. Protocol-relative output leaves the site.
    if (path.startsWith("//") || path.startsWith("/\\")) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
