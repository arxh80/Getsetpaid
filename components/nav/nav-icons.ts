import {
  House,
  Users,
  Building2,
  Music,
  Handshake,
  MapPin,
  CalendarDays,
  SquareCheckBig,
  UsersRound,
  StickyNote,
  FileText,
  Compass,
  IdCard,
  Send,
  Link2,
  UserCog,
  Settings,
  type LucideIcon,
} from "lucide-react";

/**
 * Path -> icon, one per sidebar destination. Kept separate from
 * lib/nav/areas.ts on purpose: that file is plain data (path/label/sub) meant
 * to be imported by a Server Component (app/(app)/[orgSlug]/page.tsx) with no
 * reason to pull a component library into a page that only ever renders text
 * and links. This map is imported only from inside the client sidebar tree.
 *
 * Icons are DECORATIVE (DESIGN.md has no icon system of its own to defer to,
 * and the task brief is explicit: "Icons are decorative; the heading is the
 * accessible name"). components/nav/nav-item.tsx renders every icon with
 * `aria-hidden="true"` and never relies on one alone to identify a
 * destination -- the heading and subheading text is what a screen reader (and
 * the collapsed rail's sr-only text) actually announces.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  // The workspace hub -- lib/nav/areas.ts's OVERVIEW_ITEM, whose path is the
  // one empty string in the map.
  "": House,
  contacts: Users,
  companies: Building2,
  artists: Music,
  agencies: Handshake,
  venues: MapPin,
  events: CalendarDays,
  tasks: SquareCheckBig,
  meetings: UsersRound,
  notes: StickyNote,
  documents: FileText,
  network: Compass,
  "network/profiles": IdCard,
  "network/requests": Send,
  "network/links": Link2,
  members: UserCog,
  "settings/custom-fields": Settings,
};
