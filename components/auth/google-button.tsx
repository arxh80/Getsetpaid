import { signInWithGoogleAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

// Google sign-in.
//
// A FORM, NOT A LINK. signInWithOAuth() on the server returns a provider URL
// carrying per-request PKCE state; it has to be minted at click time and
// redirected to. An <a href> would need a URL baked in at render time, which
// would either be stale or would have to be generated for every visitor
// whether or not they use it.
//
// THE MARK. Google's brand guidelines require the official four-colour "G" on
// a light button; recolouring it to our palette is not permitted. Those four
// hexes are therefore third-party brand values, not design tokens -- they live
// named and quarantined in app/globals.css under "Third-party brand marks", so
// DESIGN.md's "no literal hex in a component" rule still holds here and the
// diff stays greppable. Nothing else in the app may reference them.
//
// aria-hidden on the SVG: the button's own text already says "Continue with
// Google", so announcing the logo as well would just repeat it.
export function GoogleButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogleAction}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button type="submit" variant="secondary" className="w-full">
        <GoogleMark />
        Continue with Google
      </Button>
    </form>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className="shrink-0"
    >
      <path
        fill="var(--brand-google-blue)"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="var(--brand-google-green)"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="var(--brand-google-yellow)"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="var(--brand-google-red)"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
