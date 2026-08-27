import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./lib/security/headers";

// The static half of the response security headers. The Content-Security-
// Policy is NOT here: it carries a per-request nonce and so is set in
// proxy.ts. Both halves are defined in lib/security/headers.ts, which explains
// every directive and every deliberate allowance -- read that file before
// changing anything here.
//
// These are set at the config layer rather than in middleware on purpose:
// proxy.ts's matcher deliberately excludes /_next/static, /_next/image and
// image files, and `nosniff` is most valuable on precisely those responses.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Every path, including static assets and the API routes.
        source: "/:path*",
        headers: staticSecurityHeaders(),
      },
    ];
  },
};

export default nextConfig;
