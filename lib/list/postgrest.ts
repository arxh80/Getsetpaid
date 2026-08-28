// PostgREST value encoding.
//
// CLAUDE.md § Non-negotiable rules: "Parameterise everything. No
// string-concatenated SQL." Through PostgREST there is no bound-parameter API
// -- a filter is a URL, and supabase-js appends what it is handed verbatim
// (`PostgrestFilterBuilder.or()` does `searchParams.append('or', '(' + filters
// + ')')`). So the query string IS the parameterisation boundary, and this
// file is the whole of it. Everything below was measured against the running
// PostgREST 13 on the local stack; none of it is taken from documentation,
// because the documentation's summary of quoting is wrong for the top-level
// case in a way that fails silently.
//
// ===========================================================================
// THE TWO GRAMMARS, MEASURED
// ===========================================================================
// PostgREST has two different value contexts and they escape DIFFERENTLY. The
// same string encoded for one and used in the other is a silent wrong answer,
// not an error, which is why both live here with tests rather than at the call
// sites.
//
// (1) TOP-LEVEL  `name=gte.<value>`
//     The value is LITERAL to the end of the parameter. Commas, parentheses,
//     dots, quotes and backslashes all pass through untouched, and
//     URLSearchParams percent-encodes `&`/`=`/`#` so those cannot split the
//     query string either.
//
//     Double-quoting here is WRONG and does not error: the quote characters
//     become part of the compared value. Measured, all twelve adversarial
//     names planted in the fixture:
//
//       name=eq.Comma, Name     -> 1 row   (correct)
//       name=eq."Comma, Name"   -> 0 rows  (looked for the string with quotes)
//
//     That is the failure that motivated this file. A keyset cursor built with
//     the quoted form compared against `"Ada Ali"` instead of `Ada Ali`; `"`
//     sorts below every letter, so the cursor matched from the start of the
//     table and PAGE 2 SILENTLY RETURNED PAGE 1. Status 200, plausible rows,
//     no error anywhere.
//
// (2) LOGIC TREE  `or=(name.gt.<value>,and(name.eq.<value>,id.gt.<uuid>))`
//     Here `,` `(` `)` ARE grammar and the value MUST be double-quoted, with
//     `\` and `"` backslash-escaped inside. Measured, raw values:
//
//       or=(name.eq.Comma, Name,...)      -> 400 PGRST100 (loud, fine)
//       or=(name.eq.Paren) Name,...)      -> 200, WRONG ROWS (silent, not fine)
//
//     The `)` case is the dangerous one: the parenthesis closed the group
//     early, the rest was parsed as something else, and the response was a
//     perfectly ordinary-looking 200.
//
// ===========================================================================
// WHAT THIS IS AND IS NOT A DEFENCE AGAINST
// ===========================================================================
// It is a CORRECTNESS control first. A crafted cursor cannot cross a tenant
// boundary -- measured: an injection payload carrying
// `&organisation_id=eq.<other org>` was sent both quoted and raw, and every
// returned row still carried the caller's own organisation_id, because
// URLSearchParams percent-encodes the `&` so it never becomes a second
// parameter, because lib/list/query.ts writes `.eq("organisation_id", ...)`
// itself, and because RLS is underneath both. The worst a malformed filter
// achieves is the wrong page of rows the caller may already read.
//
// That bound is the reason this is Important and not Critical. It is not a
// reason to leave it open: a list that silently shows the wrong page is
// exactly the class of defect the phase's own history is made of.

/**
 * Encode a value for use INSIDE a PostgREST logic tree (`or=`, `and=`).
 *
 * Always quotes -- unconditionally, not "when it looks dangerous". A
 * conditional quoter is one missed character from a silent wrong answer, and
 * quoting a value that did not need it costs nothing (verified across all
 * twelve adversarial names: quoted and raw agree wherever raw works at all).
 */
export function quoteLogicValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Encode a value for a TOP-LEVEL filter (`column=op.value`).
 *
 * Deliberately the identity function, and deliberately a named function
 * rather than nothing: the call site should say which grammar it is in, so
 * that "no escaping here" reads as a decision that was measured rather than
 * an omission. See the header for what quoting here would do instead.
 *
 * Reserved words were checked rather than assumed: on a text column
 * `name=gte.null` compares against the four-character string and returns the
 * contact actually named "null" -- it is not coerced to SQL NULL. Same for
 * `true`, `false` and `unknown`.
 */
export function topLevelValue(value: string): string {
  return value;
}

/**
 * Build an ILIKE pattern from user-typed search text.
 *
 * Two separate metacharacter layers, and they do not compose the way one
 * would hope:
 *
 *   - POSTGRES treats `%` and `_` as wildcards and `\` as the escape, so
 *     those three are backslash-escaped here. Measured: unescaped, a user
 *     typing `_` matched any single character.
 *
 *   - POSTGREST additionally rewrites `*` to `%` in every like/ilike pattern,
 *     UNCONDITIONALLY. There is no escape for it -- `\*` is rewritten to `\%`,
 *     which Postgres then reads as a literal percent sign. Measured against
 *     two planted contacts, "ZzStarX" and "ZzStar* X":
 *
 *       ilike.%ZzStar*X%    -> both rows   (so `*` became `%`)
 *       ilike.%ZzStar\*X%   -> no rows     (so `\*` became a literal `%`)
 *
 *     A literal asterisk is therefore unreachable through this operator. The
 *     three options were: strip it (silently narrows the search and stops
 *     "Star* Name" being findable at all), rewrite it to something else
 *     (silently changes what the user asked for), or let it be the wildcard
 *     PostgREST has already decided it is. The third is the only one that is
 *     honest about what happens, it is a behaviour users of search boxes
 *     already expect, and it costs nothing: the widest possible pattern `%%%`
 *     is exactly the no-search query, which is indexed and takes 0.5 ms.
 *
 * The result is wrapped in `%` rather than `*` so the pattern this function
 * returns means the same thing before and after PostgREST's rewrite.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
