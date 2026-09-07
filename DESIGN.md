# Design system

The visual direction for GetSetPaid. This is the source of truth for colour, type, spacing and shape. PRD §9 sets the UX requirements; this file sets the concrete values.

**Building UI? Read ["Build-time design tooling"](#build-time-design-tooling) first** — it names which design skills to invoke, in what order, and which of their defaults to discard.

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

**Control height: 44px.** Interactive rows and controls that a finger must hit (sidebar nav rows, and any future toolbar of the same kind) are 44px tall — deliberately off the 4px-scale's named stops (between `--space-6` and `--space-7`) because it is WCAG 2.5.8's enlarged touch-target size, not a spacing decision. Use it as a height only; it never becomes a padding or gap value.

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

The numeral may use `--danger` at display size (≥24px bold clears 3:1, same rule as `--accent`); body copy stays `--ink`. Never colour-only — the numeral and the label always ship together.

| Page | Copy | Primary action | Notes |
|---|---|---|---|
| 404 Not found | "Page not found." | Back to dashboard | Also served for any record ID that doesn't resolve — see the tenant-isolation rule below |
| 403 Forbidden | "You don't have access to this." | Back to dashboard | Only for a route that is category-gated (e.g. a Free-tier user hitting a Pro-only page) — never used for a record in another org, see below |
| 500 Server error | "Something went wrong on our end." | Retry / Back to dashboard | No stack trace, no error ID exposed unless it's a correlation ID meant for support |
| Maintenance / offline | "GetSetPaid is temporarily unavailable." | — (no action; optional status-page link if one exists) | Static page, must render with no JS/DB dependency |
| Unauthenticated | "Sign in to continue." | Sign in | Redirect-after-login preserves the original destination |

**Tenant-isolation rule (security-critical, ties to `CLAUDE.md` § Non-negotiable rules and the IDOR/BOLA testing gate):** a record that exists but belongs to another organisation must render the **identical 404** as a record that doesn't exist at all. Never a distinguishing 403, never a different message, never a different response time band. Returning 403 for "exists, not yours" and 404 for "doesn't exist" is an enumeration oracle — it lets an attacker map another tenant's IDs. 403 is reserved for feature/tier gating on a route the user's own org simply can't access, not for cross-tenant record lookups.

**What "identical 404" means at the HTTP layer, since the loading-skeletons pass:** a *workspace*-level refusal (a slug the caller cannot see) still carries a literal HTTP 404 — `app/(app)/[orgSlug]/layout.tsx` throws it above every loading boundary. A *record*-level refusal under a valid slug **streams**: the route's `loading.tsx` flushes the status line (200) before the page's `notFound()` lands, so both "exists, not yours" and "doesn't exist" return HTTP 200 with the identical not-found document (and Next's injected `noindex` meta). The rule's property is the **indistinguishability of the two cases** — identical status, identical document, identical query path — and it is measured directly by `tests/e2e/tenant-breakout.spec.ts`'s REFUSAL PARITY test rather than implied by a fixed status code. A route handler (e.g. the document download gate) never streams and keeps the literal 404.

**Copy tone:** plain, no blame, no apology beyond "something went wrong." No exclamation marks, no "oops," matching the serif/sharp-edged direction — errors are not the place for personality.

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
| Charts and finance visuals | `dataviz` | Chart-type choice, axis/legend/tooltip rules, stat tiles | Its placeholder palette — use `--accent`, `--lilac`, `--pink` |
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

- **Dark mode** is not specified. The palette is light-only, and the PRD does not require dark mode. If it is wanted, the pastels cannot invert directly — it needs a separately designed dark ramp, not a filter.
- **Charts** need series colours beyond three. `--accent`, `--lilac`, `--pink` cover three; a fourth-plus series needs derived steps with a verified categorical distinction.
- **Display face** for marketing pages — Source Serif 4 throughout by default; Fraunces is the alternate if more voice is wanted on the public site.
