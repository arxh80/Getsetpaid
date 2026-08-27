// Skip-to-content link (WCAG 2.4.1, Bypass Blocks).
//
// Visually hidden until it receives keyboard focus, then it becomes the first
// thing on the page. Without it, every keyboard and screen-reader user tabs
// through the whole header on every single page before reaching anything they
// came for -- which is trivial here with one nav item, and stops being trivial
// the moment the workspace switcher and global search land.
//
// Deliberately NOT `display: none` / `hidden` when inactive: a hidden element
// is not focusable, so the link would never appear. The clip-based technique
// below keeps it in the accessibility tree and in the tab order.
export function SkipLink() {
  return (
    <a
      href="#main"
      className={
        "sr-only " +
        "focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 " +
        "focus:inline-flex focus:h-11 focus:items-center focus:border " +
        "focus:border-ink focus:bg-surface focus:px-4 focus:text-base " +
        "focus:font-semibold focus:text-ink focus:no-underline"
      }
    >
      Skip to content
    </a>
  );
}
