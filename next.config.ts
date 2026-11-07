import type { NextConfig } from "next";
import { payPageHeaders, staticSecurityHeaders } from "./lib/security/headers";
import { SERVER_ACTION_BODY_SIZE_LIMIT } from "./lib/security/upload-limits";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: staticSecurityHeaders(),
      },
      // After the global rule so its Referrer-Policy wins (the token is in the URL).
      { source: "/pay/:path*", headers: payPageHeaders() },
    ];
  },
  experimental: {
    serverActions: {
      // WITHOUT THIS, NEXT CAPS SERVER ACTION BODIES AT 1 MB and every upload
      // over that is a framework 413 before the action runs -- while the
      // documents page promises 25 MiB. See lib/security/upload-limits.ts for
      // the whole argument; the number is stated once, there, beside the
      // promise it has to cover.
      bodySizeLimit: SERVER_ACTION_BODY_SIZE_LIMIT,
    },
  },
};

export default nextConfig;
