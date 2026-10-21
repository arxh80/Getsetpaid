---
title: Prevent Hydration Mismatch Without Flickering
impact: MEDIUM
impactDescription: avoids visual flicker and hydration errors
tags: rendering, ssr, hydration, localStorage, flicker
---

## Prevent Hydration Mismatch Without Flickering

When rendering content that depends on client-side storage (localStorage, cookies), avoid both SSR breakage and post-hydration flickering by injecting a synchronous script that updates the DOM before React hydrates.

**Incorrect (breaks SSR):**

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  // localStorage is not available on server - throws error
  const theme = localStorage.getItem('theme') || 'light'
  
  return (
    <div className={theme}>
      {children}
    </div>
  )
}
```

Server-side rendering will fail because `localStorage` is undefined.

**Incorrect (visual flickering):**

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState('light')
  
  useEffect(() => {
    // Runs after hydration - causes visible flash
    const stored = localStorage.getItem('theme')
    if (stored) {
      setTheme(stored)
    }
  }, [])
  
  return (
    <div className={theme}>
      {children}
    </div>
  )
}
```

Component first renders with default value (`light`), then updates after hydration, causing a visible flash of incorrect content.

**Correct (no flicker, no hydration mismatch):**

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  return (
    <>
      <div id="theme-wrapper">
        {children}
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              try {
                var theme = localStorage.getItem('theme') || 'light';
                var el = document.getElementById('theme-wrapper');
                if (el) el.className = theme;
              } catch (e) {}
            })();
          `,
        }}
      />
    </>
  )
}
```

> ⚠️ **Do not adopt this pattern in GetSetPaid as written.** Three project rules block it:
>
> 1. `CLAUDE.md` § Non-negotiable rules and `SECURITY.md` § 3 both say to avoid
>    `dangerouslySetInnerHTML`; where unavoidable it requires security review.
> 2. The CSP is nonce-based for `script-src`, so this inline `<script>` is blocked at
>    runtime unless it carries the request nonce.
> 3. `lib/security/headers.ts` uses "the app ships zero `dangerouslySetInnerHTML`
>    (grepped, still true)" as the *stated justification* for the one broad allowance
>    in the policy, `style-src 'unsafe-inline'`. Introducing this sink invalidates that
>    argument and the comment becomes false.
>
> If a no-flicker theme boot is ever needed, route it through a nonced `next/script`
> with `strategy="beforeInteractive"` and update the `headers.ts` rationale in the same
> change — never silently.
<!-- GSP-PATCH: project-policy warning added. Upstream rule is sound for a project
     without a strict CSP; it is not sound here. -->

The inline script executes synchronously before showing the element, ensuring the DOM already has the correct value. No flickering, no hydration mismatch.

This pattern is especially useful for theme toggles, user preferences, authentication states, and any client-only data that should render immediately without flashing default values.
