// The one sentence a rate-limited list request renders (SECURITY.md § 5).
//
// A SHARED COMPONENT, NOT COPIED COPY: every surface that renders a
// `ListPage` can now receive `outcome: "rate_limited"` (lib/list/query.ts
// meters search-carrying requests and every network-directory read), and the
// refusal must say the same thing everywhere -- slow down, nothing is wrong
// with your data, here is when to try again. It is deliberately NOT the
// danger-bordered error state: "refresh and try again" is the opposite of
// the right advice, and a refusal styled as an outage teaches people the
// product is flaky rather than that the limit exists.
//
// role="status" (polite), same as the sibling error notices -- the page is
// fine; one region of it declined to load.
//
// THE REMAINDER IS RENDERED AS A HUMAN DURATION (fix round 1, minor M2). It
// used to be raw seconds, which reads fine for the 60-second budgets this
// component serves today and badly for the hour-long ones beside it -- and the
// copy is shared, so the next surface to reach it inherits whichever form is
// here. `formatRetryAfter` rounds up, so the advice is never early.

import { formatRetryAfter } from "@/lib/format/duration";

export function RateLimitNotice({
  retryAfterSeconds,
  subject,
}: {
  retryAfterSeconds: number;
  /** What was being loaded -- "contacts", "the directory", "this event's
   *  finance lines". Fits the sentence "the limit for loading {subject}". */
  subject: string;
}) {
  return (
    <p
      role="status"
      className="border border-rule bg-surface px-3 py-3 text-base text-ink"
    >
      <span className="font-semibold">Too many requests.</span> You’ve reached
      the limit for loading {subject} just now — nothing is wrong with your
      data. Try again in{" "}
      <span className="tabular-nums">{formatRetryAfter(retryAfterSeconds)}</span>
      .
    </p>
  );
}
