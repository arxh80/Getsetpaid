import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 10 Task 5 review m5: the server-only request mark refuses the public
// .env.example value in production -- it sends no header (fails closed, as an
// unset value does) and logs once -- and sends it anywhere else.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

async function load() {
  vi.resetModules(); // the warn-once flag is module state
  return import("@/lib/supabase/server");
}

describe("serverMarkHeaders", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    error.mockRestore();
  });

  it("pins LOCAL_SERVER_REQUEST_SECRET to the .env.example line", async () => {
    const { LOCAL_SERVER_REQUEST_SECRET } = await load();
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(env).toMatch(
      new RegExp(`^GETSETPAID_SERVER_REQUEST_SECRET=${LOCAL_SERVER_REQUEST_SECRET}$`, "m"),
    );
  });

  it("refuses the local value in production: no header, one log line", async () => {
    const { serverMarkHeaders, LOCAL_SERVER_REQUEST_SECRET } = await load();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GETSETPAID_SERVER_REQUEST_SECRET", LOCAL_SERVER_REQUEST_SECRET);
    expect(serverMarkHeaders()).toBeUndefined();
    expect(serverMarkHeaders()).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("public .env.example value");
  });

  it("CONTROL: a production value of its own is sent", async () => {
    const { serverMarkHeaders } = await load();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GETSETPAID_SERVER_REQUEST_SECRET", "a-hosted-value");
    expect(serverMarkHeaders()).toEqual({ "x-getsetpaid-server": "a-hosted-value" });
    expect(error).not.toHaveBeenCalled();
  });

  it("CONTROL: the local value is sent outside production", async () => {
    const { serverMarkHeaders, LOCAL_SERVER_REQUEST_SECRET } = await load();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GETSETPAID_SERVER_REQUEST_SECRET", LOCAL_SERVER_REQUEST_SECRET);
    expect(serverMarkHeaders()).toEqual({ "x-getsetpaid-server": LOCAL_SERVER_REQUEST_SECRET });
  });

  it("an unset value sends no header and says so", async () => {
    const { serverMarkHeaders } = await load();
    vi.stubEnv("GETSETPAID_SERVER_REQUEST_SECRET", "");
    expect(serverMarkHeaders()).toBeUndefined();
    expect(String(error.mock.calls[0][0])).toContain("is not set");
  });
});
