import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindingMatches, isNewSignUp } from "@/lib/auth/first-proof";
import {
  CHOOSING_PASSWORD_PATHS,
  MUST_CHOOSE_PASSWORD_KEY,
  isUnder,
  mustChoosePassword,
} from "@/lib/supabase/middleware";

// Phase 10 Task 20 (Q245): the two pure halves of "a password chosen after the
// proof". The journeys are tests/e2e/first-proof-password.spec.ts.

const USER = "7f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const NONCE = "n0nce-value";
const HASH = createHash("sha256").update(NONCE).digest("hex");

describe("bindingMatches: the sign-up binding cookie", () => {
  it("matches this user's cookie whose nonce hashes to the stored value", () => {
    expect(bindingMatches(`${USER}.${NONCE}`, USER, HASH)).toBe(true);
  });

  it.each([
    ["no cookie", undefined, USER, HASH],
    ["no stored hash (a re-sign-up, or already consumed)", `${USER}.${NONCE}`, USER, undefined],
    ["an empty stored hash", `${USER}.${NONCE}`, USER, ""],
    ["a non-string stored hash", `${USER}.${NONCE}`, USER, 42],
    ["another user's cookie", `00000000-0000-0000-0000-000000000000.${NONCE}`, USER, HASH],
    ["the wrong nonce", `${USER}.other`, USER, HASH],
    ["the hash itself as the nonce", `${USER}.${HASH}`, USER, HASH],
    ["no separator", `${USER}${NONCE}`, USER, HASH],
    ["an empty nonce", `${USER}.`, USER, createHash("sha256").update("").digest("hex")],
    ["an empty user id", `.${NONCE}`, USER, HASH],
  ])("refuses %s", (_label, cookie, user, stored) => {
    expect(bindingMatches(cookie, user, stored)).toBe(false);
  });
});

describe("isNewSignUp: created vs returned-existing (GoTrue's resend floor)", () => {
  it("a new account: the two stamps are milliseconds apart (14ms measured)", () => {
    expect(
      isNewSignUp({ created_at: "2026-10-18T17:41:34.813827Z", confirmation_sent_at: "2026-10-18T17:41:34.828181709Z" }),
    ).toBe(true);
  });

  it("a re-sign-up: confirmation_sent_at is at least max_frequency after created_at (1.7s measured)", () => {
    expect(
      isNewSignUp({ created_at: "2026-10-18T17:41:34.813827Z", confirmation_sent_at: "2026-10-18T17:41:36.50542423Z" }),
    ).toBe(false);
  });

  it.each([
    ["no confirmation sent", { created_at: "2026-10-18T17:41:34Z", confirmation_sent_at: undefined }],
    ["exactly one second", { created_at: "2026-10-18T17:41:34Z", confirmation_sent_at: "2026-10-18T17:41:35Z" }],
    ["a stamp before creation", { created_at: "2026-10-18T17:41:34Z", confirmation_sent_at: "2026-10-18T17:41:33Z" }],
    ["an unparseable stamp", { created_at: "garbage", confirmation_sent_at: "2026-10-18T17:41:34Z" }],
  ])("is not new with %s (no binding: the safe side)", (_label, user) => {
    expect(isNewSignUp(user)).toBe(false);
  });
});

describe("the must-choose-a-password gate", () => {
  it("reads the mark from app_metadata, and only a literal true", () => {
    expect(mustChoosePassword({ app_metadata: { [MUST_CHOOSE_PASSWORD_KEY]: true } })).toBe(true);
    expect(mustChoosePassword({ app_metadata: { [MUST_CHOOSE_PASSWORD_KEY]: "true" } })).toBe(false);
    expect(mustChoosePassword({ app_metadata: {} })).toBe(false);
    expect(mustChoosePassword({})).toBe(false);
    expect(mustChoosePassword(null)).toBe(false);
  });

  it("allows exactly the page, the callback and the legal pages", () => {
    expect([...CHOOSING_PASSWORD_PATHS]).toEqual(["/set-password", "/auth", "/legal"]);
  });

  it.each(["/set-password", "/set-password?next=%2Finvites", "/auth/callback", "/legal/privacy"])(
    "%s stays reachable",
    (path) => expect(isUnder(path.split("?")[0], CHOOSING_PASSWORD_PATHS)).toBe(true),
  );

  it.each(["/", "/orgs", "/account", "/invites", "/onboarding", "/super", "/set-passwordx", "/api/feedback", "/login"])(
    "%s bounces to /set-password",
    (path) => expect(isUnder(path, CHOOSING_PASSWORD_PATHS)).toBe(false),
  );
});
