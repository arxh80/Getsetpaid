import Link from "next/link";

// 404, per DESIGN.md § Error pages.
//
// Layout is fixed by that section: centred on the shell, large display numeral
// in --text-5xl, one short sentence, one primary action out. No illustration,
// no mascot, no joke copy.
//
// THIS PAGE IS A SECURITY CONTROL. It is what notFound() renders for a record
// or workspace that exists but belongs to another organisation, and it must be
// byte-identical to the one rendered for a slug that does not exist at all.
// A distinguishing 403 there would be an enumeration oracle for other tenants'
// slugs and ids. 403 is reserved for tier/feature gating on a route the user's
// OWN organisation cannot reach.
//
// The numeral may use --danger at display size (it clears 3:1 at >=24px bold,
// the same allowance --accent gets), and it never travels without its label --
// colour is not the signal.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
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
    </main>
  );
}
