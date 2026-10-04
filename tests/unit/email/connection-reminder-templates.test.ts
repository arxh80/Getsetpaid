import { describe, expect, it } from "vitest";
import {
  CONNECTION_NOTICE_ALLOWLIST,
  buildConnectionAcceptedNotice,
  buildConnectionDeclinedNotice,
  buildConnectionReceivedNotice,
} from "@/lib/email/network-notice-templates";
import { TASK_REMINDER_ALLOWLIST, buildTaskReminderNotice } from "@/lib/email/task-reminder-template";
import { NoticeContentError } from "@/lib/email/requester-templates";

// THE CONTENT ALLOWLIST of the connection-request and task-reminder notices
// (founder 2026-09-30, Q157(3)/Q174/Q45; job 3). Each builder refuses -- at
// runtime, on every render -- an input carrying any key outside its allowlist,
// and a body carrying any URL but its one in-app link. A PLANT of each
// forbidden field is the test: a field the real rows (or the tables beside
// them) carry, handed in the way a careless `...row` spread would hand it.

const SITE = "https://app.example.test";
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const TASK_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function urls(body: { subject: string; text: string; html: string }): string[] {
  return [...`${body.subject}\n${body.text}\n${body.html}`.matchAll(URL_RE)].map((m) => m[0]);
}
function all(body: { subject: string; text: string; html: string }): string {
  return `${body.subject}\n${body.text}\n${body.html}`;
}

const connection = { counterpartyName: "Neon Rooms", organisationSlug: "world-promo", siteUrl: SITE };
const reminder = {
  taskId: TASK_ID,
  title: "Send the rider to the venue",
  dueAt: "2026-11-03T18:30:00.000Z",
  organisationSlug: "world-promo",
  siteUrl: SITE,
};

// Every field a connection-request notice must never carry. The names are the
// real columns of network_connection_requests / network_profiles /
// organisation_memberships and the private CRM tables beside them.
const CONNECTION_PLANTS: Array<[string, unknown]> = [
  ["privateNote", "PLANTED PRIVATE NOTE"],
  ["rating", 5],
  ["financials", { fee: 125000 }],
  ["headline", "PLANTED CONNECTIONS-ONLY HEADLINE"],
  ["contact_email", "booking@counterparty.test"],
  ["memberEmails", ["owner@counterparty.test"]],
  ["responded_by", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"],
  ["organisationName", "Counterparty Ltd"],
  ["from_organisation_id", "cccccccc-3333-4333-8333-cccccccccccc"],
];

describe("the allowlists are exactly what the builders are documented to take", () => {
  it("names four notices: a published name, a slug and the site -- or a task's title, due date and id", () => {
    expect(CONNECTION_NOTICE_ALLOWLIST).toEqual({
      connectionReceived: ["counterpartyName", "organisationSlug", "siteUrl"],
      connectionAccepted: ["counterpartyName", "organisationSlug", "siteUrl"],
      connectionDeclined: ["counterpartyName", "organisationSlug", "siteUrl"],
    });
    expect(TASK_REMINDER_ALLOWLIST).toEqual(["taskId", "title", "dueAt", "organisationSlug", "siteUrl"]);
  });
});

describe.each([
  ["received", buildConnectionReceivedNotice, /Neon Rooms wants to connect/],
  ["accepted", buildConnectionAcceptedNotice, /Neon Rooms accepted your connection request/],
  ["declined", buildConnectionDeclinedNotice, /Your connection request to Neon Rooms was declined/],
] as const)("connection %s", (_label, build, subject) => {
  it("renders the published name and ONE link, to this workspace's requests page", () => {
    const body = build(connection);
    expect(body.subject).toMatch(subject);
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/network/requests`]));
  });

  it("names nobody when the counterparty profile is no longer published", () => {
    const body = build({ ...connection, counterpartyName: null });
    expect(all(body)).not.toContain("Neon Rooms");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/network/requests`]));
  });

  it.each(CONNECTION_PLANTS)("refuses a planted %s", (key, value) => {
    expect(() => build({ ...connection, [key]: value } as typeof connection)).toThrow(NoticeContentError);
  });

  it("refuses a slug that is not a slug (no page to link to)", () => {
    expect(() => build({ ...connection, organisationSlug: "../evil" })).toThrow(NoticeContentError);
  });

  it("cannot be made to carry a second link through the display name", () => {
    const body = build({ ...connection, counterpartyName: "Click https://evil.test/x now" });
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/network/requests`]));
  });
});

describe("the declined notice says no more than the Sent list does", () => {
  it("carries no responder, reason or time", () => {
    const text = all(buildConnectionDeclinedNotice(connection)).toLowerCase();
    for (const word of ["because", "reason", "by ", "who "]) expect(text).not.toContain(word);
  });
});

describe("task reminder", () => {
  it("renders the title, the UK-local due time and ONE link, to the task", () => {
    const body = buildTaskReminderNotice(reminder);
    expect(body.subject).toBe("Reminder: Send the rider to the venue");
    expect(body.text).toContain("3 November 2026");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/tasks/${TASK_ID}`]));
  });

  it.each<[string, unknown]>([
    ["detail", "PLANTED TASK DETAIL"],
    ["links", [{ entity_type: "contact", entity_id: TASK_ID }]],
    ["ownerEmail", "assignee@test.local"],
    ["createdBy", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"],
    ["priority", "urgent"],
  ])("refuses a planted %s", (key, value) => {
    expect(() => buildTaskReminderNotice({ ...reminder, [key]: value } as typeof reminder)).toThrow(NoticeContentError);
  });

  it("refuses a task id that is not a uuid; an empty title renders a placeholder", () => {
    expect(() => buildTaskReminderNotice({ ...reminder, taskId: "../../x" })).toThrow(NoticeContentError);
    // An empty title no longer refuses (I2: a refusal was a poison row); it renders a placeholder.
    expect(buildTaskReminderNotice({ ...reminder, title: "   " }).subject).toBe("Reminder: Untitled task");
  });

  it("a title naming a website stays text, not a second link", () => {
    const body = buildTaskReminderNotice({ ...reminder, title: "Check https://evil.test/login" });
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/tasks/${TASK_ID}`]));
  });
});

// TASK 9b FIX ROUND 1, I3: the one-link rule, against the reviewer's exact
// payloads. A single case-insensitive strip of `https?://` turned
// `HThttps://TPS://evil` into `HTTPS://evil`, and a case-sensitive check let
// it through; `www.` was never touched. The check below is deliberately wider
// and case-insensitive -- anything a mail client would autolink -- and reads
// the FINAL subject, text and HTML.
const LINK_LIKE_ANY_CASE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"'<>)]*/gi;
function linkLike(body: { subject: string; text: string; html: string }): string[] {
  return [...all(body).normalize("NFKC").matchAll(LINK_LIKE_ANY_CASE)].map((m) => m[0]);
}

const HOSTILE: ReadonlyArray<[string, string]> = [
  ["the reviewer's nested mixed-case scheme", "Acme. Verify at HThttps://TPS://evil.example/login"],
  ["the reviewer's lowercase reassembly", "hthttps://tps://evil.example/x"],
  ["an upper-case scheme", "HTTPS://evil.example/login"],
  ["a mixed-case scheme", "hTtPs://evil.example/login"],
  ["a bare www host", "Visit www.evil.example/login"],
  ["an upper-case bare www host", "Visit WWW.EVIL.EXAMPLE"],
  ["www reassembled from a scheme", "wwhttps://w.evil.example"],
  ["a scheme reassembled from www", "httwww.ps://evil.example"],
  ["three levels of nesting", "hthththttps://tps://tps://evil.example"],
  // These two need a SECOND pass: removing `www.` is what assembles the
  // scheme, so a single pass leaves `https://evil.example` behind.
  ["a scheme assembled by removing www.", "https:www.//evil.example/login"],
  ["a scheme assembled by removing www. (upper case)", "HTTPS:/WWW./evil.example/login"],
  ["another scheme", "ftp://evil.example and javascript://x"],
  ["a full-width scheme", "ｈｔｔｐｓ：／／evil.example"],
  ["a zero-width break inside the scheme", "htt​ps://evil.example"],
  ["a scheme split by a newline", "ht\ntps://evil.example"],
];

describe("I3: nothing link-like survives a person's text, to a fixed point", () => {
  describe.each([
    ["received", buildConnectionReceivedNotice],
    ["accepted", buildConnectionAcceptedNotice],
    ["declined", buildConnectionDeclinedNotice],
  ] as const)("connection %s, through the display name", (_label, build) => {
    it.each(HOSTILE)("%s renders with ONE link and does not throw", (_why, name) => {
      const body = build({ ...connection, counterpartyName: name });
      expect(linkLike(body)).toEqual(
        Array(linkLike(body).length).fill(`${SITE}/world-promo/network/requests`),
      );
      expect(linkLike(body).length).toBeGreaterThan(0);
    });
  });

  it.each(HOSTILE)("task reminder: %s renders with ONE link and does not throw", (_why, title) => {
    const body = buildTaskReminderNotice({ ...reminder, title });
    const found = linkLike(body);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([`${SITE}/world-promo/tasks/${TASK_ID}`]));
  });

  it("the check itself is case-insensitive on the final render (a planted upper-case URL is refused)", async () => {
    const { assertOnlyLink } = await import("@/lib/email/notice-render");
    const link = `${SITE}/x`;
    for (const planted of ["HTTPS://evil.example", "Www.evil.example", "FTP://evil.example"]) {
      expect(() => assertOnlyLink("t", { subject: "s", text: `${planted} ${link}`, html: "" }, link)).toThrow(
        NoticeContentError,
      );
    }
    expect(() => assertOnlyLink("t", { subject: "s", text: link, html: `<a href="${link}">x</a>` }, link)).not.toThrow();
  });

  it("I2: a title that neutralises to nothing renders a placeholder instead of refusing", () => {
    for (const title of ["https://", "www.", "HTTPS://www."]) {
      const body = buildTaskReminderNotice({ ...reminder, title });
      expect(body.subject).toBe("Reminder: Untitled task");
    }
  });

  it("a display name that neutralises to nothing names nobody", () => {
    const body = buildConnectionReceivedNotice({ ...connection, counterpartyName: "https://" });
    expect(body.subject).toBe("A new connection request on GetSetPaid");
  });
});
