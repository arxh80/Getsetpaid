import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/invoices/stripe-webhook", () => ({ handleStripeEvent: handle }));

const SECRET = "whsec_route_test_secret";
const stripe = new Stripe("sk_test_fake");
// Insignificant whitespace: a json() round trip would change these bytes, and
// the signature is over the bytes.
const BODY = '{ "id" : "evt_1",\n  "object": "event", "type": "account.updated", "data": { "object": {} } }';
const sign = (body: string, secret = SECRET) => stripe.webhooks.generateTestHeaderString({ payload: body, secret });
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.example.test/api/stripe/webhook", { method: "POST", body, headers });

let POST: typeof import("@/app/api/stripe/webhook/route").POST;

beforeEach(async () => {
  handle.mockReset().mockResolvedValue({ status: 200, outcome: "applied" });
  vi.stubEnv("STRIPE_MODE", "fake");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_fake");
  ({ POST } = await import("@/app/api/stripe/webhook/route"));
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/stripe/webhook", () => {
  it("passes the parsed event to the handler and the handler's status through (the control)", async () => {
    handle.mockResolvedValue({ status: 500, outcome: "error" });
    const res = await POST(post(BODY, { "stripe-signature": sign(BODY) }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0]).toMatchObject({ id: "evt_1", type: "account.updated" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outcome: "error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("verifies the signature over the raw bytes, not a re-serialised body", async () => {
    // Signed over the odd-spaced BODY; a route that parses and re-stringifies fails to verify.
    expect((await POST(post(BODY, { "stripe-signature": sign(BODY) }))).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("is 503 with the handler untouched when Stripe is not configured", async () => {
    vi.stubEnv("STRIPE_MODE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await POST(post(BODY, { "stripe-signature": sign(BODY) }));
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it("is 400 with no signature header", async () => {
    expect((await POST(post(BODY))).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("is 400 for a signature made with another secret, and for a body changed after signing", async () => {
    expect((await POST(post(BODY, { "stripe-signature": sign(BODY, "whsec_other") }))).status).toBe(400);
    expect((await POST(post(BODY + " ", { "stripe-signature": sign(BODY) }))).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  // The body is read before the signature can be checked, so its size is capped
  // first: an unsigned multi-gigabyte POST must not be buffered (F13, audit 2026-11-09).
  const CAP = 1024 * 1024;
  // A validly signed event padded with JSON whitespace to exactly `bytes`.
  const padded = (bytes: number) => BODY.slice(0, -1) + " ".repeat(bytes - BODY.length) + "}";

  it("accepts a signed body of exactly the cap (the control)", async () => {
    const body = padded(CAP);
    expect(Buffer.byteLength(body)).toBe(CAP);
    expect((await POST(post(body, { "stripe-signature": sign(body) }))).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("is 413 for a body one byte over the cap, even when validly signed", async () => {
    const body = padded(CAP + 1);
    const res = await POST(post(body, { "stripe-signature": sign(body) }));
    expect(res.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it("is 413 from a declared Content-Length alone, before reading the body", async () => {
    const req = post(BODY, { "stripe-signature": sign(BODY), "content-length": String(CAP + 1) });
    const text = vi.spyOn(req, "text");
    expect((await POST(req)).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body with no Content-Length once it passes the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 64 * CAP) throw new Error("the route kept reading past the cap");
        controller.enqueue(chunk);
      },
    });
    const req = new Request("https://app.example.test/api/stripe/webhook", {
      method: "POST",
      body: stream,
      headers: { "stripe-signature": "t=1,v1=x" },
      duplex: "half",
    } as RequestInit);
    expect((await POST(req)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(CAP + 2 * chunk.byteLength);
    expect(handle).not.toHaveBeenCalled();
  });

  it("exports POST only, so GET is a 405", async () => {
    const mod = await import("@/app/api/stripe/webhook/route");
    expect(Object.keys(mod).sort()).toEqual(["POST"]);
  });
});
