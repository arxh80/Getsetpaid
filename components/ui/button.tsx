import type { ComponentProps } from "react";

// Button.
//
// DESIGN.md § Shape and § Interaction states, expressed once:
//   square corners (global --radius: 0), no shadow, 1px borders only, hover
//   darkens the fill without moving or scaling anything, focus is a 2px INK
//   ring so it stays visible on a --primary fill (3.66:1) as well as on the
//   shell.
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
  "transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] " +
  "disabled:cursor-not-allowed disabled:opacity-55";

const VARIANTS: Record<Variant, string> = {
  // The only blue permitted on a filled button (--primary, 4.65:1; white label
  // on it is 5.01:1). Hover darkens by compositing ink over the fill rather
  // than introducing a second blue -- adding one would break the two-blue rule
  // by stealth.
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
   * Async in flight. Disables the control AND swaps the label, because a
   * spinner alone is invisible to a screen reader; `aria-busy` announces it
   * and the changed label makes it legible without one.
   */
  pending?: boolean;
  pendingLabel?: string;
}

export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  className = "",
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`${BASE} ${VARIANTS[variant]} ${className}`}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
