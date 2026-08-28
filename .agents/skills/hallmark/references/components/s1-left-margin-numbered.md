
### S1 · Left-margin numbered
A narrow left column holds `01 — LABEL.`; the wide right column holds the heading and content.
*Use when:* the page is editorial / specimen **and the user explicitly asked for a
hanging / left-margin editorial layout**.
*Don't confuse with:* S5 Bottom-anchored (which puts the label *under* the section).

> ⚠️ **Gate 54 conflict — read before using.** The markup below is the tag-left /
> header-right two-column section head that [`slop-test.md`](../slop-test.md) gate 54
> hard-bans and [`anti-patterns.md`](../anti-patterns.md) calls "the single most
> reliable AI-templated tell for editorial-style SaaS pages".
> [`layout-and-space.md`](../layout-and-space.md) permits it *only* on explicit
> request and *only* when no eyebrow / number / chapter tag sits in the left margin —
> which is precisely what `.num-label` is. Default to a stacked single-column head
> (label directly above the heading, same column). Reach for S1 only on an explicit
> ask, and expect it to fail gate 54 on self-critique.
<!-- GSP-PATCH: warning added. Upstream ships this archetype with no reference to
     gate 54, so an agent reading only this file adopts a shape the slop test then
     auto-fails. The other three files already agree it is banned by default. -->

```html
<header class="head-margin">
  <p class="num-label">01 — Foundations</p>
  <h2>…</h2>
</header>
```
```css
.head-margin { display: grid; grid-template-columns: 10rem 1fr; gap: var(--space-xl); align-items: baseline; }
```
