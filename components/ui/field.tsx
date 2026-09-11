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
  // Email is never a word, never a sentence, and never capitalised. Left to
  // the defaults, a phone keyboard capitalises the first letter and autocorrect
  // "fixes" the domain -- both of which produce an address that silently fails
  // to match an existing account. Overridable per call site if ever needed.
  const typeDefaults =
    props.type === "email"
      ? ({
          spellCheck: false,
          autoCorrect: "off",
          autoCapitalize: "none",
        } as const)
      : {};

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
        {...typeDefaults}
        {...props}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "placeholder:text-ink-muted " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          // Hover/focus swap the hairline for the accent rail. --accent is a
          // BORDER colour here, never text: it is the brand green, and green
          // text beside a green focus rail is the structural confusion
          // DESIGN.md § Palette exists to prevent.
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

interface TextAreaFieldProps extends Omit<ComponentProps<"textarea">, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string;
}

/**
 * The same field, for a paragraph.
 *
 * ADDED BY TASK 4b, AND A SEPARATE COMPONENT RATHER THAN A `multiline` PROP ON
 * `Field`. `Field` spreads `ComponentProps<"input">` onto an `<input>`;
 * `<textarea>` takes a different prop set (`rows`, no `type`, no `size`), so a
 * flag would mean two prop unions and a cast at the spread. Two components
 * that share their accessibility wiring by writing it out twice is worse than
 * one that shares it by structure -- but the wiring here is nine lines and
 * the alternative is a generic that neither reads nor typechecks well.
 *
 * WHAT IS DELIBERATELY THE SAME: the visible bound `<label>`, the persistent
 * hint, the error BELOW ITS OWN FIELD with `role="alert"` and
 * `aria-describedby`, and `aria-invalid` on the control itself. Every rule in
 * `Field`'s header applies unchanged, and an error summary at the top of a
 * form with nothing next to the input is still a WCAG 3.3.1 failure.
 *
 * TWO COLUMNS THIS SERVES: `artists.notes` and `venues.technical_info`. Both
 * are untrusted free text with no structure by design, both are capped at
 * MAX_LONG_TEXT in lib/crm/validate.ts, and both are rendered as TEXT on the
 * way out -- never as HTML, never through `dangerouslySetInnerHTML`.
 */
export function TextAreaField({
  label,
  hint,
  error,
  required,
  className = "",
  rows = 5,
  ...props
}: TextAreaFieldProps) {
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

      <textarea
        {...props}
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "w-full min-w-0 border bg-surface px-3 py-2 text-base text-ink " +
          "placeholder:text-ink-muted " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
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
    </div>
  );
}

interface SelectFieldProps extends Omit<ComponentProps<"select">, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string;
}

/**
 * The same field, for a closed vocabulary.
 *
 * ADDED BY PHASE 3 TASK 4, and a third component rather than a `as` prop on
 * `Field` for exactly the reason `TextAreaField` is a second one: `Field`
 * spreads `ComponentProps<"input">` onto an `<input>`, and `<select>` takes a
 * different prop set (`multiple`, children instead of `value`, no `type`), so
 * a flag would mean two prop unions and a cast at the spread.
 *
 * WHAT IS DELIBERATELY THE SAME, and why this exists at all rather than each
 * form hand-rolling a `<label>` and a `<select>`: components/crm/ already has
 * five hand-wired selects, and the final review's I-12 found three
 * accessibility defects in one of them that the axe run reported as ZERO
 * violations -- an error inside the `<label>` (so it becomes part of the
 * control's accessible name rather than a separately announced error), an
 * error `<p>` nothing references by `aria-describedby` (announced to nobody),
 * and a `<form>` inside a `<span>`. All three are valid markup. So the wiring
 * is here: visible bound label, persistent hint, error BELOW the control with
 * `role="alert"` and `aria-describedby`, `aria-invalid` on the control itself.
 *
 * A NATIVE `<select>`, never a custom listbox -- components/org/
 * workspace-switcher.tsx's header carries that argument in full, and it holds
 * doubly here: this form must work with JavaScript disabled, and a `<div>`
 * wearing `role="listbox"` does not.
 *
 * `<optgroup>` ARRIVES AS CHILDREN, not as a prop. The event form's room
 * picker groups every room in the workspace under its venue, and inventing an
 * options-and-groups prop shape to express that would be a second, worse way
 * to write markup the caller can already write.
 */
export function SelectField({
  label,
  hint,
  error,
  required,
  className = "",
  children,
  ...props
}: SelectFieldProps) {
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

      <select
        {...props}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          // Hover/focus swap the hairline for the accent rail. --accent is a
          // BORDER colour here, never text: it is the brand green, and green
          // text beside a green focus rail is the structural confusion
          // DESIGN.md § Palette exists to prevent.
          (error
            ? "border-danger "
            : "border-rule hover:border-ink focus:border-accent ") +
          "disabled:cursor-not-allowed disabled:opacity-55 " +
          className
        }
      >
        {children}
      </select>

      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
