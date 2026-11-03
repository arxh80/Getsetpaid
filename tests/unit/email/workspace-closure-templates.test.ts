import { describe, expect, it } from "vitest";
import {
  DELETED_DECISION_PATH,
  SUPER_CLOSURES_PATH,
  WORKSPACE_CLOSURE_NOTICE_ALLOWLIST,
  buildWorkspaceClosedNotice,
  buildWorkspaceDecisionNotice,
} from "@/lib/email/workspace-closure-templates";
import { NoticeContentError } from "@/lib/email/requester-templates";

// THE CONTENT ALLOWLIST of the workspace-closure notices (founder 2026-09-30,
// Q176/Q178; Task 9c job 2b). Each builder refuses -- at runtime, on every
// render -- an input carrying any key outside its allowlist, and a body
// carrying any URL but its one link. A PLANT of each forbidden field is the
// test: a field the audit rows or the tables beside them carry, handed in the
// way a careless `...row` spread would hand it.

const SITE = "https://app.example.test";
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

function urls(body: { subject: string; text: string; html: string }): string[] {
  return [...`${body.subject}\n${body.text}\n${body.html}`.matchAll(URL_RE)].map((m) => m[0]);
}
function all(body: { subject: string; text: string; html: string }): string {
  return `${body.subject}\n${body.text}\n${body.html}`;
}

const closed = {
  organisationSlug: "neon-nights",
  organisationName: "Neon Nights Ltd",
  closedAt: "2026-10-04T23:30:00.000Z",
  siteUrl: SITE,
};
const decision = (d: "workspace_reassigned" | "workspace_deleted") => ({
  decision: d,
  organisationSlug: "neon-nights",
  organisationName: "Neon Nights Ltd",
  decidedAt: "2026-10-05T09:15:00.000Z",
  siteUrl: SITE,
});

// Every field these notices must never carry: the closing Owner's reason, the
// superuser's reason, who acted, the new Owner, the snapshot of recipients,
// the backup job, and anything from inside the workspace.
const PLANTS: Array<[string, unknown]> = [
  ["reason", "PLANTED CLOSURE REASON"],
  ["superuserReason", "PLANTED DECISION REASON"],
  ["actor_user_id", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
  ["newOwnerEmail", "new-owner@planted.test"],
  ["newOwnerName", "PLANTED NEW OWNER"],
  ["notify_user_ids", ["bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"]],
  ["backup_export_job_id", "cccccccc-3333-4333-8333-cccccccccccc"],
  ["previous_role", "owner"],
  ["contacts", [{ name: "PLANTED CONTACT" }]],
  ["after", { reason: "PLANTED" }],
];

describe("the allowlists are exactly what the builders are documented to take", () => {
  it("names the workspace, its date and the site -- and the decision for the admins' notice", () => {
    expect(WORKSPACE_CLOSURE_NOTICE_ALLOWLIST).toEqual({
      workspaceClosed: ["organisationSlug", "organisationName", "closedAt", "siteUrl"],
      workspaceDecision: ["decision", "organisationSlug", "organisationName", "decidedAt", "siteUrl"],
    });
    expect(SUPER_CLOSURES_PATH).toBe("/super/closures");
    expect(DELETED_DECISION_PATH).toBe("/");
  });
});

describe("workspace closed -> the superuser", () => {
  it("names the workspace and the UK-local closed-at date, with ONE link to the /super closures page", () => {
    const body = buildWorkspaceClosedNotice(closed);
    expect(all(body)).toContain("Neon Nights Ltd");
    expect(all(body)).toContain("neon-nights");
    // 23:30 UTC on 4 Oct is 00:30 BST on 5 Oct: the UK day, not the UTC one.
    expect(body.text).toContain("05 Oct 2026");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/super/closures`]));
  });

  it.each(PLANTS)("refuses a planted %s", (key, value) => {
    expect(() => buildWorkspaceClosedNotice({ ...closed, [key]: value } as typeof closed)).toThrow(NoticeContentError);
  });

  it("a link in the workspace NAME is neutralised, so the email still carries one link", () => {
    const body = buildWorkspaceClosedNotice({ ...closed, organisationName: "Evil HTTPS://evil.example/x www.evil.test" });
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/super/closures`]));
    expect(all(body)).not.toMatch(/HTTPS:\/\/evil|www\.evil/i);
  });

  it("refuses a slug that is not a slug, and a closed-at that is not a date", () => {
    expect(() => buildWorkspaceClosedNotice({ ...closed, organisationSlug: "../super" })).toThrow(NoticeContentError);
    expect(() => buildWorkspaceClosedNotice({ ...closed, closedAt: "not a date" })).toThrow(NoticeContentError);
  });
});

describe("decision -> the remaining Owners and Admins", () => {
  it("reassigned: what was decided and when, ONE link to the workspace", () => {
    const body = buildWorkspaceDecisionNotice(decision("workspace_reassigned"));
    expect(body.subject).toContain("reopened");
    expect(body.text).toContain("05 Oct 2026");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/neon-nights`]));
  });

  it("deleted: what was decided and when, ONE link to the post-sign-in hub, never the workspace", () => {
    const body = buildWorkspaceDecisionNotice(decision("workspace_deleted"));
    expect(body.subject).toContain("deleted");
    expect(body.text).toContain("05 Oct 2026");
    expect(new Set(urls(body))).toEqual(new Set([`${SITE}/`]));
    expect(all(body)).not.toContain(`${SITE}/neon-nights`);
  });

  it.each(PLANTS)("refuses a planted %s", (key, value) => {
    for (const d of ["workspace_reassigned", "workspace_deleted"] as const) {
      expect(() => buildWorkspaceDecisionNotice({ ...decision(d), [key]: value } as ReturnType<typeof decision>)).toThrow(
        NoticeContentError,
      );
    }
  });

  it("refuses an unknown decision rather than guessing one", () => {
    expect(() =>
      buildWorkspaceDecisionNotice({ ...decision("workspace_deleted"), decision: "workspace_closed" as "workspace_deleted" }),
    ).toThrow(NoticeContentError);
  });
});

describe("the one-link check runs on the FINAL render", () => {
  // A person's text is neutralised before it is rendered, so the planted
  // second URL goes in through the one input that is not neutralised: the
  // site origin. assertOnlyLink() must refuse the finished body.
  it("a siteUrl smuggling a second URL is refused, not sent", () => {
    expect(() => buildWorkspaceClosedNotice({ ...closed, siteUrl: `${SITE} https://evil.example` })).toThrow(
      NoticeContentError,
    );
    expect(() =>
      buildWorkspaceDecisionNotice({ ...decision("workspace_deleted"), siteUrl: `${SITE} https://evil.example` }),
    ).toThrow(NoticeContentError);
  });
});
