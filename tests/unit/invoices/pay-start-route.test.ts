import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pay page's POST has no CSRF token, so any site can send it with a token
// of its choosing. An unverified token must never reach a Location header raw
// (task-5-fix-1 finding A): a character above U+00FF or a CR/LF makes the
// Headers constructor throw (a 500, not the uniform refusal), and `..//x`
// would resolve to the path `//x`.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
  vi.stubEnv("INVOICE_PAY_LINK_SECRET", "x".repeat(40));
});
afterEach(() => vi.unstubAllEnvs());

async function post(token: string): Promise<Response> {
  const { POST } = await import("@/app/pay/[token]/start/route");
  return POST(new Request("https://app.example.test/pay/x/start", { method: "POST" }), {
    params: Promise.resolve({ token }),
  });
}

describe("POST /pay/[token]/start with a token that fails verification", () => {
  it.each([
    ["a character above U+00FF", "€"],
    ["CR/LF", "abc\r\nSet-Cookie: x=1"],
    ["a dot-dot path", "..//x"],
  ])("%s: a 303 to one same-origin /pay/<segment> path, never a 500", async (_name, token) => {
    const res = await post(token);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/pay\/[A-Za-z0-9._~%-]+$/);
    expect(location.slice("/pay/".length)).not.toContain("/");
    expect(decodeURIComponent(location.slice("/pay/".length))).toBe(token);
  });

  it("CONTROL: a plain unverified token is the same uniform refusal", async () => {
    const res = await post("not-a-token");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/pay/not-a-token");
  });
});
