/**
 * Plain, serialisable nav data -- what app/(app)/[orgSlug]/layout.tsx (a
 * Server Component) is allowed to hand to components/nav/sidebar.tsx (a
 * Client Component) as a prop. No icon components and no functions: those
 * cross the server/client boundary, and a React/lucide component reference
 * is not serialisable across it. The client side looks icons up itself, by
 * `path`, from components/nav/nav-icons.ts.
 */
export interface SidebarNavItem {
  /** Path segment(s) under `/${orgSlug}/` -- also the key into NAV_ICONS. */
  path: string;
  label: string;
  sub: string;
  /** Full href, already joined with the org slug, so the client component
   *  never has to know the URL shape or repeat the `/${slug}/` join. */
  href: string;
}

export interface SidebarNavGroup {
  id: string;
  heading: string;
  items: SidebarNavItem[];
}
