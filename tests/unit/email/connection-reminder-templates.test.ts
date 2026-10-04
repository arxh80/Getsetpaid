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

  it("refuses a task id that is not a uuid, and an empty title", () => {
    expect(() => buildTaskReminderNotice({ ...reminder, taskId: "../../x" })).toThrow(NoticeContentError);
    expect(() => buildTaskReminderNotice({ ...reminder, title: "   " })).toThrow(NoticeContentError);
  });

  it("a title naming a website stays text, not a second link", () => {
    const body = buildTaskReminderNotice({ ...reminder, title: "Check https://evil.test/login" });
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/world-promo/tasks/${TASK_ID}`]));
  });
});
