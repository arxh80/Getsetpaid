import type { ReactNode } from "react";

// Form-level notice.
//
// DESIGN.md: "Status must never be colour-only -- always pair with a text
// label or shape. Colour-blind users and greyscale printing both need it." So
// each tone carries a WORD ("Error" / "Done" / "Note"), set in the tone's
// colour, ahead of the message. Remove the word and this becomes a red box and
// a green box that are identical in greyscale.
//
// role="alert" for errors (assertive -- the user just failed an action and
// needs to know now); role="status" otherwise (polite -- it must not interrupt
// whatever a screen-reader user is currently reading).

type Tone = "error" | "success" | "info";

const TONES: Record<Tone, { border: string; text: string; word: string }> = {
  error: { border: "border-danger", text: "text-danger", word: "Error" },
  success: { border: "border-success", text: "text-success", word: "Done" },
  info: { border: "border-rule", text: "text-ink-muted", word: "Note" },
};

export function Alert({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const { border, text, word } = TONES[tone];
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`border ${border} bg-surface px-3 py-3 text-base text-ink`}
    >
      <span className={`font-semibold ${text}`}>{word}.</span>{" "}
      {children}
    </p>
  );
}
