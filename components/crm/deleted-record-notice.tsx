import Link from "next/link";
import { Alert } from "@/components/ui/alert";

/**
 * What an edit page says when the record it edits has been deleted.
 *
 * ===========================================================================
 * NINE EDIT ROUTES USED TO GIVE THREE ANSWERS TO THIS
 * ===========================================================================
 * Six rendered an explanation in place. tasks and meetings redirected to the
 * record page, where Restore lives. notes redirected too, for this reason and
 * two others. All three redirects sent the user somewhere that does explain,
 * so none of them was silent in the end — but the user was moved before being
 * told why, and which of the three they got depended only on which entity they
 * happened to be editing.
 *
 * They all explain in place now, and this is the one implementation of that.
 *
 * WHY EXPLAIN RATHER THAN REDIRECT, since the reverse was equally arguable and
 * two thirds of the codebase had chosen it: a redirect answers a question the
 * user did not ask. They clicked Edit; the honest reply is "you can't, because
 * this is deleted, and here is the way back", not a different page with no
 * account of why they are on it. The link below is that way back, so nothing
 * the redirect offered is lost — it just stops being mandatory.
 *
 * ===========================================================================
 * THIS IS NOT A 404, AND THAT IS DELIBERATE
 * ===========================================================================
 * The update actions carry `deleted_at is null` in their predicates, so a
 * submit from a deleted record's edit page matches no rows and is reported as
 * refused. Saying so before the user types is the whole point. A 404 would be
 * a lie — the record exists, and the restore queue links straight to it.
 */
export function DeletedRecordNotice({
  label,
  noun,
  detailHref,
  pronoun = "it",
}: {
  /** The record's display name, e.g. the contact's name or the task's title. */
  readonly label: string;
  /** Lower-case singular for the heading, e.g. "agency". */
  readonly noun: string;
  /** Where Restore lives. */
  readonly detailHref: string;
  /** Artists are the one entity written they/them. */
  readonly pronoun?: "it" | "they";
}) {
  const p =
    pronoun === "they"
      ? { subject: "they", object: "them", possessive: "their" }
      : { subject: "it", object: "it", possessive: "its" };

  return (
    <>
      <h1 className="tracking-display text-3xl font-extrabold text-ink">
        Edit {noun}
      </h1>
      <Alert tone="info">
        {label} has been deleted, so {p.subject} can’t be edited. Restore{" "}
        {p.object} from {p.possessive} own page first and the form will be here.
      </Alert>
      <p>
        <Link
          href={detailHref}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Go to {label}
        </Link>
      </p>
    </>
  );
}
