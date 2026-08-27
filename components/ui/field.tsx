"use client";

import { useId, type ComponentProps, type ReactNode } from "react";

// Labelled form field.
//
// This component exists so the accessibility wiring is impossible to forget,
// not to save typing. Every rule it enforces is one that is routinely missed:
//
//   - A VISIBLE <label> bound by htmlFor/id. A placeholder is not a label:
//     it disappears the moment someone types, which strands anyone who was
//     interrupted, and screen readers treat it inconsistently.
//   - The error message sits BELOW ITS OWN FIELD, is referenced by
//     aria-describedby, and carries role="alert" so it is announced. An error
//     summary at the top of a form, with nothing next to the input, is a
//     WCAG 3.3.1 failure.
//   - aria-invalid so the field itself is announced as invalid, not merely
//     described by some text.
//   - Helper text is PERSISTENT, not a placeholder, and is also wired through
//     aria-describedby.
//   - Required fields are marked in text, not by an unexplained asterisk and
//     not by colour.
//
// The error state is never colour-alone: --danger text plus the message plus
// aria-invalid. Colour is the least of the three signals.

interface FieldProps extends Omit<ComponentProps<"input">, "id"> {
  label: string;
  /** Persistent guidance under the input. Never a placeholder. */
  hint?: ReactNode;
  error?: string;
  /** Rendered under the input, e.g. a "forgot password" link. */
  footer?: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  footer,
  required,
  className = "",
  ...props
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
        {required ? (
          <span className="ml-2 font-normal text-ink-muted">Required</span>
        ) : (
          <span className="ml-2 font-normal text-ink-muted">Optional</span>
        )}
      </label>

      {hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}

      <input
        {...props}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "placeholder:text-ink-muted " +
          "transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] " +
          // Hover/focus swap the hairline for the accent rail. --accent is a
          // BORDER colour here, never text -- the two-blue rule.
          (error
            ? "border-danger "
            : "border-rule hover:border-ink focus:border-accent ") +
          "disabled:cursor-not-allowed disabled:opacity-55 " +
          className
        }
      />

      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}

      {footer}
    </div>
  );
}
