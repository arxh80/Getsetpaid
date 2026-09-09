# Design system

The visual direction for GetSetPaid. This is the source of truth for colour, type, spacing and shape. PRD §9 sets the UX requirements; this file sets the concrete values.

**Building UI? Read ["Build-time design tooling"](#build-time-design-tooling) first** — it names which design skills to invoke, in what order, and which of their defaults to discard.

**Direction:** minimalist, sharp-edged, bold serif on a near-black ground. No rounded corners, no drop shadows, no gradients. Structure comes from hairline rules, generous whitespace and typographic weight — not from decoration.

---

## Palette

**One brand green on a dark ground.** The founder's logo is drawn in a single
spring green, `#20FC8F`, and that is a *light* value: it can only carry meaning
as a foreground on a dark ground, or as a fill with dark text on it. Measured:

| `#20FC8F` on | Ratio | Usable? |
|---|---|---|
| the warm shell this palette replaced | 1.27:1 | No — fails even the 3:1 non-text threshold |
| `#FFFFFF` | 1.37:1 | No |
| `#000000` | 15.38:1 | Yes |
| the old ink, used as a ground | 13.42:1 | Yes |

So adopting the logo's colour and keeping a light shell were mutually exclusive.
The founder chose the dark ground.

### Working palette

Every ratio below is printed by `python scripts/contrast.py`, not asserted.

| Token | Hex | On shell | On surface | Role |
|---|---|---|---|---|
| `--shell` | `#0B0B0E` | — | — | Page ground |
| `--surface` | `#15151A` | 1.08 | — | Cards, tables, drawers |
| `--surface-raised` | `#1E1E25` | 1.19 | 1.10 | Overlays, modals, hovered row |
| `--ink` | `#F5F5F7` | 18.05 | 16.71 | All body text, headings, icons |
| `--ink-muted` | `#9A9AA4` | 7.05 | 6.53 | Secondary text, metadata, sub-labels |
| `--primary` | `#20FC8F` | 14.40 | 13.33 | Links, primary button fill |
| `--on-primary` | `#0B0B0E` | — | — | Text on a green fill (14.40:1) |
| `--accent` | `#20FC8F` | 14.40 | 13.33 | Borders, focus rails, active state |
| `--rule` | `#2A2A33` | 1.38 | 1.28 | Hairline borders, table dividers |
| `--rule-strong` | `#6A6A78` | 3.69 | 3.42 | Meaningful borders, active row |
| `--success` | `#20FC8F` | 14.40 | 13.33 | Confirmed, paid, on sale |
| `--warning` | `#FFB020` | 10.75 | 9.95 | Hold, pending, overdue soon |
| `--danger` | `#FF6B61` | 7.05 | 6.52 | Cancelled, failed, destructive |
| `--focus` | `#F5F5F7` | 18.05 | 16.71 | Focus ring on any dark surface |
| `--focus-on-primary` | `#0B0B0E` | — | — | Focus ring on a green fill (14.40:1) |
| `--skeleton-breathe` | `#3A3A45` | 1.75 | 1.62 | Loading-bone shimmer stop |
| `--scrim` | `rgb(0 0 0 / 0.6)` | — | — | Behind modals and drawers |

`--ink` is `#F5F5F7`, not `#FFFFFF`. Pure white on near-black blooms at small
sizes; a two-point step off white removes the halation without costing
measurable contrast (18.05:1 against 19.65:1).

`--rule` at 1.38:1 is deliberate and permitted: it is decorative separation
only. Any border that carries **meaning** — active row, selected state, error
outline — uses `--rule-strong` at 3.69:1, or `--accent`.

### Removed tokens

The light palette's blue pair, its lilac and its pink surfaces are **deleted
from the system**, along with its ink, muted ink, rule and its three status
colours.
Nothing is renamed and nothing is aliased: the names are gone.

- The lilac surface token had **zero** usages — only its own declaration.
  Removing it was free.
- The pink surface token had zero usages *as a class name* across 220
  components, but `app/globals.css` referenced it inside the `@keyframes skeleton-pulse` block:
  it was the loading bone's breathe stop. Deleting the token without repointing
  that keyframe would have frozen every skeleton in the app — a keyframe naming
  a dead custom property does not error, it resolves to nothing and the
  animation silently stops at its rest colour. `--skeleton-breathe` `#3A3A45`
  took over: 1.27:1 from `--rule`, against the 1.20:1 the light pair had.
  Decorative, so no contrast gate applies — the loading *message* is carried by
  `role="status"` text.
- `--primary` (197 usages, mostly `text-primary` on links) and `--accent` (41
  usages) changed **value only**. No component was edited.

This also deletes the old **blue-pair rule** — the split between a text blue and
a border blue that `CLAUDE.md` called "the single easiest thing to get wrong".
There is one brand colour now, so that class of mistake no longer exists.

### `--success` and `--primary` share one value — deliberately

Both are `#20FC8F`. Introducing a second green a few degrees away would rebuild
exactly the confusable-pair problem that blue split existed to manage, in a
new place. Separation is **structural**, never chromatic:

- **Status** is always a chip: `--rule-strong` border, uppercase label at
  `--text-xs`, never bare coloured text.
- **Interactive** green is a link (underlined) or a filled button
  (`--on-primary` label).

This file already forbids status conveyed by colour alone, so the rule tightens
an existing one rather than adding a new risk. A reviewer seeing green text must
be able to tell what it is from its shape, not its hue.

### Chart ramp — a separate namespace

Charts need five categorically distinct series. They get their own tokens,
prefixed `--chart-`, and those tokens are **never used in UI chrome**. All
measured on `--surface`; each clears the 3:1 non-text threshold with wide
margin:

| Token | Hex | On surface |
|---|---|---|
| `--chart-1` | `#20FC8F` | 13.33 |
| `--chart-2` | `#5AA9FF` | 7.41 |
| `--chart-3` | `#FFC24B` | 11.33 |
| `--chart-4` | `#C79BFF` | 8.28 |
| `--chart-5` | `#FF8FB1` | 8.51 |

Keeping them namespaced is what stops `--chart-2` drifting back into the
interface as a second accent and reinventing the problem the one-green rule
just removed.

### Focus

The global rule in `app/globals.css` is `outline: 2px solid var(--color-focus)`
with `outline-offset: 2px`. `--focus` and `--ink` share a value (`#F5F5F7`)
today, but the ring is drawn from the dedicated focus token, not the text one,
precisely so the two can diverge later (an inset ring on a green surface,
below) without the rule quietly drawing the wrong colour. `--focus` clears
3:1 on `--shell` (18.05), `--surface` (16.71) and `--surface-raised` (15.21).

White on a green fill is **1.25:1** and would fail — but `outline-offset: 2px`
draws the ring on the **parent background**, never on the control's own fill, so
a green button focused on a dark page shows a white ring against the page. That
is what makes one ring safe everywhere.

The exception is an **inset** ring. `app/globals.css` has exactly one:
`nav[aria-label="Primary"] :focus-visible` uses a negative offset because the
rail is a scroll container that clips an outset ring. That rail's active row is
a green *left border* on `--surface`, not a green fill, so its inset ring lands
at 16.71:1. No green-filled element hosts an inset ring anywhere in the app
today.

`--focus-on-primary` (14.40:1 on green) is defined anyway, unused, as the
required override the moment anyone puts an inset ring on a green surface. It is
a trap guard, and `scripts/contrast.py` asserts its ratio so it cannot silently
rot.

### Other constraints

- Text on any palette surface is `--ink` or `--ink-muted`. Verified: `--ink` on
  shell 18.05:1, on surface 16.71:1, on raised 15.21:1; `--ink-muted` 7.05:1 and
  6.53:1. On a green fill the label is `--on-primary` at 14.40:1, never `--ink`.
- Status must never be colour-only — always pair with a text label or shape.
  Colour-blind users and greyscale printing both need it, and `--success` and
  `--primary` sharing a value makes it doubly true here.
- Adding a colour means adding a row above with its measured ratio.
  `scripts/contrast.py` prints it.

---

## Type

**Bold serif throughout.** One family, weight does the work — that is what keeps it minimalist.

**The wordmark's ultra-condensed grotesque is artwork, not a UI typeface.** It exists only as outlined vector paths inside `components/wordmark.tsx`; there is no font file behind it and none is loaded. Do not "match the brand font" in a page heading — every piece of UI type is Source Serif 4.

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

Headings are 700–800, matching what actually ships: `grep -rn "font-extrabold" app components` returns 79 hits across 72 files, including `app/(auth)/login/page.tsx`'s `<h1>` — the one heading a human has actually looked at rendered on this ground, and it reads well at 800. Body is 400. Table headers are 600 with `letter-spacing: 0.04em` and uppercase at `--text-xs`.

Whether 800 "blooms" more than 700 on this near-black shell — heavy serifs picking up extra visual weight against dark — is a real question but an **open** one, not a settled rule: nobody has measured it or looked at the 72 files side by side, and the branch that would have made 700 the rule never touched them. Treat a 700-vs-800 pass as a deliberate future visual decision, not a defect to fix opportunistically.

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
2. A background step: `--shell` (page) → `--surface` (card) → `--surface-raised` (overlay), or `--surface` with a `--rule-strong` border where the step alone is too quiet.
3. For drawers and modals: a `1px solid var(--ink)` border plus `--scrim`, which is black at 60%. Not the light system's ink-at-40%: on a near-black page a 40% wash of a near-black ink is not a scrim, it is nothing.

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

**Control height: 44px.** Interactive rows and controls that a finger must hit (sidebar nav rows, and any future toolbar of the same kind) are 44px tall — deliberately off the 4px-scale's named stops (between `--space-6` and `--space-7`) because it is WCAG 2.5.8's enlarged touch-target size, not a spacing decision. Use it as a height only; it never becomes a padding or gap value.

---

## Interaction states

| State | Treatment |
|---|---|
| Hover (row) | Background `--surface` → `--surface-raised`; no movement, no shadow |
| Hover (button) | A **filled** control (`primary`) lightens its fill one step; no scale, no lift. On a dark ground a darker fill reads as disabled, not as live — the direction inverts from the light system. A **bordered** control (`secondary`, `quiet`) carries its identity in the border and label, not the fill, so it may step its fill back toward the page ground (`--surface` → `--shell`) on hover — legible and legitimate, because the border and label state carry the "live" signal, not the fill's direction |
| Focus | `outline: 2px solid var(--color-focus); outline-offset: 2px` — see below |
| Active | Left border `3px solid var(--accent)`, background `--surface` |
| Selected | Background `--surface-raised` with a `--rule-strong` left border, `--ink` text |
| Disabled | `--ink-muted` text at 55%, `--rule` border, no fill change |

Focus must be visible on `--shell`, `--surface` and `--surface-raised`. `--focus` at 2px clears 3:1 on all three, with room to spare: 18.05:1, 16.71:1 and 15.21:1.

It is **`outline-offset: 2px` that makes one ring enough**, not the ring's own contrast. `--focus` on a green fill is 1.25:1 and would fail — but the offset draws the ring on the parent background, never on the control's own fill, so a green button focused on a dark page shows a white ring against the page. The one inset ring in the app (`nav[aria-label="Primary"] :focus-visible`, which uses a negative offset because the rail clips an outset one) sits on `--surface` at 16.71:1, its active row being a green *left border* rather than a green fill. Put an inset ring on a green surface and `--focus-on-primary` (14.40:1) becomes mandatory; § Palette's "Focus" explains why it exists unused.

Keyboard focus is never removed. `:focus-visible` for pointer users, full `:focus` for keyboard.

---

## Motion

Minimal and fast. Nothing bounces, nothing scales.

```
--dur-fast: 120ms;   --dur-base: 160ms;   --dur-slow: 240ms;
--ease: cubic-bezier(0.2, 0, 0, 1);
```

Only `opacity`, `background-color`, `border-color` and `transform: translate` are animated. Drawers slide on X, no fade-scale. Always honour `prefers-reduced-motion: reduce` by dropping to `--dur-fast` opacity only — except an **infinite loop**, which must stop outright (`animation: none`): a clamped duration on a loop resamples the keyframes every frame, which is a strobe, the opposite of what the preference asks for.

**Second standing waiver: the skeleton shimmer loops at 1.8s** (`--animate-skeleton`, `app/globals.css`; every `components/skeleton/` bone). The `--dur-*` tokens time one-shot state transitions; a continuous idle loop at 240ms flickers. The waiver is exactly one keyframe pair — `background-color` between `--rule` and `--skeleton-breathe`, symmetric ease-in-out — instant-off under reduced motion per the rule above. Like the sidebar's width tween, it is not precedent: a third duration outside the scale means adding a `--dur-loop` token here first.

**One standing waiver: the sidebar rail animates `width`** (`components/nav/sidebar.tsx`, reviewed and accepted). The rail's expand/collapse is a container growing around fixed-size children; the two letter-of-the-rule alternatives are worse — `scaleX` squashes every child with the container, and a `translateX` overlay changes the rail from pushing content to covering it, a bigger deviation than the property. The waiver is exactly that one tween: `--dur-slow` / `--ease`, instant under `prefers-reduced-motion`, expansion gated on hover capability plus ~120ms of hover intent so a passing pointer never pays the relayout. It is not precedent for animating `width`/`height` anywhere else; the property list above stays the rule. One acknowledged consequence rides with it: a rail that pushes rather than overlays necessarily translates the centred content column while it expands (the layout balances the rail's *collapsed* footprint with a matching trailing spacer, so the column is centred at rest and the translation exists only during hover/pin) — accepted as the cost of choosing push over overlay, not a defect to engineer away.

---

## Error pages

404, 403, 500 and maintenance/offline all share one layout: they are not a place to teach the product (that's what empty states are for) — they are a dead end, and the job is to get the user out of it in one click.

**Layout.** Centred on `--shell`, no chrome beyond the global nav if the session is authenticated. Large display numeral in `--text-5xl`/`--font-display`, one short sentence under it in `--text-lg`, one primary button back to safety. No illustration, no mascot, no joke copy — sharp-edged and quiet, consistent with the rest of the product.

```
404
Page not found.
[ Back to dashboard ]
```

The numeral may use `--danger`, which clears 4.5:1 as body text on both grounds (7.05:1 on shell, 6.52:1 on surface) and needs no large-text exemption; body copy stays `--ink`. Never colour-only — the numeral and the label always ship together.

| Page | Copy | Primary action | Notes |
|---|---|---|---|
| 404 Not found | "Page not found." | Back to dashboard | Also served for any record ID that doesn't resolve — see the tenant-isolation rule below; the "404" names the page, not always the HTTP status (record-level refusals stream as 200 — see "What identical 404 means at the HTTP layer" below) |
| 403 Forbidden | "You don't have access to this." | Back to dashboard | Only for a route that is category-gated (e.g. a Free-tier user hitting a Pro-only page) — never used for a record in another org, see below |
| 500 Server error | "Something went wrong on our end." | Retry / Back to dashboard | No stack trace, no error ID exposed unless it's a correlation ID meant for support |
| Maintenance / offline | "GetSetPaid is temporarily unavailable." | — (no action; optional status-page link if one exists) | Static page, must render with no JS/DB dependency |
| Unauthenticated | "Sign in to continue." | Sign in | Redirect-after-login preserves the original destination |

**Tenant-isolation rule (security-critical, ties to `CLAUDE.md` § Non-negotiable rules and the IDOR/BOLA testing gate):** a record that exists but belongs to another organisation must render the **identical 404** as a record that doesn't exist at all. Never a distinguishing 403, never a different message, never a different response time band. Returning 403 for "exists, not yours" and 404 for "doesn't exist" is an enumeration oracle — it lets an attacker map another tenant's IDs. 403 is reserved for feature/tier gating on a route the user's own org simply can't access, not for cross-tenant record lookups.

**What "identical 404" means at the HTTP layer, since the loading-skeletons pass:** a *workspace*-level refusal (a slug the caller cannot see) still carries a literal HTTP 404 — `app/(app)/[orgSlug]/layout.tsx` throws it above every loading boundary. A *record*-level refusal under a valid slug **streams**: the route's `loading.tsx` flushes the status line (200) before the page's `notFound()` lands, so both "exists, not yours" and "doesn't exist" return HTTP 200 with the identical not-found document (and Next's injected `noindex` meta). The rule's property is the **indistinguishability of the two cases** — identical status, identical document, identical query path — and it is measured directly by `tests/e2e/tenant-breakout.spec.ts`'s REFUSAL PARITY test rather than implied by a fixed status code. A route handler (e.g. the document download gate) never streams and keeps the literal 404.

**Copy tone:** plain, no blame, no apology beyond "something went wrong." No exclamation marks, no "oops," matching the serif/sharp-edged direction — errors are not the place for personality.

---

## Tokens

Tailwind v4 is CSS-first, so `app/globals.css`'s `@theme` block **is** this
contract compiled — `bg-shell`, `text-ink-muted`, `border-rule`, `p-5`,
`text-2xl` all resolve from it, and there is no `tailwind.config.js` to
disagree. What follows is that block; `tests/unit/design/token-drift.test.ts`
asserts it against `scripts/contrast.py` so the two cannot drift apart.

```css
@theme {
  /* Ground */
  --color-shell: #0B0B0E;          /* page */
  --color-surface: #15151A;        /* cards, tables, drawers */
  --color-surface-raised: #1E1E25; /* overlays, modals, hovered row */

  /* Text */
  --color-ink: #F5F5F7;        /* 18.05:1 on shell */
  --color-ink-muted: #9A9AA4;  /*  7.05:1 on shell */

  /* Brand — ONE green, from the logo. --primary and --accent are the same
     value on purpose; see "Removed tokens". */
  --color-primary: #20FC8F;    /* 14.40:1 on shell — links, primary fill */
  --color-on-primary: #0B0B0E; /* 14.40:1 on --color-primary */
  --color-accent: #20FC8F;     /* borders, focus rails, active state */

  /* Structure */
  --color-rule: #2A2A33;        /* 1.38:1 — DECORATIVE separation only */
  --color-rule-strong: #6A6A78; /* 3.69:1 — any border that carries meaning */
  --color-scrim: rgb(0 0 0 / 0.6);

  /* Focus — see "Focus" above for why one ring is enough */
  --color-focus: #F5F5F7;
  --color-focus-on-primary: #0B0B0E;

  /* Status — never the only signal, always paired with a label */
  --color-success: #20FC8F;    /* 13.33:1 on surface */
  --color-warning: #FFB020;    /*  9.95:1 on surface */
  --color-danger: #FF6B61;     /*  6.52:1 on surface */

  /* Charts — a SEPARATE namespace, never used in UI chrome */
  --color-chart-1: #20FC8F;    /* 13.33:1 on surface */
  --color-chart-2: #5AA9FF;    /*  7.41:1 */
  --color-chart-3: #FFC24B;    /* 11.33:1 */
  --color-chart-4: #C79BFF;    /*  8.28:1 */
  --color-chart-5: #FF8FB1;    /*  8.51:1 */

  /* Type */
  --font-serif: var(--font-source-serif-4), "Iowan Old Style", Georgia,
    "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-xs: 0.75rem;      --text-xs--line-height: 1rem;
  --text-sm: 0.8125rem;    --text-sm--line-height: 1.25rem;
  --text-base: 0.9375rem;  --text-base--line-height: 1.5rem;
  --text-lg: 1.0625rem;    --text-lg--line-height: 1.625rem;
  --text-xl: 1.25rem;      --text-xl--line-height: 1.75rem;
  --text-2xl: 1.5625rem;   --text-2xl--line-height: 2rem;
  --text-3xl: 2rem;        --text-3xl--line-height: 2.375rem;
  --text-4xl: 2.75rem;     --text-4xl--line-height: 3rem;
  --text-5xl: 3.75rem;     --text-5xl--line-height: 3.875rem;

  /* Shape — square everywhere */
  --radius: 0;

  /* Space — 4px base */
  --spacing: 0.25rem;

  /* Motion. `--ease-*` is a v4 theme namespace, so this generates the
     `ease-brand` utility. `--duration-*` is NOT, so the durations live in
     :root below and are referenced as duration-[var(--dur-fast)]. */
  --ease-brand: cubic-bezier(0.2, 0, 0, 1);

  /* Skeleton shimmer — a background-colour crossfade, never a gradient */
  --color-skeleton-breathe: #3A3A45;
  --animate-skeleton: skeleton-pulse 1.8s ease-in-out infinite;

  @keyframes skeleton-pulse {
    0%, 100% { background-color: var(--color-rule); }
    50%      { background-color: var(--color-skeleton-breathe); }
  }
}

:root {
  --dur-fast: 120ms;
  --dur-base: 160ms;
  --dur-slow: 240ms;
}

html {
  overflow-x: clip;
  background: var(--color-shell);
  /* Declared, not inferred. Undeclared, a machine set to light mode renders
     the browser's OWN chrome light -- native <select> popups, form-control
     internals, scrollbars, autofill -- against a near-black page. `dark` pins
     all of it to the palette contrast.py measures. There is no light theme
     and no toggle. */
  color-scheme: dark;
}
body {
  overflow-x: clip;
  background: var(--color-shell);
  color: var(--color-ink);
  font-family: var(--font-serif);
}
*, *::before, *::after { border-radius: var(--radius); }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  /* Except an infinite loop, which stops outright — see § Motion. */
  .animate-skeleton { animation: none !important; }
}
```

Google's sign-in button carries the official four-colour "G" as four
`--brand-google-*` custom properties in `app/globals.css`. They are third-party
brand marks fixed by Google's guidelines, **not design tokens**, and are
quarantined there so the "no literal hex in a component" rule still holds across
the whole app.

---

## Anti-patterns

Reject these in review:

- Any `border-radius` above 0.
- Any `box-shadow` used for elevation.
- **`--chart-*` used anywhere in UI chrome.** They are a chart namespace and nothing else; the moment one becomes a second accent, the confusable-pair problem is back.
- **A second green introduced to distinguish success from primary.** They share a value on purpose — separate them structurally (a bordered uppercase chip versus an underlined link or a filled button), never by hue.
- **A literal hex in a component.** Go through the token. There are exactly three documented exceptions, all of them places a CSS custom property cannot reach: the Google SSO button's four brand colours, quarantined as `--brand-google-*` in `app/globals.css`; `app/icon.svg`, which the browser fetches as a file before any stylesheet; and `app/layout.tsx`'s `themeColor`, a `<meta>` read from the document head for the same reason. `tests/unit/design/token-drift.test.ts` enforces the rule and names every exemption.
- **A filled control's fill darkening on hover.** On this ground darker reads as disabled — a fill carries the control's identity, so `primary` must lighten. This does not extend to a bordered control (`secondary`, `quiet`): its identity is the border and label, and stepping its fill back to the page ground (`--surface` → `--shell`) on hover is legible, not a disabled read. Reject a hover only when it reads as disabled, not by fill direction alone.
- Status conveyed by colour alone, with no label.
- Numbers in a table without `tabular-nums`.
- A gradient anywhere.
- Adding a colour that is not in this file. Extend the file first, with a measured ratio from `scripts/contrast.py`.

---

## Build-time design tooling

When the build starts, no UI is written from scratch and unaided. Every screen goes through the design skills below. This section is the contract for how they are used.

### The precedence rule

> **This file outranks every skill.** Skills supply method — layout systems, component anatomy, UX heuristics, accessibility checks. They do **not** supply our tokens. Where a skill's default fights a rule here, this file wins, silently and always.

The defaults that will fight us, in every skill: rounded corners, drop shadows, gradients, glassmorphism, sans-serif type stacks, indigo/violet "SaaS" accent colours, bouncy spring motion, and generic sales-CRM layouts. Take the structure, throw away the styling, re-express it in the tokens above.

If a skill's output cannot be expressed in these tokens, the answer is to extend this file deliberately — with a measured contrast ratio — not to let the skill's palette in through a component.

### Installed skills

Design and frontend skills are pinned **project-level** in `skills-lock.json` and vendored to `.agents/skills/`, so the whole team and every agent get the same set:

| Skill | Source | Role |
|---|---|---|
| `hallmark` | `nutlope/hallmark` | House style, structure, anti-slop |
| `web-design-guidelines` | `vercel-labs/agent-skills` | UI review against the Web Interface Guidelines |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | React/Next performance patterns |
| `vercel-composition-patterns` | `vercel-labs/agent-skills` | Compound components, reusable APIs |
| `nextjs-app-router-patterns` | `wshobson/agents` | Server Components, streaming, data fetching |
| `tailwind-design-system` | `wshobson/agents` | Tailwind v4 CSS-first `@theme` tokens |
| `shadcn-ui` | `giuseppe-trisciuoglio/developer-kit` | shadcn component anatomy and setup |
| `typescript-advanced-types` | `wshobson/agents` | Type-level modelling |
| `accessibility-compliance` | `wshobson/agents` | WCAG 2.2 AA, ARIA, focus management |

Plus the globally installed `ui-ux-pro-max:*`, `frontend-design`, `taste-skill:*`, `dataviz`, `framer-motion-best-practices` and `superpowers:*`.

Backend, security and testing skills are pinned in the same lock file but documented where their gates live: `SECURITY.md` § 11 (`supabase`, `supabase-postgres-best-practices`, `supabase-audit-rls`, `owasp-security-check`, `javascript-testing-patterns`, `e2e-testing-patterns`, `wcag-audit-patterns`, `screen-reader-testing`).

Restore after a clone with `npx skills experimental_install`; check for updates with `npx skills check`. Adding a skill means adding a row here in the same commit.

### Order of invocation — three passes over every piece of UI

**Pass 1 — Decide (before any code)**

1. **`superpowers:brainstorming`** — settle the job the screen does and the states it has (empty, loading, partial, error, dense, over-limit) before pixels.
2. **`hallmark`** — pinned house style engine. Its `study` / greenfield verbs for structure, macrostructure and slop avoidance. `.agents/skills/hallmark/references/` holds the detail: `layout-and-space.md`, `typography.md`, `interaction-and-states.md`, `motion.md`, `responsive.md`, `component-cookbook.md`, `anti-patterns.md`, `slop-test.md`.
3. **`ui-ux-pro-max:ui-ux-pro-max`** — UX layer: product-type patterns, UX guidelines, interaction states. Ignore its style/palette/font-pairing catalogues entirely; we already have those.
4. **`frontend-design:frontend-design`** — the check against templated defaults. Run it the moment something starts to look like a generic dashboard.

**Pass 2 — Build**

5. **`tailwind-design-system`** — Tailwind v4 is CSS-first, so [our tokens](#tokens) go straight into `@theme` as the single source. Its example scales, palettes and radii are discarded on arrival.
6. **`shadcn-ui`** + **`ui-ux-pro-max:ui-styling`** — component anatomy and Radix a11y wiring. Every shadcn component ships rounded and shadowed: set `--radius: 0` and strip shadow utilities **once in the theme**, never per component.
7. **`nextjs-app-router-patterns`** + **`vercel-composition-patterns`** — Server/Client boundary, data fetching, and component APIs. Composition matters most for the one shared timeline/activity component and the entity drawers — build them compound, not as a wall of boolean props.
8. **`typescript-advanced-types`** — model org scope, roles and entitlements in the type system so a tenant mix-up is a compile error, not a runtime one. It never replaces the RLS policy.

**Pass 3 — Review (before merge)**

9. **`web-design-guidelines`** — run it on the diff. It fetches Vercel's Web Interface Guidelines live and reports `file:line` findings.
10. **`accessibility-compliance`** — WCAG 2.2 AA is a PRD acceptance criterion, so this runs on every interactive component: ARIA, focus management, focus trapping, keyboard paths, reduced motion.
11. **`vercel-react-best-practices`** — performance pass on anything rendering a list, a table or a feed. Dense CRM tables are where this pays.

Passes 1 and 3 are non-negotiable. Pass 2 is as needed, but expected on anything larger than a single control.

### Skill map

| Use case | Skill | Take | Discard |
|---|---|---|---|
| House style, structure, anti-slop | `hallmark` | Macrostructure, spacing rhythm, state coverage, slop test | Its theme/colour presets |
| UX patterns, flows, a11y heuristics | `ui-ux-pro-max:ui-ux-pro-max` | Product-type patterns, UX rules, interaction states | Style catalogue, palettes, font pairings |
| Distinctive visual direction | `frontend-design:frontend-design` | The "does this read as a template?" test | Any new palette |
| Tailwind v4 theme setup | `tailwind-design-system` | CSS-first `@theme`, token layering, variants | Its palettes, radii, shadow scale |
| shadcn / Radix components | `shadcn-ui`, `ui-ux-pro-max:ui-styling` | Component anatomy, Radix a11y wiring | Default radius, shadow, colour ramp |
| Next.js structure and data | `nextjs-app-router-patterns` | Server/Client split, streaming, fetching | Framework-default styling examples |
| Component API design | `vercel-composition-patterns` | Compound components, context providers | — |
| React/Next performance | `vercel-react-best-practices` | List/table rendering, bundle, memoisation | — |
| Types for tenancy and roles | `typescript-advanced-types` | Branded types, discriminated unions | Any suggestion that types replace RLS |
| WCAG 2.2 AA compliance | `accessibility-compliance` | ARIA patterns, focus trapping, keyboard | Its contrast advice — `scripts/contrast.py` is authoritative |
| UI review on a diff | `web-design-guidelines` | `file:line` findings, forms/focus/semantics | — |
| Token architecture as it grows | `ui-ux-pro-max:design-system` | Primitive → semantic → component layering | Its example scales — ours are set above |
| Charts and finance visuals | `dataviz` | Chart-type choice, axis/legend/tooltip rules, stat tiles | Its placeholder palette — use `--chart-1` … `--chart-5` |
| Motion, drawers, transitions | `framer-motion-best-practices` | `AnimatePresence`, layout animation, reduced-motion | Springs and bounce — see [Motion](#motion) |
| Reference-driven redesign | `taste-skill:redesign-skill`, `taste-skill:minimalist-skill` | Editorial density, typographic contrast | Warm-monochrome palette, pastel drift |
| Screenshot → component | `taste-skill:image-to-code-skill` | Structure extraction | Everything visual from the source image |
| High-polish marketing/landing pages | `frontend-design-pro:frontend-design-pro` | Composition, imagery direction | Stock-photo maximalism; never used inside the app |
| Mockups before code | `design` (canvas) | Fast artboard exploration of a flow | — |
| Logo, brand marks, identity | `ui-ux-pro-max:brand`, `taste-skill:brandkit` | Identity system thinking | Palette proposals |
| Imagery and OG assets | `banana-claude:banana`, `ui-ux-pro-max:banner-design` | Generated marketing imagery only | Any use inside product UI |
| Second opinion on a visual call | `bencium-controlled-ux-designer` | Its ask-before-deciding discipline | — |

**Do not use in this product:** `taste-skill:soft-skill` (rounded, soft — directly opposed to our shape rule), `taste-skill:brutalist-skill` (degradation/analog effects — we are sharp, not distressed), `scroll-world` (scroll-jacking), `21st-registry` (publishes our components publicly — not while the design is proprietary), `ui-ux-pro-max:slides` and `artifact-*` (documents and decks, not product UI).

### Phase mapping

| Build phase | Skills |
|---|---|
| Scaffold Next.js + theme | `nextjs-app-router-patterns`, `tailwind-design-system` → [Tokens](#tokens) into `@theme` as the single source |
| Primitive components (button, input, chip, table, drawer) | `hallmark`, `shadcn-ui`, `ui-ux-pro-max:ui-styling`, `accessibility-compliance` |
| Golden path screens (contact → event → artist → venue → task → activity) | `superpowers:brainstorming` → `hallmark` → `ui-ux-pro-max:ui-ux-pro-max` |
| The shared timeline/activity component | `hallmark` + `vercel-composition-patterns` (one component, reused everywhere — decide it once) |
| Dense list and table views | `vercel-react-best-practices` (virtualisation, memo) + `tabular-nums` |
| Event finance: budget & actuals | `dataviz` + `tabular-nums` rule above |
| Drawers, command palette, transitions | `framer-motion-best-practices` + `accessibility-compliance` (focus trapping) under our motion tokens |
| Org/role/entitlement modelling in the client | `typescript-advanced-types` — types narrow, RLS enforces |
| Empty states and onboarding copy | `hallmark` (`copy.md`) — empty states teach the workflow |
| Public marketing site (post-MVP) | `frontend-design-pro:frontend-design-pro`, `banana-claude:banana` |

### Gate before any UI merges

1. `python scripts/contrast.py` passes.
2. `hallmark` slop test passes (`references/slop-test.md`).
3. `web-design-guidelines` run on the diff, findings cleared.
4. `wcag-audit-patterns` audit clean, and `accessibility-compliance` satisfied: keyboard path complete, focus visible on every surface, ARIA correct. `screen-reader-testing` on anything with a custom widget.
5. Zero non-zero `border-radius`, zero `box-shadow`, zero gradient, zero literal hex in the diff — tokens only.

Failing any of these means the feature is not done, same as a failing test.

---

## Open

- **Display face** for marketing pages — Source Serif 4 throughout by default; Fraunces is the alternate if more voice is wanted on the public site.
