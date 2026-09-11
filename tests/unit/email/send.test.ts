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
    expect(String(init.body)).not.toContain("test-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { email: "no-reply@example.test", name: "GetSetPaid" },
      to: [{ email: "founder@example.test" }],
      htmlContent: "<p>h</p>",
      textContent: "t",
    });
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
});
