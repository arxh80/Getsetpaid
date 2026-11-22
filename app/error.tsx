"use client";

import { ServerError } from "@/components/ui/server-error";

// An uncaught error outside the signed-in shell (sign-in, legal pages) or in
// the (app) layout itself. Opens its own <main>, like app/not-found.tsx.
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ServerError reset={reset} />;
}
