"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// The 500 page, per DESIGN.md § Error pages: centred, the numeral in
// --text-5xl, one short sentence, Retry plus a way out. It never shows the
// error's message or stack: a server error's message can carry internals, and
// Next.js already replaces it with a generic one in production. The `as` prop
// exists because inside the (app) shell the layout already owns `<main>`, as
// app/(app)/not-found.tsx explains.
export function ServerError({
  reset,
  as: Wrapper = "main",
}: {
  reset: () => void;
  as?: "main" | "div";
}) {
  return (
    <Wrapper
      className={
        Wrapper === "main"
          ? "mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8"
          : "mx-auto flex w-full max-w-md flex-col justify-center gap-5"
      }
    >
      <p className="tracking-display text-5xl font-extrabold text-danger">500</p>
      <h1 className="text-lg text-ink">Something went wrong on our end.</h1>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => reset()}>Retry</Button>
        <Link
          href="/"
          className="inline-flex h-11 items-center justify-center border border-rule bg-surface px-4 text-base font-semibold text-ink no-underline transition-colors duration-[var(--dur-fast)] ease-brand hover:border-ink hover:bg-shell"
        >
          Back to your workspace
        </Link>
      </div>
    </Wrapper>
  );
}
