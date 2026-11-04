import { afterEach, describe, expect, it } from "vitest";
import { refuseUnlessRunner } from "@/lib/security/runner-auth";

// Phase 10 Task 25: the four sessionless runner routes (exports, erasure,
// retention, incident-alert delivery) share one credential check. Every
// refusal is the same 404, so a prober cannot tell an unconfigured endpoint
// from a wrong secret.

const ENV = "RUNNER_AUTH_TEST_SECRET";
const SECRET = "s".repeat(40);

function request(authorization?: string): Request {
  return new Request("http://localhost/api/x/run", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function expectRefused(res: Response | null) {
  expect(res).not.toBeNull();
  expect(res?.status).toBe(404);
  expect(res?.headers.get("Cache-Control")).toBe("no-store");
  expect(await res?.text()).toBe("Not found");
}

afterEach(() => {
  delete process.env[ENV];
});

describe("refuseUnlessRunner", () => {
  it("refuses every caller while the secret is unset", async () => {
    await expectRefused(refuseUnlessRunner(request(`Bearer ${SECRET}`), ENV));
  });

  it("refuses while the secret is shorter than 32 characters", async () => {
    process.env[ENV] = "s".repeat(31);
    await expectRefused(refuseUnlessRunner(request(`Bearer ${"s".repeat(31)}`), ENV));
  });

  it("refuses a request with no Bearer prefix", async () => {
    process.env[ENV] = SECRET;
    await expectRefused(refuseUnlessRunner(request(SECRET), ENV));
    await expectRefused(refuseUnlessRunner(request(), ENV));
  });

  it("refuses a wrong secret, of the same length and of a different one", async () => {
    process.env[ENV] = SECRET;
    await expectRefused(refuseUnlessRunner(request(`Bearer ${"t".repeat(40)}`), ENV));
    await expectRefused(refuseUnlessRunner(request(`Bearer ${SECRET}x`), ENV));
  });

  it("POSITIVE CONTROL: the right secret is admitted (null)", () => {
    process.env[ENV] = SECRET;
    expect(refuseUnlessRunner(request(`Bearer ${SECRET}`), ENV)).toBeNull();
  });
});
