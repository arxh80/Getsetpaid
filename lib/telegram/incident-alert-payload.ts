// THE TELEGRAM ALERT MESSAGE, BUILT FROM AN EXPLICIT ALLOWLIST.
//
// Founder 2026-09-30, Q111: a Telegram message carries the alert type, counts
// and a /super/health link ONLY -- no personal data, no tenant content, no
// emails, no ids. Telegram (Telegram FZ-LLC, Dubai) is outside the UK/EU, so
// "no personal data by construction" is what keeps it off the transfer
// question (SECURITY.md § 12, DECISIONS-QUEUE Q198).
//
// BY CONSTRUCTION, NOT BY FILTERING A ROW. The input type is `{ alertType }`
// and nothing else, so the caller cannot hand this a summary or a details
// blob even by accident; the alert type is mapped through the closed
// vocabulary (an unknown value is counted under "other" rather than echoed);
// and the result is checked against TELEGRAM_PAYLOAD_FIELDS at runtime before
// it is rendered, so a field added to the builder later fails loudly here
// instead of reaching a chat. tests/unit/telegram/incident-alert-payload.test.ts
// plants a forbidden field and watches that check go red.

import {
  INCIDENT_ALERT_TYPE_LABELS,
  isIncidentAlertType,
  type IncidentAlertType,
} from "@/lib/admin/health";

/** Every field a Telegram alert payload may carry. Nothing else, ever. */
export const TELEGRAM_PAYLOAD_FIELDS = ["counts", "total", "link"] as const;
/** Every field one entry of `counts` may carry. */
export const TELEGRAM_COUNT_FIELDS = ["alertType", "count"] as const;

export type TelegramAlertType = IncidentAlertType | "other";

export interface TelegramAlertPayload {
  readonly counts: ReadonlyArray<{ readonly alertType: TelegramAlertType; readonly count: number }>;
  readonly total: number;
  readonly link: string;
}

/** The ONLY thing a caller may hand the builder about an alert. */
export interface TelegramAlertInput {
  readonly alertType: string;
}

export function buildTelegramAlertPayload(
  rows: ReadonlyArray<TelegramAlertInput>,
  siteUrl: string,
): TelegramAlertPayload {
  const tally = new Map<TelegramAlertType, number>();
  for (const row of rows) {
    const type: TelegramAlertType = isIncidentAlertType(row.alertType) ? row.alertType : "other";
    tally.set(type, (tally.get(type) ?? 0) + 1);
  }
  const counts = [...tally.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([alertType, count]) => ({ alertType, count }));
  return {
    counts,
    total: rows.length,
    link: `${siteUrl.replace(/\/+$/, "")}/super/health`,
  };
}

/**
 * Throws unless `payload` carries exactly the allowlisted fields, every count
 * entry carries exactly the allowlisted count fields, every alert type is in
 * the closed vocabulary, and the link is this site's /super/health. Called on
 * every send, not only in tests.
 */
export function assertTelegramPayloadAllowlisted(payload: unknown): asserts payload is TelegramAlertPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("telegram payload: not an object");
  }
  const allowed = new Set<string>(TELEGRAM_PAYLOAD_FIELDS);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`telegram payload: field "${key}" is not allowlisted`);
  }
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.counts) || typeof p.total !== "number" || typeof p.link !== "string") {
    throw new Error("telegram payload: missing an allowlisted field");
  }
  const countFields = new Set<string>(TELEGRAM_COUNT_FIELDS);
  for (const entry of p.counts as unknown[]) {
    if (typeof entry !== "object" || entry === null) throw new Error("telegram payload: bad count entry");
    for (const key of Object.keys(entry)) {
      if (!countFields.has(key)) throw new Error(`telegram payload: count field "${key}" is not allowlisted`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.count !== "number" || typeof e.alertType !== "string") {
      throw new Error("telegram payload: bad count entry");
    }
    if (e.alertType !== "other" && !isIncidentAlertType(e.alertType)) {
      throw new Error(`telegram payload: alert type outside the vocabulary`);
    }
  }
  if (!/^https?:\/\/[^/?#\s]+\/super\/health$/.test(p.link)) {
    throw new Error("telegram payload: link is not a /super/health URL");
  }
}

/** Plain text (no parse_mode), so nothing in it is interpreted as markup. */
export function renderTelegramAlertText(payload: TelegramAlertPayload): string {
  assertTelegramPayloadAllowlisted(payload);
  const lines = payload.counts.map(
    ({ alertType, count }) =>
      `- ${alertType === "other" ? "Other" : INCIDENT_ALERT_TYPE_LABELS[alertType]}: ${count}`,
  );
  return [
    `GetSetPaid: ${payload.total} new incident alert${payload.total === 1 ? "" : "s"}`,
    ...lines,
    `Review: ${payload.link}`,
  ].join("\n");
}
