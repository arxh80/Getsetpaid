"use client";

import "./globals.css";
import { ServerError } from "@/components/ui/server-error";

// An error in the root layout itself. It replaces that layout, so it brings
// its own <html> and <body> (the serif font falls back; nothing else is lost).
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <ServerError reset={reset} />
      </body>
    </html>
  );
}
