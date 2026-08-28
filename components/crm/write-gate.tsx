import Link from "next/link";
import type { CrmWriteAccess } from "@/lib/crm/write-access";

// Write affordances that explain themselves when they are unavailable.
//
// ===========================================================================
// A DISABLED CONTROL WITH NO EXPLANATION IS THE DEFECT THIS FILE EXISTS FOR
// ===========================================================================
// CLAUDE.md § Permissions: "hiding UI is not enforcement." True, and it is
// half the sentence. The other half is that a control which is present and
// grey, or absent altogether, tells the user nothing about whether the product
// is broken, whether they are the wrong person, or whether somebody should be
// asked. FOLLOW-UPS.md's Q6 item says it directly: "Write controls disabled,
// not hidden and not present-and-failing. Hidden loses the explanation;
// present-and-failing produces a 403 the user cannot interpret."
//
// So every gated action here renders in one of two states, never three:
//
//   allowed    an ordinary <Link> styled as the primary button.
//   blocked    a <button disabled> with `aria-describedby` pointing at a
//              visible sentence that names the reason.
//
// WHY A DISABLED <button> AND NOT AN `aria-disabled` <a>. The opposite choice
// was made in components/list/list-pager.tsx and for a stated reason: the
// pager keeps an unavailable direction focusable so keyboard focus is not lost
// when the direction becomes unavailable UNDER THE USER'S HANDS, mid-session.
// Nothing here changes under anyone's hands. Write access is a property of the
// session and the workspace, decided before the page rendered, and constant
// for as long as the page is open -- so there is no focus to preserve across a
// state change, and the honest control is a genuinely inert one. That also
// means DESIGN.md's `disabled:opacity-55` applies here, where the pager
// deliberately drops it: WCAG 1.4.3 exempts inactive components, and this
// component really is inactive.
//
// The explanation is a SIBLING, not a `title` and not a tooltip. A title
// attribute is unreachable by keyboard and unreliable in screen readers, and a
// tooltip on a disabled control cannot be opened by hovering something that
// does not respond to hover.

const PRIMARY_BUTTON =
  "inline-flex h-11 items-center justify-center gap-2 border px-4 " +
  "text-base font-semibold whitespace-nowrap no-underline " +
  "transition-colors duration-[var(--dur-fast)] ease-brand " +
  "border-primary bg-primary text-on-primary " +
  "hover:border-ink hover:bg-ink active:border-ink active:bg-ink";

const DISABLED_BUTTON =
  "inline-flex h-11 items-center justify-center gap-2 border px-4 " +
  "text-base font-semibold whitespace-nowrap " +
  "border-rule bg-surface text-ink " +
  "cursor-not-allowed opacity-55";

/**
 * The primary "create a record" action for a list page.
 *
 * `id` is required rather than generated, because the explanation's id has to
 * be stable and this is a Server Component -- `useId` is not available and a
 * random id would change between the server render and hydration.
 */
export function NewRecordAction({
  access,
  href,
  label,
  id,
}: {
  access: CrmWriteAccess;
  href: string;
  label: string;
  id: string;
}) {
  if (access.canWrite) {
    return (
      <Link href={href} className={PRIMARY_BUTTON}>
        {label}
      </Link>
    );
  }
  const noteId = `${id}-why`;
  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" disabled aria-describedby={noteId} className={DISABLED_BUTTON}>
        {label}
      </button>
      <p id={noteId} className="max-w-prose text-sm text-ink-muted">
        {access.explanation}
      </p>
    </div>
  );
}

/**
 * The same explanation without a control, for a page whose write affordances
 * are a whole panel rather than one button.
 *
 * Rendered once per page, not once per control: five disabled buttons each
 * repeating "this workspace is suspended" is noise, and for a screen-reader
 * user it is five identical sentences between them and the record.
 */
export function WriteBlockedNote({
  access,
  id,
}: {
  access: CrmWriteAccess;
  id: string;
}) {
  if (access.canWrite) return null;
  return (
    <p id={id} className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
      <span className="font-semibold text-ink">Read-only.</span>{" "}
      {access.explanation}
    </p>
  );
}
