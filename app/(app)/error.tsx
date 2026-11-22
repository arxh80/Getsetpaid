"use client";

import { ServerError } from "@/components/ui/server-error";

// An uncaught error on any page inside the signed-in shell. notFound() and
// redirect() do not reach here, so the refusal-parity 404 is unaffected.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ServerError reset={reset} as="div" />;
}
