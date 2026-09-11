import Link from "next/link";

// The IN-APP 404, and the only thing separating it from `app/not-found.tsx` is
// the element it opens with.
//
// ===========================================================================
// WHY THERE ARE TWO OF THESE
// ===========================================================================
// Final review I-8. `app/(app)/layout.tsx:150` opens `<main id="main">` around
// every page in the authenticated shell, and `app/not-found.tsx` opened its
// own `<main>` inside it. Two `main` landmarks is invalid HTML and a real
// screen-reader defect, and axe measured it: `landmark-main-is-top-level`,
// `landmark-no-duplicate-main` and `landmark-unique`, on the page that EVERY
// tenant-breakout refusal, record-scope refusal and soft-deleted-record
// navigation lands on.
//
// The root `app/not-found.tsx` is still correct AS IT IS -- it serves the
// unauthenticated 404, which has no shell around it and therefore needs to
// open the document's only `main` itself. So this is not a move; it is a
// second file that Next.js resolves for anything under the `(app)` group,
// rendering the same eleven lines of markup in a `<div>`.
//
// NO BEHAVIOUR CHANGE, and that is the point of keeping the copy identical.
// This page is a SECURITY CONTROL: it is what notFound() renders for a record
// or workspace that exists but belongs to another organisation, and it must be
// indistinguishable from the one rendered for a slug that does not exist at
// all. A distinguishing 403 there would be an enumeration oracle for other
// tenants' slugs and ids. See app/not-found.tsx's header for the full argument
// -- and tests/e2e/tenant-breakout.spec.ts, which measures it: a WORKSPACE
// refusal (thrown by the [orgSlug] layout, above every loading boundary)
// still carries the literal HTTP 404, while a RECORD refusal under a valid
// slug streams as 200 + this identical document since the loading-skeletons
// pass, and the indistinguishability itself is asserted directly by that
// file's REFUSAL PARITY test (DESIGN.md § Error pages has the contract).
//
// Layout is DESIGN.md § Error pages: centred, large display numeral in
// --text-5xl, one short sentence, one primary action out. No illustration, no
// mascot, no joke copy. The numeral may use --danger, which clears 4.5:1 as
// body text on this ground and needs no large-text allowance, and it never
// travels without its label -- colour is not the signal.
//
// The `min-h-dvh` of the root version is gone: inside the shell the layout's
// `<main>` already owns the height, and a full-viewport child inside it pushes
// the page taller than the window for no reason.
export default function AppNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center gap-5">
      <p className="tracking-display text-5xl font-extrabold text-danger">404</p>
      <h1 className="text-lg text-ink">Page not found.</h1>
      <p>
        <Link
          href="/"
          className="inline-flex h-11 items-center justify-center border border-primary bg-primary px-4 text-base font-semibold text-on-primary no-underline transition-colors duration-[var(--dur-fast)] ease-brand hover:border-ink hover:bg-ink"
        >
          Back to your workspace
        </Link>
      </p>
    </div>
  );
}
