# Dark rebrand — colour scheme and logo lockup

**Status:** approved by the founder 2026-09-09.
**Branch:** `dark-rebrand`, off `keyboard-a11y` (`80ee45f`).
**Supersedes:** `DESIGN.md` § Palette, § Interaction states, § Tokens, § Anti-patterns, and the "Dark mode" entry in § Open.

---

## 1. Why

The founder supplied a new logo: an outlined mark and a "GETSETPAID." wordmark, drawn
in a single spring green on black with white type. The product's existing palette —
a warm `#FFF4F4` shell with two blues, lilac and pink — shares no colour with it.

The brand green cannot simply be added to the light palette. Measured:

| `#20FC8F` on | Ratio | Usable? |
|---|---|---|
| `#FFF4F4` (current shell) | 1.27:1 | No — fails even the 3:1 non-text threshold |
| `#FFFFFF` | 1.37:1 | No |
| `#000000` | 15.38:1 | Yes |
| `#14141C` | 13.42:1 | Yes |

The green is a light value. It can only carry meaning as a foreground on a dark
ground, or as a fill with dark text on it. A light-mode product cannot use it as an
accent the way `#3A86FF` is used today, so adopting the logo's colour and keeping the
light shell are mutually exclusive. The founder chose the dark ground.

## 2. Brand constants

Sampled from the supplied artwork, not eyeballed:

| Colour | Hex | Source |
|---|---|---|
| Brand green | `#20FC8F` | 711,074 opaque pixels in `brand/LOGO.png`; identical value in `brand/logo_with_text.png` |
| Black | `#000000` | Ground of `brand/logo_with_text.png` |
| White | `#FFFFFF` | Wordmark of `brand/logo_with_text.png` |

These three are fixed. Everything below is derived from them.

## 3. Palette

### 3.1 Tokens

Every ratio is printed by `scripts/contrast.py`, not asserted.

| Token | Value | On shell | On surface | Role |
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
| `--scrim` | `rgb(0 0 0 / 0.6)` | — | — | Behind modals and drawers |

`--ink` is `#F5F5F7`, not `#FFFFFF`. Pure white on near-black blooms at small sizes;
a two-point step off white removes the halation without costing measurable contrast
(18.05:1 against 19.65:1).

`--rule` at 1.38:1 is deliberate and permitted: it is decorative separation only.
Any border that carries meaning — active row, selected state, error outline — uses
`--rule-strong` at 3.69:1, or `--accent`.

### 3.2 Removed tokens

`#3A86FF`, `#0062FF`, `#BDB2FF` and `#FFD6E0` are deleted from the system.

- `--lilac` and `--pink` had **zero** usages across 220 component files. Removing them
  is free.
- `--primary` (197 usages, mostly `text-primary` on links) and `--accent` (41 usages)
  change value only. No component is edited.

This deletes the "two-blue rule", which `CLAUDE.md` calls "the single easiest thing to
get wrong". There is now one brand colour, so the class of mistake no longer exists.

### 3.3 `--success` and `--primary` share one value — deliberately

Both are `#20FC8F`. Introducing a second green a few degrees away would recreate
exactly the confusable-pair problem the two-blue rule existed to manage, in a new
place. Separation is structural instead of chromatic:

- **Status** is always a chip: `--rule-strong` border, uppercase label at `--text-xs`,
  never bare coloured text.
- **Interactive** green is a link (underlined) or a filled button (`--on-primary` label).

`DESIGN.md` already forbids status conveyed by colour alone, so this tightens an
existing rule rather than adding a new risk. A reviewer seeing green text must be able
to tell what it is from its shape, not its hue.

### 3.4 Chart ramp — a separate namespace

Charts need five categorically distinct series. They get their own tokens, prefixed
`--chart-`, and those tokens are **never used in UI chrome**. All measured on
`--surface`; each clears the 3:1 non-text threshold with wide margin:

| Token | Value | On surface |
|---|---|---|
| `--chart-1` | `#20FC8F` | 13.33 |
| `--chart-2` | `#5AA9FF` | 7.41 |
| `--chart-3` | `#FFC24B` | 11.33 |
| `--chart-4` | `#C79BFF` | 8.28 |
| `--chart-5` | `#FF8FB1` | 8.51 |

Keeping them namespaced is what stops `--chart-2` drifting back into the UI as a
second accent and reinventing the two-blue problem.

### 3.5 Focus

The global rule in `app/globals.css` is `outline: 2px solid var(--color-ink)` with
`outline-offset: 2px`. Under the new palette `--color-ink` is `#F5F5F7`, which clears
3:1 on `--shell` (18.05), `--surface` (16.71) and `--surface-raised` (15.21).

White on a green fill is **1.25:1** and would fail — but `outline-offset: 2px` draws
the ring on the parent background, never on the control's own fill, so a green button
focused on a dark page shows a white ring against the page. That is safe.

The exception is an **inset** ring. `app/globals.css` has exactly one:
`nav[aria-label="Primary"] :focus-visible` uses a negative offset because the rail is a
scroll container that clips an outset ring. Checked: the rail's active row is
`border-accent bg-surface` — a green *left border*, not a green fill — so its inset ring
lands on `#15151A` at 16.71:1. No green-filled element hosts an inset ring anywhere in
the app today.

`--focus-on-primary` (`#0B0B0E`, 14.40:1 on green) is defined anyway, unused, as the
required override the moment anyone puts an inset ring on a green surface. It is a trap
guard, and `scripts/contrast.py` asserts its ratio so it cannot silently rot.

### 3.6 Interaction states invert

On a light ground, hover darkens. On a dark ground it must lighten, or the state reads
as "disabled" rather than "live". The existing `components/ui/button.tsx` already
composes this correctly by accident: `primary` is `bg-primary text-on-primary` with
`hover:bg-ink`, which on the new palette means a green fill lightening to `#F5F5F7`
with `#0B0B0E` text — 18.05:1, a clear and legible hover.

| Variant | Rest | Hover | Measured |
|---|---|---|---|
| `primary` | `#20FC8F` fill, `#0B0B0E` label | `#F5F5F7` fill, `#0B0B0E` label | 14.40 → 18.05 |
| `secondary` | `#15151A` fill, `#F5F5F7` label | `#0B0B0E` fill, `#F5F5F7` label | 16.71 → 18.05 |
| `danger` | `#15151A` fill, `#FF6B61` label | `#FF6B61` fill, `#15151A` label | 6.52 → 6.52 |
| `quiet` | underlined `#F5F5F7` | `#20FC8F` | 18.05 → 14.40 |

So the button's Tailwind classes need **no change**. What does change is its header
comment, which currently reads "focus is a 2px INK ring so it stays visible on a
`--primary` fill (3.66:1)" and "adding [a second blue] would break the two-blue rule" —
both statements are about a palette that no longer exists. Row-hover in
`DESIGN.md` § Interaction states flips the same way: `--surface` → `--surface-raised`
instead of white → `#FBF6F6`.

## 4. Type

**Unchanged.** Source Serif 4 keeps the whole UI: every size in the existing scale,
the `tabular-nums` rule, the mono stack. No new webfont is loaded.

The ultra-condensed grotesque of the wordmark exists **only** as outlined vector paths
inside the logo component. It is artwork, not a UI typeface. `DESIGN.md` § Type gains
an explicit line saying so, so that a later contributor does not "match the brand font"
in a page heading.

One dark-ground adjustment: headings move from weight 800 to 700. Heavy serifs bloom
against a dark background — 700 on `#0B0B0E` reads with the same weight 800 had on
`#FFF4F4`. Body stays 400. Table headers stay 600.

## 5. Logo component

### 5.1 API

`components/wordmark.tsx` — one inline SVG component, no image request, no font
dependency, no layout shift. It keeps the existing `Wordmark` export name and its
`className` prop so both call sites are untouched.

```tsx
<Wordmark />          // ⬢ GETSETPAID.  — full lockup
<Wordmark markOnly /> // ⬢              — favicon source, future narrow breakpoint
```

- Mark fills with `var(--color-accent)`.
- Wordmark fills with `currentColor`, so it inherits `--ink` in the sidebar and can be
  inverted anywhere else without a second asset.
- Order is **mark first, then wordmark** — the reverse of `brand/logo_with_text.png`,
  chosen so `markOnly` is a clean split rather than a crop.
- Accessible name: the component renders `role="img"` with an `aria-label` of
  "GetSetPaid". `markOnly` in a link that already has a label renders `aria-hidden`.

### 5.2 How the paths are produced

No vector tracer is installed on this machine — `potrace`, `vtracer`, `inkscape` and
ImageMagick's `magick` are all absent, and `numpy` is not available to Python either.
So the tracer is written as part of this work:

`scripts/trace-logo.py` — pure Python plus Pillow:

1. Load `brand/LOGO.png`, threshold the alpha channel at 50%.
2. Marching squares to extract closed contours, outer and inner (the mark is an
   outline, so every stroke yields two contours).
3. Douglas–Peucker simplification, epsilon tuned so the rendered result is
   indistinguishable from the source at 200px.
4. Normalise to a `0 0 100 100` viewBox, round coordinates to one decimal place.
5. Repeat over the white channel of `brand/logo_with_text.png`, cropped to the
   wordmark, for the eleven glyphs of "GETSETPAID."
6. Emit both as `d` attributes into the component.

The script is committed so the paths can be regenerated if the artwork changes.

**Budget: under 15KB of path data.** If simplification cannot hit that budget while
staying sharp at 20px, the fallback is an optimised 2x PNG through `next/image` —
and that fallback gets reported, not shipped silently, because it loses the token-driven
colour.

## 6. Placement

The lockup **replaces `components/wordmark.tsx`**, which today renders the string
"GetSetPaid" in Source Serif 4 at weight 800. Its own header comment explains why:

> no logotype file, no icon […] inventing a mark for a product that has not
> commissioned one would be exactly the kind of invented content the brief warns
> against.

A real mark now exists, so that reasoning has expired. The component keeps its name and
its two call sites, so no layout changes:

| Call site | Position | Rendering |
|---|---|---|
| `app/(app)/layout.tsx:134` | Top-left of the app header, inside `<Link href="/">` | Full lockup |
| `app/(auth)/layout.tsx:26` | Top-left of the auth header, inside `<Link href="/">` | Full lockup |

**The sidebar carries no logo and gains none.** `components/nav/sidebar.tsx` is a
separate collapsible rail (`RAIL_WIDTH_COLLAPSED` 64px / `RAIL_WIDTH_EXPANDED` 280px)
that begins below the header and holds navigation only. `markOnly` therefore has no
call site in the app at MVP — it exists for the favicon pipeline and so a future
narrow-header breakpoint has a defined collapsed form rather than an improvised crop.

Also:

- **Favicon and app icons** regenerate from the mark on `#0B0B0E`.
- **`<meta name="theme-color">`** set to `#0B0B0E`.
- **`color-scheme: dark`** on the root so native form controls, scrollbars and the
  browser's own UI follow the app.

`Wordmark` is wrapped in `<Link href="/" className="no-underline">` at both sites. The
link keeps its accessible name from the component's `aria-label`, so the anchor needs
no additional text and gains none.

## 7. Files changed

| File | Change |
|---|---|
| `DESIGN.md` | § Palette, § Interaction states, § Tokens, § Anti-patterns rewritten; dark mode removed from § Open; logotype note added to § Type |
| `CLAUDE.md` | § Design's palette paragraph — it names `#FFF4F4`, lilac, pink, `#14141C` and the two-blue rule in prose, and is the summary every agent reads before touching UI. Stale here is worse than stale in a comment. |
| `app/globals.css` | `@theme` token values; `color-scheme: dark` |
| `scripts/contrast.py` | New `TOKENS` and `CONTRACT` — the 19 pairs in § 8 |
| `scripts/trace-logo.py` | New — contour tracer |
| `components/wordmark.tsx` | Rewritten as the inline SVG lockup; name and both call sites unchanged |
| `app/layout.tsx` | `theme-color`, favicon, `color-scheme` |
| `brand/LOGO.png`, `brand/logo_with_text.png` | New — committed sources |
| `public/` icons | Regenerated from the mark |

Everything else is a token-value change. **No component logic is edited.** That is the
whole point of the existing semantic-token discipline, and this change is its first
real test.

The Google SSO button keeps its literal `#4285F4`, `#EA4335`, `#FBBC05` and `#34A853` —
Google's brand guidelines require them and they are already the documented exception to
the no-literal-hex rule. Its surface moves to `--surface`; the button's contrast against
the new dark ground is re-measured as part of § 8.

## 8. Acceptance criteria

1. `python scripts/contrast.py` exits zero with all 19 contract pairs passing:
   body/muted text on shell, surface and raised; link on shell and surface; primary
   button label; success, warning and danger text on surface; focus ring on shell,
   surface, raised and primary fill; accent border on shell and surface; strong border
   on shell and surface.
2. Zero occurrences of `#3A86FF`, `#0062FF`, `#BDB2FF`, `#FFD6E0`, `#FFF4F4`,
   `#14141C`, `#55555F`, `#D6CBCB`, `#0E5F42`, `#7A4F00` or `#9E1C15` in `app/`,
   `components/`, `lib/`, `DESIGN.md` or `scripts/contrast.py`. `docs/` is exempt —
   this spec quotes the old values on purpose.
3. Zero literal hex in `components/` and `app/` outside `app/globals.css` and the
   documented Google SSO exception.
4. No stale comment describing the old palette. Specifically:
   `components/ui/button.tsx`'s two-blue and 3.66:1 claims (§ 3.6),
   `app/globals.css`'s `@theme` header block, and `components/wordmark.tsx`'s
   "no logotype file, no icon" rationale (§ 6) are all rewritten. Grep for
   `two-blue`, `3.66`, `4.65`, `3.23` and `lilac` to find the rest.
5. The existing gates stay green: `pnpm lint`, `pnpm typecheck`, `pnpm test`
   (1518 vitest), `pnpm test:e2e` (87 Playwright including the 25 axe scans).
6. The axe scans specifically must stay clean — they check computed contrast against
   the rendered page, so they are the independent check on § 3 rather than a
   restatement of it.
7. Manual sweep: every one of the 220 components rendered at least once against the
   dark ground, looking for anything that assumed a light shell — hardcoded white
   backgrounds, images without a dark variant, borders that vanish, skeleton
   placeholders tuned for light.
8. The logo renders sharp at 20px, 24px and 200px, and `markOnly` is legible at 16px.

## 9. Risks

**A light-ground assumption hiding in a component.** 220 files were built and reviewed
on a light shell. The token discipline means most will simply invert, but anything that
used `bg-surface` to mean "white" rather than "the card colour" will look wrong. This
is what acceptance criterion 6 exists for, and it is the largest single cost in the
work — half a day of looking, not a script.

**Loading skeletons.** They were tuned on `bg-rule` against a light shell
(`loading-skeletons`, PR #11, already in this branch's ancestry). `--rule` on dark is a
much smaller step from `--surface` than it was on light, so the skeletons may become
nearly invisible. They will likely need `--surface-raised` instead. Checked as part of
criterion 6.

**Phase 7 conflicts.** `admin-phase` is in flight off the same `80ee45f` and touches
`app/globals.css`. It will need a rebase after this lands. Named here so it is not a
surprise.

**Trace fidelity.** Covered in § 5.2 — the fallback is explicit and gets reported.

## 10. Out of scope

- A light theme or a theme toggle. Dark only. `DESIGN.md` never required light mode,
  and a toggle doubles the contrast contract for no stated need.
- Marketing site, OG images, email templates. The transactional email templates from
  `email-setup` are a separate branch and render in the recipient's mail client, not
  the app; rebranding them is its own piece of work.
- Any change to component structure, routing or data. Colour, type weight, and one new
  component.
