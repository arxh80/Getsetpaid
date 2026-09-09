"""Check colours against the WCAG 2.2 AA targets DESIGN.md commits to.

    python scripts/contrast.py                    # audit every token pair
    python scripts/contrast.py "#20FC8F"          # one colour vs shell and surface
    python scripts/contrast.py "#0B0B0E" "#20FC8F"  # one explicit pair

AA thresholds: 4.5:1 for body text, 3:1 for large text (>=24px bold or >=18.66px)
and for UI components and meaningful borders.

Any colour added to DESIGN.md must arrive with its ratio printed from here.

The palette is dark. --color-rule (#2A2A33) is deliberately NOT in CONTRACT:
it is decorative separation at 1.38:1, and any border that carries meaning uses
rule-strong (3.69:1) or accent (14.40:1) instead.
"""

import sys

SHELL = "#0B0B0E"
SURFACE = "#15151A"

# Mirrors the token block in DESIGN.md and app/globals.css.
# tests/unit/design/token-drift.test.ts fails if this and globals.css disagree.
TOKENS = {
    "shell": "#0B0B0E",
    "surface": "#15151A",
    "surface-raised": "#1E1E25",
    "ink": "#F5F5F7",
    "ink-muted": "#9A9AA4",
    "primary": "#20FC8F",
    "on-primary": "#0B0B0E",
    "accent": "#20FC8F",
    "rule": "#2A2A33",
    "rule-strong": "#6A6A78",
    "success": "#20FC8F",
    "warning": "#FFB020",
    "danger": "#FF6B61",
    "focus": "#F5F5F7",
    "focus-on-primary": "#0B0B0E",
}

# (label, foreground token, background token, required ratio)
CONTRACT = [
    ("body text on page",          "ink",              "shell",          4.5),
    ("body text on card",          "ink",              "surface",        4.5),
    ("body text on raised",        "ink",              "surface-raised", 4.5),
    ("muted text on page",         "ink-muted",        "shell",          4.5),
    ("muted text on card",         "ink-muted",        "surface",        4.5),
    ("link on page",               "primary",          "shell",          4.5),
    ("link on card",               "primary",          "surface",        4.5),
    ("primary button label",       "on-primary",       "primary",        4.5),
    ("success text",               "success",          "surface",        4.5),
    ("warning text",               "warning",          "surface",        4.5),
    ("danger text",                "danger",           "surface",        4.5),
    ("focus ring on page",         "focus",            "shell",          3.0),
    ("focus ring on card",         "focus",            "surface",        3.0),
    ("focus ring on raised",       "focus",            "surface-raised", 3.0),
    ("focus ring on primary fill", "focus-on-primary", "primary",        3.0),
    ("accent border on page",      "accent",           "shell",          3.0),
    ("accent border on card",      "accent",           "surface",        3.0),
    ("strong border on page",      "rule-strong",      "shell",          3.0),
    ("strong border on card",      "rule-strong",      "surface",        3.0),
]


def _srgb(channel):
    return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"not a hex colour: {hex_colour}")
    r, g, b = (_srgb(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg):
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def report(fg, bg, need, label=""):
    r = ratio(fg, bg)
    verdict = "PASS" if r >= need else "FAIL"
    print(f"  {label:26} {fg:9} on {bg:9} {r:6.2f}:1  need {need}  {verdict}")
    return r >= need


def audit():
    print(f"DESIGN.md token contract — WCAG 2.2 AA\n{'-' * 74}")
    failures = 0
    for label, fg, bg, need in CONTRACT:
        if not report(TOKENS[fg], TOKENS[bg], need, label):
            failures += 1
    print("-" * 74)
    if failures:
        print(f"{failures} FAILING — DESIGN.md and the tokens are out of step.")
    else:
        print(f"All {len(CONTRACT)} checks pass.")
    return 1 if failures else 0


def main():
    args = [a for a in sys.argv[1:] if a.strip()]
    if not args:
        return audit()
    if len(args) == 1:
        c = args[0]
        print(f"{c} as text / as a fill\n{'-' * 74}")
        report(c, SHELL, 4.5, "as text on shell")
        report(c, SURFACE, 4.5, "as text on card")
        report("#FFFFFF", c, 4.5, "white label on it")
        report(TOKENS["ink"], c, 4.5, "ink label on it")
        report(c, SHELL, 3.0, "as border/large text")
        return 0
    print(f"{'-' * 74}")
    ok = report(args[0], args[1], 4.5, "pair")
    report(args[0], args[1], 3.0, "pair (large/UI)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
