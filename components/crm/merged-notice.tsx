import Link from "next/link";

// "You created a record and this is not it."
//
// ===========================================================================
// FOUND IN A BROWSER, NOT IN REVIEW
// ===========================================================================
// The auto-merge works and, until this existed, said nothing. Walked as a
// Manager: create a contact called "Ines D (typo entry)" with the email
// INES@Nightshift.Test, press Create, and land on a page headed "Ines Duarte"
// with a different name, a different role and a phone number that was never
// typed. The record really had been created and really had been merged into
// the older one -- the database was right and the product was silent about the
// single most surprising thing it does.
//
// Every gate this repository runs was green: tsc, eslint, 781 unit and
// integration tests, 806 psql assertions and 160 over HTTP. Not one of them
// can see a redirect that lands somewhere the user did not ask for.
//
// ===========================================================================
// `?merged=1` AND NOTHING ELSE IN THE URL
// ===========================================================================
// The obvious version carries the name of the record that was merged away, so
// the sentence can say which one. It is not written that way, and the reason
// is a rule rather than a preference: the merged-away record's name is
// personal data (a contact is a person), and CLAUDE.md's privacy rules put
// nothing personal in a query string -- a URL is logged by every proxy, kept in
// history, and pasted into support tickets. A flag is enough for the sentence
// this needs to say, and the merge history is one link away and behind a
// policy.
export function MergedIntoNotice({
  noun,
  historyHref,
}: {
  /** The singular entity noun, lower case: "contact", "venue". */
  noun: string;
  historyHref: string;
}) {
  return (
    // role="status" rather than role="alert": nothing has gone wrong, and an
    // alert interrupts a screen-reader user mid-sentence. This is announced
    // after the page settles, which is when it makes sense.
    <div
      role="status"
      className="border border-l-[3px] border-rule border-l-accent bg-surface p-4"
    >
      <p className="max-w-prose text-base text-ink">
        <span className="font-semibold">
          The {noun} you just created already existed.
        </span>{" "}
        It had the same email address as this one, so the two were merged and
        this is the record that survived — the older of the two.
      </p>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Nothing was lost. Anything you typed that this record had no value for
        was copied across, and every value that was not kept is recorded in the{" "}
        <Link
          href={historyHref}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          merge history
        </Link>
        .
      </p>
    </div>
  );
}
