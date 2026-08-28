"use client";

import { useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { buildListHref, type ListParams } from "@/lib/list/params";
import type { ListSpec } from "@/lib/list/spec";

// The search and filter strip.
//
// THE ONLY CLIENT COMPONENT ON A LIST PAGE, and it is one for exactly one
// reason: it pushes a route. The table, the sort controls, the pager, the
// empty states and the error state are all Server Components rendering plain
// links, so a dense list ships no JavaScript to render itself
// (`vercel-react-best-practices`: the list is the thing you least want in a
// client bundle).
//
// ===========================================================================
// SEARCH IS A SUBMIT, NOT A LIVE FILTER. Decided, not defaulted.
// ===========================================================================
// The instinct is to filter as the user types. With URL-as-state (see
// lib/list/params.ts) that means one navigation and one round trip per
// keystroke, and -- worse -- one history entry per keystroke unless every one
// is a `replace`, in which case the back button skips the whole search. A
// debounce hides the first problem and not the second.
//
// Submit-to-search is also what a keyboard-first product wants: type, Enter,
// results, and the URL you end up on is the one you can send to a colleague.
//
// ===========================================================================
// IT WORKS WITHOUT JAVASCRIPT.
// ===========================================================================
// A real <form method="get">, so the browser can submit it unaided. The
// onSubmit handler intercepts only to keep the resulting URL tidy (defaults
// omitted) and to get a client-side navigation instead of a document load.
// The hidden inputs carry sort/direction/page-size through a no-JS submit, and
// are omitted when they equal the default so the no-JS URL stays clean too.
//
// THE CURSOR IS DELIBERATELY ABSENT from the form. A new search starts at
// page one; carrying a cursor from the old result set would page from a
// boundary row that need not even be in the new one. See buildListHref.
// ===========================================================================

interface ListToolbarProps<TSort extends string, TFilter extends string> {
  spec: ListSpec<TSort, TFilter>;
  params: ListParams<TSort, TFilter>;
  basePath: string;
  /** True when a search or filter is narrowing the list -- shows "Clear". */
  narrowed: boolean;
}

export function ListToolbar<TSort extends string, TFilter extends string>({
  spec,
  params,
  basePath,
  narrowed,
}: ListToolbarProps<TSort, TFilter>) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  // Keep the box in step with the URL WITHOUT making it a controlled input.
  //
  // The input is uncontrolled so that a re-render (a sort click, a page click)
  // never clobbers what the user is halfway through typing. But that alone
  // leaves a real defect: "Clear" empties the query string and the box still
  // shows the old term, so the list and the control that supposedly produced
  // it disagree on screen.
  //
  // Writing the value only when it DIFFERS is what makes this safe. On the
  // user's own submit the two already agree, so nothing is touched and focus
  // and selection stay where they were; on a Clear (or on landing from a
  // shared link) they differ and the box is corrected.
  useEffect(() => {
    const el = searchRef.current;
    if (el && el.value !== params.q) el.value = params.q;
  }, [params.q]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const filters: Partial<Record<TFilter, string>> = {};
    for (const key of Object.keys(spec.filters) as TFilter[]) {
      const value = data.get(key);
      if (typeof value === "string") filters[key] = value;
    }
    router.push(
      buildListHref(spec, basePath, params, {
        q: String(data.get("q") ?? "").trim(),
        filters,
      }),
    );
  }

  const filterKeys = Object.keys(spec.filters) as TFilter[];

  return (
    <form
      ref={formRef}
      action={basePath}
      method="get"
      onSubmit={submit}
      // Labels above controls, controls on one baseline. `items-end` rather
      // than the flex default of `stretch` so the 44px input, the 44px select
      // and the 44px button line up (hallmark gate 36) instead of the labelled
      // columns stretching to the tallest.
      className="flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-rule py-4"
    >
      {/* Sort and page size survive a search. Omitted at their defaults so a
          no-JS submit produces the same tidy URL the JS path builds. */}
      {params.sort !== spec.defaultSort ? (
        <input type="hidden" name="sort" value={params.sort} />
      ) : null}
      {params.dir !== spec.sort[params.sort].defaultDirection ? (
        <input type="hidden" name="dir" value={params.dir} />
      ) : null}

      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
        <label
          htmlFor={searchId}
          className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
        >
          {spec.searchLabel}
        </label>
        <input
          ref={searchRef}
          id={searchId}
          name="q"
          type="search"
          defaultValue={params.q}
          autoComplete="off"
          // A name is a name: capitalising the first letter and autocorrecting
          // a surname into an English word both produce searches that quietly
          // find nothing. Same reasoning as components/ui/field.tsx's email
          // defaults.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          maxLength={100}
          className={
            "h-11 w-full min-w-0 border border-rule bg-surface px-3 " +
            "text-base text-ink placeholder:text-ink-muted " +
            "transition-colors duration-[var(--dur-fast)] ease-brand " +
            "hover:border-ink focus:border-accent"
          }
        />
      </div>

      {filterKeys.map((key) => {
        const definition = spec.filters[key];
        return (
          <FilterSelect
            key={key}
            name={key}
            label={definition.label}
            value={params.filters[key]}
            choices={definition.choices}
            onPick={() => formRef.current?.requestSubmit()}
          />
        );
      })}

      <Button type="submit" variant="secondary">
        Search
      </Button>

      {/* Only when there is something to clear. A permanently visible reset
          control on an unfiltered list is a control that does nothing, which
          is worse than no control. */}
      {narrowed ? (
        <Link
          href={basePath}
          className="flex h-11 items-center text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Clear search and filters
        </Link>
      ) : null}
    </form>
  );
}

function FilterSelect({
  name,
  label,
  value,
  choices,
  onPick,
}: {
  name: string;
  label: string;
  value: string;
  choices: readonly { value: string; label: string }[];
  onPick: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
      >
        {label}
      </label>
      {/* A native <select>. The workspace switcher and the invite role picker
          already use one, and a custom listbox here would be a third widget
          to keep accessible for no gain -- the choice set is short, closed and
          not searchable. */}
      <select
        id={id}
        name={name}
        defaultValue={value}
        // Auto-submits with JavaScript, because a picker that needs a second
        // click to take effect is the classic filter-bar annoyance. Without
        // JavaScript the Search button carries the selection instead, so the
        // control still works -- it just needs the button.
        onChange={onPick}
        className={
          "h-11 min-w-32 border border-rule bg-surface px-3 " +
          "text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          "hover:border-ink focus:border-accent"
        }
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}
