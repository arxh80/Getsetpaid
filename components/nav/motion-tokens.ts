/**
 * DESIGN.md § Motion, mirrored into JS.
 *
 * framer-motion's `transition` prop needs numeric seconds and a bezier array,
 * not CSS custom properties -- there is no way to hand it `var(--dur-slow)`
 * or `var(--ease-brand)` directly. These two constants are that one value,
 * copied rather than computed, so `app/globals.css`'s `--dur-slow: 240ms` and
 * `--ease-brand: cubic-bezier(0.2, 0, 0, 1)` and this file must be kept in
 * step by hand if either ever changes. 240ms sits inside the task brief's
 * "fast (~200-300ms)" window and IS the token DESIGN.md already names for a
 * layout-affecting transition (`--dur-slow`, "drawers, modals" in effect
 * -- the sidebar rail is the same category of move).
 */
export const SIDEBAR_TRANSITION_SECONDS = 0.24;
export const SIDEBAR_EASE: [number, number, number, number] = [0.2, 0, 0, 1];

/** Rail width, collapsed (icon-only) and expanded (heading + subheading). */
export const RAIL_WIDTH_COLLAPSED = 64;
export const RAIL_WIDTH_EXPANDED = 280;
