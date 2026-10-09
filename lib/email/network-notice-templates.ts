// THE CONNECTION-REQUEST NOTICES (received / accepted / declined), AS PURE
// BUILDERS WITH AN ALLOWLIST. On the network path, so the network leakage
// census (tests/unit/network/no-private-table-in-network-path.test.ts) reads it.
//
// Founder 2026-09-30, Q157(3)/Q174/Q45: build all notification emails through
// the one Brevo sender. This file is the content half of three of the last four;
// the delivery half is lib/email/network-notifications.ts, the database half
// 20261016000000.
//
// THE CONTENT RULE (the brief's, word for word in effect): an email carries
// nothing the recipient cannot already read in the app.
//
//   * CONNECTION NOTICES carry the counterparty's PUBLISHED display name at
//     most -- the one field every published profile shows on the directory --
//     and ONE link, to /<slug>/network/requests. Never a private note, a
//     rating, a financial, a field of any visibility level, an organisation
//     name, or any member of the other side (not who sent it, not who
//     answered it, not an address). A profile that is no longer published
//     renders as "No longer available" on the requests page, so the email
//     says no name at all.
//   * A DECLINED notice says exactly what the Sent list says: the request to
//     that profile was declined. No reason (none exists), no responder, no
//     time beyond what the page shows.
//
// ENFORCED, NOT INTENDED: every builder checks its input's keys against an
// allowlist and its body for any URL but its one in-app link, on every render
// (the same two checks lib/email/requester-templates.ts runs). A caller that
// spreads a whole row in -- the way a private field would arrive -- throws
// before anything is sent.
//
// No "server-only" and no I/O: tests/unit/email drives every builder.

import type { EmailBody } from "@/lib/email/templates";
import { assertInputAllowlisted, assertOnlyLink, oneLine, origin, render, slugOrRefuse } from "@/lib/email/notice-render";

/** The ONLY keys each connection notice's input may carry. */
export const CONNECTION_NOTICE_ALLOWLIST = {
  connectionReceived: ["counterpartyName", "organisationSlug", "siteUrl"],
  connectionAccepted: ["counterpartyName", "organisationSlug", "siteUrl"],
  connectionDeclined: ["counterpartyName", "organisationSlug", "siteUrl"],
} as const;

export interface ConnectionNoticeInput {
  /** The counterparty profile's display_name while it is published; null otherwise. */
  readonly counterpartyName: string | null;
  readonly organisationSlug: string;
  readonly siteUrl: string;
}

type ConnectionKind = keyof typeof CONNECTION_NOTICE_ALLOWLIST;

const CONNECTION_COPY: Record<ConnectionKind, (who: string | null) => { subject: string; lines: string[] }> = {
  connectionReceived: (who) => ({
    subject: who ? `${who} wants to connect on GetSetPaid` : "A new connection request on GetSetPaid",
    lines: [
      who
        ? `${who} has asked to connect with your workspace on the GetSetPaid network.`
        : "Your workspace has a new connection request on the GetSetPaid network.",
      "You can accept or decline it on your connection requests page. Nothing is shared until you accept.",
    ],
  }),
  connectionAccepted: (who) => ({
    subject: who ? `${who} accepted your connection request` : "Your connection request was accepted",
    lines: [
      who
        ? `${who} accepted your workspace's request to connect.`
        : "A request your workspace sent to connect was accepted.",
      "The details they share with connections are now on their profile.",
    ],
  }),
  connectionDeclined: (who) => ({
    subject: who ? `Your connection request to ${who} was declined` : "Your connection request was declined",
    lines: [
      who
        ? `Your workspace's request to connect with ${who} was declined.`
        : "A request your workspace sent to connect was declined.",
      "It is listed on your connection requests page.",
    ],
  }),
};

function buildConnectionNotice(kind: ConnectionKind, input: ConnectionNoticeInput): EmailBody {
  assertInputAllowlisted(kind, CONNECTION_NOTICE_ALLOWLIST[kind], input);
  const slug = slugOrRefuse(kind, input.organisationSlug);
  const link = `${origin(input.siteUrl)}/${slug}/network/requests`;
  const who = input.counterpartyName ? oneLine(input.counterpartyName, 120) || null : null;
  const copy = CONNECTION_COPY[kind](who);
  const body = render(copy.subject, copy.lines, link, "Open connection requests");
  assertOnlyLink(kind, body, link);
  return body;
}

export const buildConnectionReceivedNotice = (input: ConnectionNoticeInput) =>
  buildConnectionNotice("connectionReceived", input);
export const buildConnectionAcceptedNotice = (input: ConnectionNoticeInput) =>
  buildConnectionNotice("connectionAccepted", input);
export const buildConnectionDeclinedNotice = (input: ConnectionNoticeInput) =>
  buildConnectionNotice("connectionDeclined", input);
