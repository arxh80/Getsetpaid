"use client";

import { useState } from "react";
import { Field } from "@/components/ui/field";

// Password field with a show/hide toggle.
//
// The toggle is not a nicety: without it, a long random password from a
// manager or a phone keyboard is untypeable by anyone who cannot see what they
// entered, and the usual response is to pick something shorter. WCAG 2.2 also
// removed the old "no exceptions to obscured input" stance for exactly this
// reason.
//
// The toggle is a real <button type="button"> so it is keyboard reachable and
// never submits the form, and its accessible name changes with state so a
// screen-reader user knows what pressing it will do. aria-pressed would be
// wrong here -- this is not a toggle whose "on" state is the point, it is an
// action whose label describes the next action.
export function PasswordInput({
  label,
  name,
  error,
  hint,
  autoComplete,
  required,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  autoComplete: "current-password" | "new-password";
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <Field
      label={label}
      name={name}
      type={visible ? "text" : "password"}
      autoComplete={autoComplete}
      // While the toggle above has the field showing plain text, the browser
      // treats it as an ordinary text input -- which means spellcheck, autocorrect
      // and auto-capitalisation all apply. Autocorrect silently rewriting a
      // password is the obvious hazard; spellcheck is the quieter one, since
      // some engines send the contents off-device to check them.
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="none"
      error={error}
      hint={hint}
      required={required}
      footer={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="self-start text-sm text-primary underline underline-offset-4"
        >
          {visible ? "Hide password" : "Show password"}
        </button>
      }
    />
  );
}
