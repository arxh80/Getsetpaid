import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "@/lib/email/send";

// lib/email/send.ts: the ONE Brevo sender. Its contract is "a typed result,
// never a throw" -- every branch below is a way the send can fail, and each
// must come back as ok:false rather than take the caller down.

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  process.env.BREVO_API_KEY = "test-key";
  process.env.BREVO_SENDER_EMAIL = "no-reply@example.test";
  process.env.BREVO_SENDER_NAME = "GetSetPaid";
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.BREVO_API_KEY;
  delete process.env.BREVO_SENDER_EMAIL;
  delete process.env.BREVO_SENDER_NAME;
});

const input = {
  to: [{ email: "founder@example.test" }],
  subject: "s",
  html: "<p>h</p>",
  text: "t",
};

describe("sendEmail", () => {
  it("does not call Brevo at all without a key, and says so", async () => {
    delete process.env.BREVO_API_KEY;
    await expect(sendEmail(input)).resolves.toEqual({
      ok: false,
      error: "BREVO_API_KEY is not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Brevo without a sender", async () => {
    delete process.env.BREVO_SENDER_EMAIL;
    const result = await sendEmail(input);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty recipient list", async () => {
    const result = await sendEmail({ ...input, to: [] });
    expect(result).toEqual({ ok: false, error: "no recipients" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the API key in the header, never in the body, and returns the messageId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messageId: "<abc@brevo>" }), { status: 201 }),
    );
    const result = await sendEmail(input);
    expect(result).toEqual({ ok: true, messageId: "<abc@brevo>" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("test-key");
    // I2: every call carries a timeout signal, with nothing asked for.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).not.toContain("test-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { email: "no-reply@example.test", name: "GetSetPaid" },
      to: [{ email: "founder@example.test" }],
      htmlContent: "<p>h</p>",
      textContent: "t",
    });
  });

  it("m5: blind recipients go in Bcc and the message is addressed to the sender, so no recipient sees another", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: "m" }), { status: 201 }));
    const result = await sendEmail({ ...input, to: [], bcc: [{ email: "owner@b.test" }, { email: "admin@b.test" }] });
    expect(result).toEqual({ ok: true, messageId: "m" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { to: { email: string }[]; bcc: { email: string }[] };
    expect(body.to).toEqual([{ email: "no-reply@example.test", name: "GetSetPaid" }]);
    expect(body.bcc).toEqual([{ email: "owner@b.test" }, { email: "admin@b.test" }]);
  });

  it("a single addressed recipient carries no bcc field", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: "m" }), { status: 201 }));
    await sendEmail(input);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(body.bcc).toBeUndefined();
  });

  it("passes attachments to Brevo as name + base64 content, and omits the field when there are none", async () => {
    // A fresh Response per call: a Response body can be read only once.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ messageId: "m" }), { status: 201 }));
    await sendEmail({ ...input, attachments: [{ name: "INV-0001.pdf", contentBase64: "JVBERi0=" }] });
    const withAttachment = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(withAttachment.attachment).toEqual([{ name: "INV-0001.pdf", content: "JVBERi0=" }]);

    await sendEmail(input);
    const without = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as Record<string, unknown>;
    expect(without).not.toHaveProperty("attachment");
  });

  it("turns a Brevo error status into ok:false carrying the status and message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "unauthorized", message: "Key not found" }), {
        status: 401,
      }),
    );
    await expect(sendEmail(input)).resolves.toEqual({
      ok: false,
      error: "Brevo 401: Key not found",
    });
  });

  it("survives a malformed error body", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
    await expect(sendEmail(input)).resolves.toEqual({ ok: false, error: "Brevo 500" });
  });

  it("turns a network failure into ok:false rather than a throw", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const result = await sendEmail(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("network error");
  });

  // Fix round 1, finding I2: a connection that is accepted and never answered
  // was the one failure the typed-result contract did not cover -- the fetch
  // had no signal, so a Brevo stall held the submission for undici's 300 s
  // default (or until the runtime ended the request). The fetch
  // below never resolves on its own; it only rejects when the signal the
  // sender passed it fires. Against the old code this test hangs.
  it("abandons a fetch that never answers, within the timeout, as a network error", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await sendEmail({ ...input, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("network error: Brevo did not answer within 50 ms");
  });

  it("the production timeout is ten seconds", async () => {
    const { BREVO_TIMEOUT_MS } = await import("@/lib/email/send");
    expect(BREVO_TIMEOUT_MS).toBe(10_000);
  });
});
