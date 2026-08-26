# Design system

The visual direction for GetSetPaid. This is the source of truth for colour, type, spacing and shape. PRD §9 sets the UX requirements; this file sets the concrete values.

**Direction:** minimalist, sharp-edged, bold serif. No rounded corners, no drop shadows, no gradients. Structure comes from hairline rules, generous whitespace and typographic weight — not from decoration.

---

## Palette

Source palette (https://colorhunt.co/palette/3a86ffbdb2ffffd6e0fff4f4):
`#3A86FF` `#BDB2FF` `#FFD6E0` `#FFF4F4`.

Those four are pastels of near-equal lightness with no dark value between them, so **none of them can carry body text** against the shell — and PRD §14 commits us to WCAG 2.2 AA. Measured:

| On `--shell` `#FFF4F4` | Ratio | Body 4.5:1 | Large/UI 3:1 |
|---|---|---|---|
| `#3A86FF` | 3.23:1 | FAIL | PASS |
| `#BDB2FF` | 1.78:1 | FAIL | FAIL |
| `#FFD6E0` | 1.22:1 | FAIL | FAIL |

White text does not rescue the blue either — white on `#3A86FF` is 3.48:1, so the source palette cannot produce a compliant primary button in any combination.

**The fix: deepen the blue.** `#3A86FF` is `hsl(217, 100%, 61%)`. At 50% lightness it becomes `#0062FF` — identical hue, identical saturation, still an electric blue, but 4.65:1 as text and 5.01:1 under white. One value moves; the other three source colours are untouched, and the original blue stays in the set as the lighter accent.

### Working palette

| Token | Hex | On shell | Role |
|---|---|---|---|
| `--shell` | `#FFF4F4` | — | Page background *(source)* |
| `--surface` | `#FFFFFF` | — | Cards, tables, drawers — lifts off the warm shell without a shadow |
| `--ink` | `#14141C` | 17.01:1 | All body text, headings, icons |
| `--ink-muted` | `#55555F` | 6.84:1 | Secondary text, metadata, table sub-labels |
| `--primary` | `#0062FF` | 4.65:1 | Links, buttons, any blue that touches text |
| `--accent` | `#3A86FF` | 3.23:1 | Borders, focus rails, active state, chart primary *(source)* |
| `--lilac` | `#BDB2FF` | — | Surface, chips, chart series 2 *(source)* |
| `--pink` | `#FFD6E0` | — | Surface, chips, chart series 3 *(source)* |
| `--rule` | `#D6CBCB` | — | Hairline borders, table dividers |
| `--rule-strong` | `#14141C` | — | Emphasis borders, active row |
| `--success` | `#0E5F42` | 7.13:1 | Confirmed, paid, on sale |
| `--warning` | `#7A4F00` | 6.62:1 | Hold, pending, overdue soon |
| `--danger` | `#9E1C15` | 7.41:1 | Cancelled, failed, overdue, destructive |

### The two-blue rule

There are two blues 11% apart in lightness. They **will** be confused in review unless the split is explicit:

> **`--primary` `#0062FF` is the only blue permitted to touch text or a button.**
> **`--accent` `#3A86FF` is borders, focus rails, active indicators and chart marks — never text, never a fill behind a label.**

The one exception: `--accent` may carry **large bold display text at ≥24px bold**, where 3:1 applies and it passes at 3.23:1.

### Other constraints

- `--lilac` and `--pink` are **surfaces only**. Never text, never a border that carries meaning, never the sole signal for a status.
- Text on any palette surface is `--ink`. Verified: on shell 17.01:1, on pink 13.91:1, on lilac 9.57:1, on `--primary` 3.66:1 (so a primary button uses **white** text at 5.01:1, not ink).
- Status must never be colour-only — always pair with a text label or shape. Colour-blind users and greyscale printing both need it.
- Adding a colour means adding a row above with its measured ratio. `scripts/contrast.py` prints it.

---

## Type

**Bold serif throughout.** One family, weight does the work — that is what keeps it minimalist.

```
--font-display: "Source Serif 4", "Iowan Old Style", Georgia, "Times New Roman", serif;
--font-body:    "Source Serif 4", "Iowan Old Style", Georgia, "Times New Roman", serif;
--font-mono:    "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

Source Serif 4 is a variable serif designed for screen and UI, with real weights to 900 and tabular figures — it holds up in dense tables where a display serif would not. Load only the weights used: 400, 600, 700, 800.

If a higher-contrast display face is wanted for marketing pages later, add **Fraunces** with `SOFT=0, WONK=0` (those axes off keep the terminals sharp) for `--font-display` only. Do not put it in tables.

### Scale

Base 15px — serifs need slightly more size than a sans at the same density.

| Token | Size / line-height | Use |
|---|---|---|
| `--text-xs` | 12 / 16 | Table meta, timestamps, chip labels |
| `--text-sm` | 13 / 20 | Dense table cells, secondary UI |
| `--text-base` | 15 / 24 | Body, forms, default |
| `--text-lg` | 17 / 26 | Lead paragraph, drawer body |
| `--text-xl` | 20 / 28 | Card and section headings |
| `--text-2xl` | 25 / 32 | Entity name, page heading |
| `--text-3xl` | 32 / 38 | Page title |
| `--text-4xl` | 44 / 48 | Display |
| `--text-5xl` | 60 / 62 | Hero display only |

Headings are 700–800. Body is 400. Table headers are 600 with `letter-spacing: 0.04em` and uppercase at `--text-xs`.

Display sizes (`--text-3xl` and up) get `letter-spacing: -0.02em` — bold serifs need tightening at scale.

### Numerals

Finance and tables **must** use tabular figures so columns align:

```css
font-variant-numeric: tabular-nums;
```

Apply to every table cell containing a number, every currency value and every date column. Non-negotiable — misaligned money is a legibility bug, and the PRD calls for careful financial hierarchy.

---

## Shape

**Every corner is square.**

```
--radius: 0;
```

No exceptions — buttons, inputs, cards, chips, modals, avatars, images, charts. If a component library ships rounded defaults, override them globally at the token level rather than per component.

**No shadows.** Depth is expressed by:
1. A `1px solid var(--rule)` hairline.
2. A background step: `--shell` (page) → `--surface` (card) → `--surface` with `--rule-strong` border (overlay).
3. For drawers and modals: a `1px solid var(--ink)` border plus a scrim of `rgb(20 20 28 / 0.4)`.

Borders are always exactly 1px. Emphasis comes from swapping `--rule` for `--rule-strong`, never from thickening to 2px, except the focus ring.

---

## Spacing

4px base unit.

```
--space-1: 4px    --space-5: 24px
--space-2: 8px    --space-6: 32px
--space-3: 12px   --space-7: 48px
--space-4: 16px   --space-8: 64px
                  --space-9: 96px
```

Dense table rows use `--space-2` vertical padding, `--space-3` horizontal. Forms use `--space-4`. Section separation uses `--space-7`.

---

## Interaction states

| State | Treatment |
|---|---|
| Hover (row) | Background `--surface` → `#FBF6F6`; no movement, no shadow |
| Hover (button) | Fill darkens one step; no scale, no lift |
| Focus | `outline: 2px solid var(--ink); outline-offset: 2px` — ink, not blue, so it is visible on every surface including a `--primary` fill |
| Active | Left border `3px solid var(--accent)`, background `--surface` |
| Selected | Background `--lilac` at 35% over `--surface`, ink text |
| Disabled | `--ink-muted` text at 55%, `--rule` border, no fill change |

Focus must be visible on `--shell`, `--surface`, `--primary`, `--lilac` and `--pink`. Ink at 2px clears 3:1 on all five (3.66:1 on `--primary`, its tightest case).

Keyboard focus is never removed. `:focus-visible` for pointer users, full `:focus` for keyboard.

---

## Motion

Minimal and fast. Nothing bounces, nothing scales.

```
--dur-fast: 120ms;   --dur-base: 160ms;   --dur-slow: 240ms;
--ease: cubic-bezier(0.2, 0, 0, 1);
```

Only `opacity`, `background-color`, `border-color` and `transform: translate` are animated. Drawers slide on X, no fade-scale. Always honour `prefers-reduced-motion: reduce` by dropping to `--dur-fast` opacity only.

---

## Tokens

Drop-in CSS custom properties.

```css
:root {
  /* Ground */
  --shell: #FFF4F4;      /* page */
  --surface: #FFFFFF;    /* cards, tables, drawers */

  /* Text */
  --ink: #14141C;        /* 17.01:1 on shell */
  --ink-muted: #55555F;  /*  6.84:1 on shell */

  /* Blue — two values, see "The two-blue rule" */
  --primary: #0062FF;    /*  4.65:1 — the ONLY blue allowed on text or a button */
  --on-primary: #FFFFFF; /*  5.01:1 on --primary */
  --accent: #3A86FF;     /*  3.23:1 — borders, focus rails, active, charts. Never text. */

  /* Surfaces */
  --lilac: #BDB2FF;
  --pink: #FFD6E0;

  /* Structure */
  --rule: #D6CBCB;
  --rule-strong: #14141C;
  --scrim: rgb(20 20 28 / 0.4);

  /* Status — never the only signal, always with a label */
  --success: #0E5F42;    /*  7.13:1 */
  --warning: #7A4F00;    /*  6.62:1 */
  --danger: #9E1C15;     /*  7.41:1 */

  /* Type */
  --font-display: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --font-body: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;

  --text-xs: 0.75rem;    --lh-xs: 1rem;
  --text-sm: 0.8125rem;  --lh-sm: 1.25rem;
  --text-base: 0.9375rem; --lh-base: 1.5rem;
  --text-lg: 1.0625rem;  --lh-lg: 1.625rem;
  --text-xl: 1.25rem;    --lh-xl: 1.75rem;
  --text-2xl: 1.5625rem; --lh-2xl: 2rem;
  --text-3xl: 2rem;      --lh-3xl: 2.375rem;
  --text-4xl: 2.75rem;   --lh-4xl: 3rem;
  --text-5xl: 3.75rem;   --lh-5xl: 3.875rem;

  /* Shape — square everywhere */
  --radius: 0;
  --border: 1px;

  /* Space */
  --space-1: 0.25rem; --space-2: 0.5rem;  --space-3: 0.75rem;
  --space-4: 1rem;    --space-5: 1.5rem;  --space-6: 2rem;
  --space-7: 3rem;    --space-8: 4rem;    --space-9: 6rem;

  /* Motion */
  --dur-fast: 120ms; --dur-base: 160ms; --dur-slow: 240ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);
}

html { background: var(--shell); color: var(--ink); font-family: var(--font-body); }
* { border-radius: var(--radius); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
```

---

## Anti-patterns

Reject these in review:

- Any `border-radius` above 0.
- Any `box-shadow` used for elevation.
- **`--accent` `#3A86FF` on any text under 24px bold, or as a fill behind a label.** Use `--primary`.
- **A literal `#3A86FF` or `#0062FF` in a component.** Go through the token, so the two-blue rule stays enforceable.
- Small text in `--lilac` or `--pink`.
- Status conveyed by colour alone, with no label.
- Numbers in a table without `tabular-nums`.
- A gradient anywhere.
- Adding a colour that is not in this file. Extend the file first, with a measured ratio from `scripts/contrast.py`.

---

## Open

- **Dark mode** is not specified. The palette is light-only, and the PRD does not require dark mode. If it is wanted, the pastels cannot invert directly — it needs a separately designed dark ramp, not a filter.
- **Charts** need series colours beyond three. `--accent`, `--lilac`, `--pink` cover three; a fourth-plus series needs derived steps with a verified categorical distinction.
- **Display face** for marketing pages — Source Serif 4 throughout by default; Fraunces is the alternate if more voice is wanted on the public site.
