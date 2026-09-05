import { safeHref } from "@/lib/crm/urls";
import { formatDate } from "@/lib/format/date";
import type { NetworkDirectoryRow } from "@/lib/network/discovery-list";

// The published substance of one network result -- everything a
// `NetworkDirectoryRow` carries beyond its name and kind (those two are
// rendered by the caller, as the sortable "Name" column's own link).
//
// ===========================================================================
// EVERY FIELD IS OMITTED, NEVER SHOWN AS A DASH, WHEN IT IS NULL
// ===========================================================================
// A `null` here is not "this profile has none" -- it is "the publisher chose
// not to show this at this level" (lib/network/discovery-list.ts's own header).
// Rendering "Contact email: —" beside a profile that simply keeps it hidden
// reads as a claim about the record; omitting the row entirely makes no claim
// at all, which is the honest one.
//
// ===========================================================================
// EVERY STRING HERE WAS WRITTEN BY A DIFFERENT ORGANISATION, AND IS RENDERED
// AS TEXT
// ===========================================================================
// `[P6]` CLAUDE.md § Non-negotiable rules: "this is the phase where user
// content becomes cross-tenant." `headline`, `bio`, `city`, `region`,
// `country` and `contact_email` are all plain text nodes -- React escapes them,
// and nothing here uses `dangerouslySetInnerHTML`. `website_url` is the one
// field that ever becomes an `href`, and it goes through `safeHref()`
// (lib/crm/urls.ts) -- the SAME render-side guard the four CRM detail pages
// already use for a user-supplied website -- rather than being trusted because
// `normaliseWebsite()` already validated it on the way in (lib/network/
// profiles.ts). Re-checked here because a row written before that validator
// existed, or by any future write path, is not this component's problem to
// assume away.
export function ProfileCard({
  row,
  compact = false,
}: {
  row: NetworkDirectoryRow;
  compact?: boolean;
}) {
  const location = [row.city, row.region, row.country]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  const websiteHref = safeHref(row.websiteUrl);

  return (
    <div className="flex flex-col gap-1 text-sm text-ink-muted">
      {row.headline ? (
        <p className="font-semibold text-ink">{row.headline}</p>
      ) : null}
      {row.bio ? (
        <p
          className={
            compact
              ? "line-clamp-2 max-w-prose"
              : "max-w-prose whitespace-pre-line"
          }
        >
          {row.bio}
        </p>
      ) : null}
      {location ? <p>{location}</p> : null}
      {row.contactEmail ? (
        <p>
          <a
            href={`mailto:${row.contactEmail}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            {row.contactEmail}
          </a>
        </p>
      ) : null}
      {/* THE RENDER-SIDE GUARD, MEASURED RATHER THAN ASSUMED. `websiteHref` is
          `safeHref(row.websiteUrl)` -- null for anything that is not an
          absolute http(s) URL, including `javascript:...` and `data:...`
          (lib/crm/urls.ts's SAFE_PROTOCOLS). A hostile value still SHOWS, as
          inert text with the raw string visible, rather than vanishing --
          disappearing silently would look like a bug to the publisher and
          teach nobody that the value was refused. */}
      {websiteHref ? (
        <p>
          <a
            href={websiteHref}
            rel="noopener noreferrer nofollow"
            target="_blank"
            className="break-all text-primary underline underline-offset-4 hover:text-ink"
          >
            {row.websiteUrl}
          </a>
        </p>
      ) : row.websiteUrl ? (
        <p translate="no" className="break-all">
          {row.websiteUrl}
        </p>
      ) : null}
      {row.publishedAt ? (
        <p className="tabular-nums">
          Published{" "}
          <time dateTime={row.publishedAt}>{formatDate(row.publishedAt)}</time>
        </p>
      ) : null}
    </div>
  );
}
