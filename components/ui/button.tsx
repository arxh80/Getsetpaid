"use client";

import type { ComponentProps, MouseEvent } from "react";

// Button.
//
// DESIGN.md § Shape and § Interaction states, expressed once:
//   square corners (global --radius: 0), no shadow, 1px borders only, hover
//   LIGHTENS the fill without moving or scaling anything, focus is a 2px
//   --color-focus ring at outline-offset: 2px, so it lands on the page behind
//   the control and stays legible even against a green fill (--color-focus ON
//   --color-primary is 1.25:1 and would not, on the fill itself).
//
// Height is 44px minimum (h-11) because that is the touch-target floor, and
// because a 44px control next to a 44px input is the only way the forms line
// up without per-page nudging.
//
// STATES. Every interactive control in this app ships all eight: default,
// hover, focus-visible, active, disabled, loading, error, success. The first
// five live here; loading is `pending` below; error and success are rendered
// by the surrounding field/alert components rather than by the button, because
// a button that turns red is colour-as-only-signal.

type Variant = "primary" | "secondary" | "quiet" | "danger";

const BASE =
  "inline-flex h-11 items-center justify-center gap-2 border px-4 " +
  "text-base font-semibold whitespace-nowrap " +
  "transition-colors duration-[var(--dur-fast)] ease-brand " +
  "disabled:cursor-not-allowed disabled:opacity-55";

const VARIANTS: Record<Variant, string> = {
  // The brand green, the only fill on a primary action (14.40:1 on the
  // shell; the --on-primary label on it is 14.40:1). Hover LIGHTENS to
  // --ink rather than darkening -- on a dark ground a darker hover reads as
  // disabled, not as live. 18.05:1 in that state.
  primary:
    "border-primary bg-primary text-on-primary " +
    "hover:border-ink hover:bg-ink " +
    "active:border-ink active:bg-ink",
  secondary:
    "border-rule bg-surface text-ink " +
    "hover:border-ink hover:bg-shell " +
    "active:border-ink active:bg-shell",
  // No border, no fill -- for tertiary actions that must not compete.
  quiet:
    "border-transparent bg-transparent px-2 text-ink underline underline-offset-4 " +
    "hover:text-primary",
  danger:
    "border-danger bg-surface text-danger " +
    "hover:bg-danger hover:text-surface " +
    "active:bg-danger active:text-surface",
};

interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  /**
   * Async in flight. Blocks the control AND swaps the label, because a
   * spinner alone is invisible to a screen reader; `aria-busy` announces it
   * and the changed label makes it legible without one.
   */
  pending?: boolean;
  pendingLabel?: string;
}

/**
 * PENDING IS `aria-disabled`, NOT `disabled` — AND THE DIFFERENCE IS FOCUS
 * (keyboard-a11y pass).
 *
 * `disabled={pending}` was the previous shape, and it has a keyboard cost the
 * mouse never pays: the instant a keyboard user activates a submit, React
 * re-renders with `disabled` on the element that HOLDS FOCUS, and the browser
 * responds by blurring it to `<body>`. Every submit in the product therefore
 * dropped a keyboard user's position — WCAG 2.4.3's "focus is not lost"
 * expectation, failed once per form. `aria-disabled` keeps the element
 * focusable (so focus survives the whole round trip and lands back on the
 * re-enabled control), still announces "unavailable" to a screen reader, and
 * the click guard below is what makes it true rather than cosmetic: a repeat
 * Enter mid-flight — including the implicit form submission a text field's
 * Enter routes through the default submit button — is cancelled before it can
 * dispatch the action twice.
 *
 * The `disabled` PROP keeps its native meaning. A permanently blocked control
 * (wrong tier, wrong role) is genuinely inert, carries `aria-describedby`
 * pointing at the one explanation on the page, and the e2e suite strips the
 * attribute to prove the server refuses anyway — none of that changes here.
 */
export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  className = "",
  children,
  disabled,
  onClick,
  ...props
}: ButtonProps) {
  const blockWhilePending = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      {...props}
      onClick={blockWhilePending}
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      className={`${BASE} ${VARIANTS[variant]} ${pending ? "cursor-progress opacity-55 " : ""}${className}`}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
