// The upload ceilings the product PROMISES, and the one framework cap that has
// to sit above all of them.
//
// ===========================================================================
// THE BUG THIS EXISTS TO CLOSE, WHICH WAS SHIPPED AND NOT THEORETICAL
// ===========================================================================
// Uploads in this product travel as the body of a Server Action -- a multipart
// POST to the page the form was rendered on -- and Next caps that body at
// `serverActions.bodySizeLimit`, DEFAULT 1 MB, BEFORE the action runs.
// Anything larger is a framework 413 and the client's generic "A server error
// occurred", never the action's own sentence.
//
// `next.config.ts` set no cap, so the default applied, while
// `uploadDocumentAction` checked against 25 MiB and told the user "That file is
// larger than the 25 MiB limit" -- a limit the framework had already made
// unreachable. An ordinary 2 MB contract PDF failed with a generic error on a
// page that says 25 MiB is fine.
//
// EVERY FIXTURE IN EVERY UPLOAD TEST WAS A FEW HUNDRED BYTES, which is why no
// gate saw it. tests/e2e/documents.spec.ts uploads a ~200-byte fake PDF and
// tests/integration/documents/upload-scan-download.test.ts does the same, so
// the entire 1 MiB - 25 MiB band -- most real documents -- was untested. Found
// in Phase 7's re-review, not by anything that runs.
//
// ===========================================================================
// WHY THE CAP IS A NUMBER OF BYTES AND NOT "26mb"
// ===========================================================================
// Next's `SizeLimit` is `number | \`${number}${FileSizeSuffix}\``, so a plain
// byte count is accepted. The string form would be parsed by Next with the
// `bytes` package, which reads `mb` as BINARY (1024^2) -- but nothing in this
// repository can check that. A test asserting the string's value has to parse
// it with a SECOND parser of its own, and a second parser agrees with the first
// right up until the day it does not: if Next ever switched `bytes` for a
// decimal reading, "26mb" would become 26,000,000 -- BELOW the 26,214,400-byte
// documents promise -- and a test carrying its own binary parser would still
// pass while real uploads started failing.
//
// A byte number removes the question rather than answering it. There is no
// string, no parser, and no unit convention to agree about.
//
// ===========================================================================
// THE CAP IS THE LARGEST PROMISE PLUS HEADROOM, DELIBERATELY NOT THE PROMISE
// ===========================================================================
// An upload just OVER the promise must still reach the action, so that the
// APP's own "larger than the 25 MiB limit" sentence is what the user reads
// rather than a framework error. Headroom also covers the multipart framing and
// the form's other fields -- a few hundred bytes in practice; 1 MiB is
// generous. Above this cap the framework answers first, so the only band where
// a user meets the generic error is above 26 MiB, which no screen in the
// product accepts anyway.
//
// tests/unit/security/upload-limits.test.ts binds these numbers to each other
// and to next.config.ts, so a raised promise cannot silently outgrow the cap
// again -- which is the failure mode, not the missing config line.
//
// IMPORTED BY next.config.ts, so this module must stay dependency-free: no
// `@/` alias, no `server-only`, no imports at all.

/**
 * 25 MiB. The same ceiling as `documents.size_bytes`' CHECK (20260902001000)
 * and the `documents` bucket's `file_size_limit` (20260902030000).
 *
 * Lives here rather than in lib/crm/documents.ts because that file is
 * `"use server"`, where every export must be an async function -- so the
 * constant could not be shared from there even though that is where it is
 * enforced.
 */
export const DOCUMENT_MAX_SIZE_BYTES = 26214400;

/**
 * The Server Action body cap, in bytes: 26 MiB, the 25 MiB documents promise
 * plus 1 MiB of headroom. Passed to `experimental.serverActions.bodySizeLimit`
 * as a number -- see the header for why not a string.
 */
export const SERVER_ACTION_BODY_SIZE_LIMIT = 27262976;
