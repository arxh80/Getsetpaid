"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

// Focus management for the reveal-in-place pattern (keyboard-a11y pass).
//
// ===========================================================================
// THE DEFECT THIS CLOSES, ONCE, FOR EVERY INLINE CONFIRMATION
// ===========================================================================
// components/crm/delete-restore.tsx established the house pattern for
// destructive actions: no modal, the question is revealed in place. The header
// there argues a dialog's machinery (focus trap, return target, Escape,
// aria-modal) is not needed — and the audit that produced this hook measured
// the part of that argument that was wrong. The TRIGGER BUTTON IS INSIDE THE
// BRANCH IT TOGGLES: pressing "Delete contact" unmounts the element that holds
// focus, and the browser drops focus to <body>. Same on the way back —
// "Keep it" unmounts itself. A keyboard user's position was lost on BOTH
// transitions of every inline confirmation in the product (delete/restore,
// accept/decline/withdraw, the network link picker), which is exactly the
// focus-management work the no-modal argument said we were avoiding, minus
// the part where anyone did it.
//
// So the pattern keeps its shape — reveal in place, no aria-modal, nothing
// inert — and gains the two moves a reveal genuinely owes the keyboard:
//
//   open   → focus moves INTO the revealed content, onto `revealRef`. For a
//            confirmation that is the QUESTION (tabIndex={-1} on the <p>), not
//            a button: focusing "Yes, delete" would put a held/repeated Enter
//            one keydown away from confirming the thing it was asked about,
//            and focusing "Keep it" hides the question from the focus point.
//            From the question, Tab reaches the actions in reading order and a
//            screen reader hears what is being asked before either answer.
//   close  → focus returns to the TRIGGER (`triggerRef`), the same place a
//            closed dialog would return it. The trigger remounts in the same
//            spot, so the ref is attached again by the time the effect runs.
//
// Plus the dismissal a revealed question owes: `onRevealKeyDown` closes on
// Escape — stopPropagation so a palette/rail listener higher up never treats
// an inline cancel as its own close.
//
// NOT A FOCUS TRAP, DELIBERATELY. The page around the question stays live —
// that is the stated virtue of the inline pattern, and WCAG 2.1.2 is about
// getting OUT of a widget, which Tab always can.
export function useRevealFocus<
  TReveal extends HTMLElement = HTMLElement,
  TTrigger extends HTMLElement = HTMLButtonElement,
>(open: boolean, onClose: () => void) {
  const triggerRef = useRef<TTrigger | null>(null);
  const revealRef = useRef<TReveal | null>(null);
  // Tracks the previous value so the effect moves focus only on a genuine
  // TRANSITION — never on an unrelated re-render, and never on mount (a page
  // that server-renders the closed state must not steal focus on hydration).
  const wasOpen = useRef(open);

  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) {
      revealRef.current?.focus();
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  const onRevealKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  return { triggerRef, revealRef, onRevealKeyDown };
}
