import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import {
  getCrmWriteAccess,
  type CrmWriteAccess,
} from "@/lib/crm/write-access";
import type { RecordResult } from "@/lib/crm/queries";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { DeletedRecordNotice } from "@/components/crm/deleted-record-notice";
import { Alert } from "@/components/ui/alert";

// THE EDIT FORM'S PAGE, ONCE -- FOR THE SIX ROUTES THAT EXPLAIN RATHER THAN
// REDIRECT.
//
// Six of the nine `*/edit/` routes share one shape exactly: load the record
// alongside the write-access read, triage unavailable/missing, render a
// two-level breadcrumb, refuse a DELETED record with an explanation, and then
// choose between the form and the same blocked note. Measured line for line
// against the contacts copy the others were 57-73% identical.
//
// ===========================================================================
// THREE OF THE NINE ARE NOT HERE, AND THAT IS THE INTERESTING PART
// ===========================================================================
// tasks and meetings answer "you opened the edit URL of a deleted record" by
// REDIRECTING to the record page, where the Restore control is. The six here
// answer it by rendering an Alert that says so, with a link. notes goes
// further still: it redirects on deleted OR not-the-author OR no-write, fetches
// the current user to decide, and has no blocked note at all.
//
// Those are three different product answers to one situation, and unifying them
// here would be a product change wearing a refactor's clothes -- the exact
// move the restore-queue and list factories refused. So this covers the six
// that already agree, and the disagreement stays visible in three files rather
// than being resolved by whoever wrote the abstraction. It is worth a founder
// decision: an explanation a user can read beats a redirect that silently
// moves them, but that is a call about the product, not about this module.
//
// ===========================================================================
// A FAILED QUERY IS NOT A MISSING RECORD
// ===========================================================================
// "There is no such agency" is a claim about the customer's data, and making it
// because the database was unreachable reads as deletion. `unavailable` gets an
// error Alert; only `missing` gets the 404. Six copies meant six places that
// had to keep getting that distinction right.
//
// ===========================================================================
// THE TWO REFUSAL SENTENCES ARE DERIVED, AND THAT IS A DEPARTURE
// ===========================================================================
// The list and restore-queue factories pass copy in, because their blurbs were
// genuinely different prose. These two are not: all six pages carry ONE
// sentence with a noun slot and a pronoun slot, verified identical modulo those
// two before this change. Six copies of one sentence will drift -- one already
// nearly has, since artists is the only entity written they/them -- so the
// template lives here and each page declares its noun and pronoun.

/** The pronouns the refusal sentence needs. Artists are they/them. */
type Pronoun = "it" | "they";

/** Everything one edit page needs that another one's would differ on. */
export interface EditRecordPageConfig<TRecord> {
  /** Path segment of the LIST, e.g. "contacts". A route literal. */
  readonly segment: string;
  /** The breadcrumb's first crumb, e.g. "Contacts". */
  readonly backLabel: string;
  /** Lower-case singular, e.g. "agency". Drives the heading and both sentences. */
  readonly noun: string;
  /** Which pronoun the refusal sentence uses. */
  readonly pronoun: Pronoun;
  /** The dynamic segment's name, e.g. "agencyId". */
  readonly paramKey: string;
  /**
   * The permission this edit is gated on. NOT derivable from the segment:
   * companies and agencies are gated on `manage_contacts`.
   */
  readonly permissionKey: string;
  readonly load: (
    organisationId: string,
    recordId: string,
  ) => Promise<RecordResult<TRecord>>;
  /** The record's display name, for the heading and the breadcrumb. */
  readonly label: (record: TRecord) => string;
  readonly deletedAt: (record: TRecord) => string | null;
  /** Rendered ONLY when the record is live and the caller may write. */
  readonly form: (context: {
    readonly org: CurrentOrg;
    readonly record: TRecord;
    readonly detailHref: string;
    readonly access: CrmWriteAccess;
  }) => ReactNode;
}

/** The `generateMetadata` and page component for one edit route. */
export function editRecordPage<TRecord>(
  config: EditRecordPageConfig<TRecord>,
) {
  const blockedId = `edit-${config.noun}-blocked`;

  async function generateMetadata({
    params,
  }: {
    params: Promise<Record<string, string>>;
  }): Promise<Metadata> {
    const resolved = await params;
    const org = await getCurrentOrg(resolved.orgSlug);
    if (!org) return { title: "Not found · GetSetPaid" };
    const result = await config.load(org.id, resolved[config.paramKey]);
    return {
      title:
        result.outcome === "found"
          ? `Edit ${config.label(result.record)} · ${org.name} · GetSetPaid`
          : "Not found · GetSetPaid",
    };
  }

  async function Page({
    params,
  }: {
    params: Promise<Record<string, string>>;
  }) {
    const resolved = await params;
    const org = await getCurrentOrg(resolved.orgSlug);
    if (!org) notFound();

    const [result, access] = await Promise.all([
      config.load(org.id, resolved[config.paramKey]),
      getCrmWriteAccess(org, config.permissionKey),
    ]);

    // A FAILED QUERY IS NOT A MISSING RECORD -- see the header.
    if (result.outcome === "unavailable") {
      return (
        <Alert tone="error">
          We couldn’t load this {config.noun} just now. Refresh the page to try
          again — nothing has been changed.
        </Alert>
      );
    }
    if (result.outcome === "missing") notFound();

    const record = result.record;
    const label = config.label(record);
    const detailHref = `/${org.slug}/${config.segment}/${resolved[config.paramKey]}`;

    const breadcrumb = (
      <p className="text-sm text-ink-muted">
        <Link
          href={`/${org.slug}/${config.segment}`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          {config.backLabel}
        </Link>
        {" › "}
        <Link
          href={detailHref}
          className="break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {label}
        </Link>
      </p>
    );

    // A DELETED RECORD IS NOT EDITABLE AND IS NOT A 404. The update action's
    // predicate carries `deleted_at is null`, so a submit from here would match
    // no rows and be reported as refused -- this says so before the user types.
    if (config.deletedAt(record) !== null) {
      return (
        <div className="flex flex-col gap-6">
          {breadcrumb}
          <DeletedRecordNotice
            label={label}
            noun={config.noun}
            detailHref={detailHref}
            pronoun={config.pronoun}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6">
        {breadcrumb}
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          Edit {label}
        </h1>

        {access.canWrite ? (
          config.form({ org, record, detailHref, access })
        ) : (
          <WriteBlockedNote access={access} id={blockedId} />
        )}
      </div>
    );
  }

  return { generateMetadata, Page };
}
