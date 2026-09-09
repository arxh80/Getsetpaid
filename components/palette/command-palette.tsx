"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import type { SidebarNavGroup } from "@/components/nav/types";
import { searchPaletteAction } from "@/lib/palette/search";
import {
  PALETTE_MIN_QUERY_LENGTH,
  PALETTE_OPEN_EVENT,
  type PaletteRecordGroup,
} from "@/lib/palette/results";

// The command palette: Ctrl/Cmd-K, jump to any section, find a record, start
// a new one. Founder scope is exactly that — no j/k list layer, no shortcut
// cheat-sheet, no "power" tier.
//
// ===========================================================================
// MOUNTED IN app/(app)/[orgSlug]/layout.tsx, BELOW THE MFA GATE — NOT IN THE
// SHELL, AND THE SEPARATION IS A GUARDED PROPERTY
// ===========================================================================
// The search action's module graph reaches the CRM list specs, and the app
// shell's graph must not (tests/unit/list/app-shell-has-no-crm-query.test.ts:
// a CRM read in the shell locks un-enrolled Owners/Admins out of the MFA
// enrolment screen). The header's visible trigger is therefore a separate,
// import-free component (palette-trigger.tsx) that dispatches
// PALETTE_OPEN_EVENT on window; this component listens for that event and for
// the hotkey. Mounting below the org segment also means the palette exists
// exactly where its sections and record search are meaningful — never on
// /invites, /onboarding, or a gate screen.
//
// ===========================================================================
// WIDGET SHAPE: A MODAL DIALOG WHOSE ONE CONTROL IS AN ARIA 1.2 COMBOBOX
// ===========================================================================
// The overlay is role="dialog" aria-modal="true"; inside it, the text input
// is role="combobox" (aria-expanded, aria-controls, aria-activedescendant,
// aria-autocomplete="list") over a role="listbox" of role="option" rows
// grouped with role="group" — the APG grouped-listbox shape. The options are
// deliberately NOT tab stops: the combobox pattern keeps DOM focus in the
// input and moves aria-activedescendant, so the tab ring inside the dialog is
// exactly one element and Tab is inert while it is open (preventDefault — a
// modal with one tabbable would otherwise let Tab escape into the inert page
// behind the scrim, WCAG 2.4.3's failure). Escape closes and returns focus to
// whatever opened it; choosing an option navigates and moves focus to #main,
// the same landing the skip link uses, so reading continues at the content
// that just changed.
//
// ===========================================================================
// WHERE THE DATA COMES FROM, AND WHAT NEVER REACHES THE CLIENT
// ===========================================================================
// Sections and actions are the CALLER's already-permission-filtered sidebar
// groups (lib/nav/sidebar-groups.ts builds them per role, the same builder
// the rail uses) — a static handful of links, filtered client-side because
// they are navigation, not records.
// Records come from searchPaletteAction, which reuses each entity's OWN list
// spec/select through fetchListPage — RLS-gated, tenant-clause, allowlisted
// search column, five rows per entity. No record data is ever downloaded
// ahead of a search; an empty palette holds only nav labels.
//
// ===========================================================================
// MOTION: NONE, ON PURPOSE
// ===========================================================================
// DESIGN.md § Motion is "minimal and fast"; a palette that must feel
// instant gets no entrance animation at all, which also means there is
// nothing for prefers-reduced-motion to reduce. Structure is the token
// depth-3 recipe: surface, 1px rule-strong border, --scrim wash behind.

/** One selectable row, whatever its origin. */
interface PaletteOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly href: string;
  /** Slightly different visual treatment for the per-group "all N…" escape. */
  readonly isMore: boolean;
}

interface PaletteGroupView {
  readonly key: string;
  readonly label: string;
  readonly options: readonly PaletteOption[];
}

/** Which section paths have a /new route, and what the action is called.
 *  Derived from the caller's OWN sidebar items (already permission-filtered),
 *  so a group the role cannot see contributes no actions either. */
const NEW_ACTION_LABELS: Readonly<Record<string, string>> = {
  contacts: "New contact",
  companies: "New company",
  artists: "New artist",
  venues: "New venue",
  agencies: "New agency",
  events: "New event",
  tasks: "New task",
  meetings: "New meeting",
  notes: "New note",
};

const LISTBOX_ID = "command-palette-listbox";
const INPUT_ID = "command-palette-input";

interface SearchState {
  readonly forQuery: string;
  readonly groups: readonly PaletteRecordGroup[];
  /**
   * false = fine; "error" = the read failed (try again in a moment);
   * "rate_limited" = the caller's search budget is spent (SECURITY.md § 5)
   * and the right advice is the OPPOSITE of "try again in a moment", which
   * is why the two refusals are not one flag.
   */
  readonly failed: false | "error" | "rate_limited";
  /** The window's remainder, for the rate-limited sentence. */
  readonly retryAfterSeconds: number | null;
}

export function CommandPalette({
  orgSlug,
  groups,
}: {
  orgSlug: string;
  groups: readonly SidebarNavGroup[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rawActiveIndex, setRawActiveIndex] = useState(0);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [searching, startSearch] = useTransition();
  const seqRef = useRef(0);
  const openerRef = useRef<HTMLElement | null>(null);

  const trimmed = query.trim();
  const recordSearchArmed = trimmed.length >= PALETTE_MIN_QUERY_LENGTH;

  // ---- Static catalogue: sections + actions, from the sidebar's groups ----
  const navGroups = useMemo<readonly PaletteGroupView[]>(() => {
    const sections: PaletteOption[] = groups.flatMap((group) =>
      group.items.map((item) => ({
        id: "",
        label: item.label,
        detail: item.sub,
        href: item.href,
        isMore: false,
      })),
    );
    const actions: PaletteOption[] = groups.flatMap((group) =>
      group.items.flatMap((item) => {
        const label = NEW_ACTION_LABELS[item.path];
        return label
          ? [{ id: "", label, detail: null, href: `${item.href}/new`, isMore: false }]
          : [];
      }),
    );
    return [
      { key: "sections", label: "Sections", options: sections },
      { key: "actions", label: "Actions", options: actions },
    ];
  }, [groups]);

  // ---- Debounced server search -------------------------------------------
  // No synchronous setState in the effect body (react-hooks/set-state-in-
  // effect): stale results are filtered out at render by `forQuery`, and the
  // sequence counter drops any in-flight response a newer keystroke has
  // outrun. 250ms of debounce keeps a fast typist from issuing a read per
  // keystroke; the action itself is the bounded, RLS-gated read.
  useEffect(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    const q = query.trim();
    if (!open || q.length < PALETTE_MIN_QUERY_LENGTH) return;
    const timer = window.setTimeout(() => {
      startSearch(async () => {
        const result = await searchPaletteAction(orgSlug, q);
        if (seqRef.current !== seq) return;
        if (result.outcome === "results") {
          setSearch({
            forQuery: q,
            groups: result.groups,
            failed: false,
            retryAfterSeconds: null,
          });
        } else if (result.outcome === "rate_limited") {
          setSearch({
            forQuery: q,
            groups: [],
            failed: "rate_limited",
            retryAfterSeconds: result.retryAfterSeconds,
          });
        } else {
          setSearch({
            forQuery: q,
            groups: [],
            failed: "error",
            retryAfterSeconds: null,
          });
        }
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, query, orgSlug]);

  // ---- The rendered option model -----------------------------------------
  const { groupViews, flatOptions } = useMemo(() => {
    const views: PaletteGroupView[] = [];

    if (trimmed === "") {
      views.push(...navGroups);
    } else {
      const needle = trimmed.toLowerCase();
      for (const group of navGroups) {
        const options = group.options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            (option.detail ?? "").toLowerCase().includes(needle),
        );
        if (options.length > 0) views.push({ ...group, options });
      }
      if (recordSearchArmed && search && search.forQuery === trimmed) {
        for (const group of search.groups) {
          const options: PaletteOption[] = group.hits.map((hit) => ({
            id: "",
            label: hit.label,
            detail: hit.detail,
            href: hit.href,
            isMore: false,
          }));
          if (group.total !== null && group.total > group.hits.length) {
            options.push({
              id: "",
              label: `All ${group.total} matching ${group.label.toLowerCase()}`,
              detail: null,
              href: group.moreHref,
              isMore: true,
            });
          }
          views.push({ key: `records-${group.key}`, label: group.label, options });
        }
      }
    }

    // Stable, index-derived option ids for aria-activedescendant.
    let index = 0;
    const flat: PaletteOption[] = [];
    const withIds = views.map((view) => ({
      ...view,
      options: view.options.map((option) => {
        const withId = { ...option, id: `command-palette-option-${index}` };
        index += 1;
        flat.push(withId);
        return withId;
      }),
    }));
    return { groupViews: withIds, flatOptions: flat };
  }, [trimmed, navGroups, recordSearchArmed, search]);

  // Clamp rather than store: the option list changes under the index on
  // every keystroke, and clamping at render never needs an effect.
  const activeIndex =
    flatOptions.length === 0
      ? -1
      : Math.min(rawActiveIndex, flatOptions.length - 1);
  const activeOption = activeIndex >= 0 ? flatOptions[activeIndex]! : null;

  // Keep the active option in view as arrows move it.
  useEffect(() => {
    if (!activeOption) return;
    document
      .getElementById(activeOption.id)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeOption]);

  const openPalette = (opener: HTMLElement | null) => {
    openerRef.current = opener;
    setQuery("");
    setSearch(null);
    setRawActiveIndex(0);
    setOpen(true);
  };

  const closePalette = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setSearch(null);
    if (restoreFocus) openerRef.current?.focus();
  };

  const activate = (option: PaletteOption) => {
    closePalette(false);
    router.push(option.href);
    // Focus lands where the skip link lands: the content that is about to
    // change. The layout's <main tabIndex={-1}> persists across the soft
    // navigation, so this is a real element, immediately.
    document.getElementById("main")?.focus();
  };

  // ---- Global hotkey + the header trigger's event -------------------------
  // Re-registered per open/close so the closure is never stale; a listener
  // swap is free. Plain Ctrl/Cmd+K only — Alt/Shift chords stay with the
  // browser. PALETTE_OPEN_EVENT arrives from palette-trigger.tsx in the
  // shell's header (see this file's mounting note); at dispatch time the
  // trigger button holds focus, so document.activeElement is the right
  // element to restore focus to on close in both paths.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "k" || event.key === "K")
      ) {
        event.preventDefault();
        if (open) {
          closePalette(true);
        } else {
          openPalette(document.activeElement as HTMLElement | null);
        }
      }
    };
    const onOpenEvent = () => {
      if (!open) openPalette(document.activeElement as HTMLElement | null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpenEvent);
    };
  }, [open]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (flatOptions.length > 0) {
          setRawActiveIndex((activeIndex + 1) % flatOptions.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (flatOptions.length > 0) {
          setRawActiveIndex(
            (activeIndex - 1 + flatOptions.length) % flatOptions.length,
          );
        }
        break;
      case "Home":
        if (flatOptions.length > 0) {
          event.preventDefault();
          setRawActiveIndex(0);
        }
        break;
      case "End":
        if (flatOptions.length > 0) {
          event.preventDefault();
          setRawActiveIndex(flatOptions.length - 1);
        }
        break;
      case "Enter":
        event.preventDefault();
        if (activeOption) activate(activeOption);
        break;
      case "Escape":
        event.preventDefault();
        closePalette(true);
        break;
      case "Tab":
        // The dialog's only tab stop is this input — see the header. Tab
        // must not walk into the inert page behind the scrim.
        event.preventDefault();
        break;
      default:
        break;
    }
  };

  const showingRecords =
    recordSearchArmed && search !== null && search.forQuery === trimmed;
  const searchPending = recordSearchArmed && (searching || !showingRecords);
  const searchFailed =
    showingRecords && search !== null && search.failed === "error";
  const searchRateLimited =
    showingRecords && search !== null && search.failed === "rate_limited";
  const nothingMatches =
    trimmed !== "" &&
    flatOptions.length === 0 &&
    !searchPending &&
    !searchFailed &&
    !searchRateLimited;

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-50">
          {/* Scrim: click closes, exactly like Escape. aria-hidden — it is
              the same dismissal the dialog's own Escape provides, and a
              scrim as a named button would be announced noise. */}
          <div
            aria-hidden="true"
            onClick={() => closePalette(true)}
            className="absolute inset-0 bg-scrim"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className={
              "relative mx-auto mt-[16vh] flex w-[min(38rem,calc(100vw-2rem))] " +
              "flex-col border border-rule-strong bg-surface"
            }
          >
            <label htmlFor={INPUT_ID} className="sr-only">
              Search sections, actions and records
            </label>
            {/* autoFocus: the dialog exists only because the user just asked
                for it; focusing its one control is the dialog contract. */}
            <input
              id={INPUT_ID}
              role="combobox"
              aria-expanded="true"
              aria-controls={LISTBOX_ID}
              aria-activedescendant={activeOption?.id}
              aria-autocomplete="list"
              autoFocus
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setRawActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Jump to a section, search records, start something new…"
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              maxLength={100}
              className={
                "h-11 w-full border-b border-rule bg-surface px-4 text-base " +
                "text-ink placeholder:text-ink-muted"
              }
            />

            {/* Poll-free announcement of what the list below holds. */}
            <div role="status" className="sr-only">
              {searchPending
                ? "Searching…"
                : `${flatOptions.length} result${flatOptions.length === 1 ? "" : "s"}`}
            </div>

            <div
              id={LISTBOX_ID}
              role="listbox"
              aria-label="Results"
              // overscroll-contain: reaching the end of the palette's own
              // scroll must not start scrolling the page behind the scrim
              // (web-interface-guidelines' modal scroll-chaining rule).
              className="max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain pb-2"
            >
              {groupViews.map((group) => (
                <div
                  key={group.key}
                  role="group"
                  aria-labelledby={`command-palette-group-${group.key}`}
                >
                  <div
                    id={`command-palette-group-${group.key}`}
                    className={
                      "px-4 pt-4 pb-1 text-xs font-semibold tracking-[0.04em] " +
                      "text-ink-muted uppercase"
                    }
                  >
                    {group.label}
                  </div>
                  {group.options.map((option) => {
                    const active = option.id === activeOption?.id;
                    return (
                      // Pointer affordance only — keyboard interaction lives
                      // on the combobox input per the ARIA pattern (the
                      // option is reached via aria-activedescendant, never
                      // DOM focus), so this needs no key handler of its own.
                      <div
                        key={option.id}
                        id={option.id}
                        role="option"
                        aria-selected={active}
                        onClick={() => activate(option)}
                        onMouseMove={() => {
                          const index = flatOptions.findIndex(
                            (candidate) => candidate.id === option.id,
                          );
                          if (index >= 0 && index !== activeIndex) {
                            setRawActiveIndex(index);
                          }
                        }}
                        className={
                          "flex h-11 cursor-pointer items-center gap-3 " +
                          "border-l-[3px] pr-4 pl-[13px] " +
                          (active
                            ? "border-accent bg-shell"
                            : "border-transparent")
                        }
                      >
                        <span
                          className={
                            "min-w-0 flex-1 truncate text-base " +
                            (option.isMore
                              ? "font-semibold text-primary"
                              : "text-ink")
                          }
                        >
                          {option.label}
                        </span>
                        {option.detail ? (
                          <span className="max-w-[45%] truncate text-xs text-ink-muted">
                            {option.detail}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}

              {searchPending ? (
                <p className="px-4 pt-4 pb-2 text-sm text-ink-muted">Searching…</p>
              ) : null}
              {searchFailed ? (
                <p className="px-4 pt-4 pb-2 text-sm text-ink-muted">
                  We couldn’t search records just now. Sections and actions
                  still work; try the search again in a moment.
                </p>
              ) : null}
              {searchRateLimited ? (
                // NOT the failure copy: "try again in a moment" invites the
                // very retry the limiter is refusing (SECURITY.md § 5).
                <p className="px-4 pt-4 pb-2 text-sm text-ink-muted">
                  You’ve reached the search limit for now — nothing is wrong.
                  Sections and actions still work; records can be searched
                  again in{" "}
                  <span className="tabular-nums">
                    {search?.retryAfterSeconds ?? 60}
                  </span>{" "}
                  seconds.
                </p>
              ) : null}
              {nothingMatches ? (
                <p className="px-4 pt-4 pb-2 text-sm text-ink-muted">
                  {recordSearchArmed
                    ? `Nothing matches “${trimmed}”. Try a shorter piece of the name — records are searched by name or title.`
                    : `Nothing matches “${trimmed}” yet. Keep typing — records are searched from ${PALETTE_MIN_QUERY_LENGTH} characters.`}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
