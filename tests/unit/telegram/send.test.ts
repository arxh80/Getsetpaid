import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE TELEGRAM TRANSPORT, with `fetch` STUBBED -- no test may send a real
// Telegram message (task-9b brief: "No real sends from tests"). The token is
// a fake, and the assertions that it never appears in an error string are the
// "never log the token" rule measured.

import { sendTelegramMessage, telegramConfig } from "@/lib/telegram/send";

const TOKEN = "123456:FAKE-test-token-not-real";
const CONFIG = { token: TOKEN, chatId: "-1000000000000" };

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
});

describe("telegramConfig -- the channel is a no-op unless BOTH variables are set", () => {
  it.each([
    ["neither", undefined, undefined],
    ["only the token", TOKEN, undefined],
    ["only the chat id", undefined, "-100"],
    ["a blank token", "   ", "-100"],
    ["a blank chat id", TOKEN, " "],
  ])("is null with %s", (_l, token, chat) => {
    if (token !== undefined) process.env.TELEGRAM_BOT_TOKEN = token;
    if (chat !== undefined) process.env.TELEGRAM_ALERT_CHAT_ID = chat;
    expect(telegramConfig()).toBeNull();
  });

  it("is the pair when both are set", () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_ALERT_CHAT_ID = "-100";
    expect(telegramConfig()).toEqual({ token: TOKEN, chatId: "-100" });
  });
});

describe("sendTelegramMessage", () => {
  it("POSTs one sendMessage with the text, no parse_mode, and a timeout signal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(sendTelegramMessage(CONFIG, "hello")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: CONFIG.chatId, text: "hello", disable_web_page_preview: true });
  });

  it("a non-2xx answer is a failure that never carries the token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: `Unauthorized for bot${TOKEN}` }), { status: 401 }),
    );
    const result = await sendTelegramMessage(CONFIG, "x");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("401");
  });

  it("a 200 whose body is not ok:true is still a failure", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    expect((await sendTelegramMessage(CONFIG, "x")).ok).toBe(false);
  });

  it("a rejected fetch is a failure, scrubbed of a URL that contains the token", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const result = await sendTelegramMessage(CONFIG, "x");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a timeout is reported as one, not thrown", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    fetchMock.mockRejectedValue(timeout);
    const result = await sendTelegramMessage(CONFIG, "x", 5);
    expect(result).toEqual({ ok: false, error: "network error: Telegram did not answer within 5 ms" });
  });
});
