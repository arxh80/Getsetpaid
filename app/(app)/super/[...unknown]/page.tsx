import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Phase 8 Task 8: the other half of /super's refusal parity.
//
// Every /super page refuses a non-superuser with the STREAMED not-found
// contract -- HTTP 200, app/(app)/not-found.tsx inside the signed-in shell,
// titled "Not found · GetSetPaid" -- because its notFound() runs below a
// loading.tsx boundary (see app/(app)/super/layout.tsx). A /super URL that
// matched NO route did not get that document: Next served the ROOT
// app/not-found.tsx as a literal 404 with no shell and the bare "GetSetPaid"
// title. Measured in tests/e2e/phase8-refusal-parity.spec.ts, all three
// channels differed (status, body, title), so any signed-in account could
// list the operator console's pages by comparing a guess with a known ghost --
// the enumeration oracle super-permissions.spec.ts's header says the design
// closes.
//
// This catch-all makes a nonexistent /super URL take the same path a refused
// one does: it notFound()s below app/(app)/super/loading.tsx, for every caller
// the superuser included, with the title every refused /super page uses. It
// renders nothing and reads nothing.
export async function generateMetadata(): Promise<Metadata> {
  return { title: "Not found · GetSetPaid" };
}

export default function UnknownSuperuserPage(): never {
  notFound();
}
