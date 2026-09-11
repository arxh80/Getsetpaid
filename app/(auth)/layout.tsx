import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { SkipLink } from "@/components/ui/skip-link";

// Shell for every signed-out screen.
//
// A single centred column, not the split-screen hero-panel layout that every
// SaaS auth page ships. There is nothing true to put in that panel -- we have
// no customer logos, no testimonials and no metrics, and inventing them is the
// exact failure mode DESIGN.md and the house style both call out. So the page
// is the form, framed by a hairline, on the near-black shell.
//
// max-w-md keeps the measure short: a login form that stretches to 1200px is
// harder to use than one that does not.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-md items-center px-4 py-5">
          <Link href="/" className="no-underline">
            <Wordmark />
          </Link>
        </div>
      </header>

      {/* tabIndex={-1}: programmatic/skip-link focus target, never tabbable —
          same note as app/(app)/layout.tsx's main. */}
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-md flex-1 px-4 py-8 sm:py-12"
      >
        {children}
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto w-full max-w-md px-4 py-5 text-sm text-ink-muted">
          A CRM for the live events industry.
        </div>
      </footer>
    </div>
  );
}
