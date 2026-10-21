"use client";

import type { ReactNode } from "react";
import { ActionOutcome } from "@/components/ui/action-outcome";

// WHERE THE LEGAL EDITOR SAYS WHAT HAPPENED (Phase 8 Task 1, fix round 1, I1).
//
// The mechanism this file introduced now lives in
// components/ui/action-outcome.tsx, because Phase 8 Task 3 shipped the same
// bug twice more on two other pages and a pattern that has to be remembered
// was evidently not being. This file keeps the editor's own name for the
// region -- `legal-editor-outcome`, which legal.spec.ts asserts on -- and
// re-exports the rest so the editor's forms and tests/unit/legal/
// editor-outcome.test.ts import what they always did.
//
// Rendered ABOVE the conditional parts of the editor
// (app/(app)/super/legal/page.tsx) and keyed on the document slug by the page,
// so moving to another document starts with an empty region rather than the
// last document's news.

export {
  ACTION_FAILED_MESSAGE,
  nextOutcome,
  runReported,
  useReportedAction,
  type Outcome,
} from "@/components/ui/action-outcome";

export function LegalEditorOutcome({ children }: { children: ReactNode }) {
  return <ActionOutcome testId="legal-editor-outcome">{children}</ActionOutcome>;
}
