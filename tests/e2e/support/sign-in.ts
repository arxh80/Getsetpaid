import { expect, type Page } from "@playwright/test";
import { PASSWORD, type E2eRole, type E2eWorld } from "./fixtures";
import { totpCode } from "../../support/totp";

/**
 * The roles whose sign-in must additionally present a TOTP code.
 *
 * A STATIC FACT ABOUT THE ROLE, NOT A LOOK AT THE PAGE. Constraint 15 forbids
 * `if (await locator.count())` because it degrades an assertion to a no-op the
 * day the thing disappears; branching on the role this suite deliberately
 * created as `finance` is the opposite -- the challenge screen is ASSERTED
 * present for that role and asserted GONE afterwards, so a gate that stopped
 * appearing is a failure here rather than a silent skip.
 *
 * Mirrors `private.role_requires_mfa()` (20260827210000) and MFA_REQUIRED_ROLES
 * in lib/auth/mfa-gate.ts.
 *
 * ===========================================================================
 * PHASE 7 TASK 7 CORRECTED THIS COMMENT AND THIS SET
 * ===========================================================================
 * It used to be `new Set(["finance"])` and read: "narrowed to the roles this
 * suite signs in as: owner and admin are the other two and nothing here is
 * either." That was an accurate description of a fixture gap, and the gap is
 * what made the plan's named Task 7 case ("unreachable by a non-superuser,
 * even an Org Owner") unwritable and left every Owner/Admin-only surface --
 * the three permissions held by exactly {owner, admin}: manage_custom_fields,
 * manage_members, manage_organisation -- never once rendered by a session
 * that holds the key.
 *
 * Both roles now sign in here, and both are in this set, which is the load-
 * bearing half: `public.has_permission()` returns false for an owner or admin
 * membership whose session is aal1 (20260827210000), so an owner persona that
 * skipped the challenge would hold NEITHER exclusive key and would be refused
 * everywhere for the MFA reason rather than the reason under test. Adding the
 * role to `E2eRole` without adding it here produces a fixture that looks like
 * an Owner and proves nothing about one.
 *
 * manager, standard_user, read_only and booker are MFA-OPTIONAL at MVP and
 * stay at aal1, which is what keeps the finance/owner/admin gates honest about
 * being role-scoped rather than a blanket "aal2 to do anything".
 */
const MFA_REQUIRED_ROLES: ReadonlySet<E2eRole> = new Set<E2eRole>([
  "finance",
  "owner",
  "admin",
]);

/**
 * The world field carrying each MFA-required role's enrolled base32 secret.
 *
 * NOT A SINGLE `world.financeTotpSecret` READ. This helper used to hardcode
 * that one field, which was correct while `finance` was the only challenged
 * role and becomes a silent wrong-code failure the moment it is not: an owner
 * presented with the finance user's code re-renders the challenge with
 * "Invalid code", and the test fails as a product bug rather than as "the
 * fixture does not carry this role's secret". Keyed by role, exhaustively
 * typed against MFA_REQUIRED_ROLES' members, so a future MFA-required role
 * added to `E2eRole` without a secret is a TYPE error here.
 */
const TOTP_SECRET_BY_ROLE: Readonly<
  Record<"finance" | "owner" | "admin", (world: E2eWorld) => string>
> = {
  finance: (world) => world.financeTotpSecret,
  owner: (world) => world.ownerTotpSecret,
  admin: (world) => world.adminTotpSecret,
};

const CHALLENGE_HEADING = "Enter your two-factor code";

/**
 * Sign in through the real form, at `/login`, with a real password.
 *
 * NOT a cookie injected into the context. The session cookie is written by
 * `@supabase/ssr` through the app's own route, and a hand-made one would test
 * a session shape the product never produces -- which is the same mistake the
 * psql suite's hand-made JWT claims made before they were given a real `aal`
 * claim (`run-rls-tests.sh`, "ASSURANCE LEVEL PER FIXTURE USER").
 *
 * ===========================================================================
 * PHASE 5 TASK 5 CHANGED THE SECOND HALF OF THIS DOC COMMENT
 * ===========================================================================
 * It used to read: "Only roles for which MFA is OPTIONAL are signed in here.
 * Manager, standard_user and read_only are all such roles at MVP; owner, admin
 * and finance are challenged for a TOTP code at every sign-in
 * (`SECURITY.md` § 4), which is asserted in the integration suite and is not
 * what a golden-path walk is measuring."
 *
 * That stopped being true the moment finance became a browser role. The finance
 * panel is gated on `view_finance`/`manage_finance`, and 20260827210000 puts
 * the aal2 requirement INSIDE `public.has_permission()` -- so a Finance user
 * signed in with a password alone holds NEITHER key, sees no panel, and would
 * satisfy the Booker-shaped "no finance panel" assertion for entirely the wrong
 * reason. The challenge is therefore part of the walk now: this helper presents
 * a real RFC 6238 code, generated from the factor `setUpWorld` enrolled, to the
 * live GoTrue verifier on the app's own gate screen.
 *
 * manager, standard_user, read_only and booker are still MFA-optional roles and
 * still sign in at aal1 -- which is what keeps "the finance gate is role-scoped,
 * not a blanket aal2 wall" a thing this suite can tell apart.
 *
 * PHASE 7 TASK 7 added `owner` and `admin` to the challenged set for exactly
 * the reason the paragraph above gives for finance: both roles' exclusive
 * permissions are aal2-gated inside has_permission(), so a password-only
 * owner session holds none of them and would satisfy an "Owner is refused"
 * assertion for entirely the wrong reason. See MFA_REQUIRED_ROLES.
 */
export async function signIn(
  page: Page,
  world: E2eWorld,
  role: E2eRole,
): Promise<void> {
  await page.goto("/login");
  // ADDRESSED BY `name`, NOT BY LABEL. Every field on this form renders its
  // label as "<Label> Required", and the password field is additionally
  // accompanied by a "Show password" toggle -- so `getByLabel("Password")`
  // matches nothing exactly and two things loosely. The form control's `name`
  // is what the Server Action reads (`components/auth/login-form.tsx:32,46`),
  // so it is the most stable handle and the one closest to what is submitted.
  await page.locator('input[name="email"]').fill(world.users[role].email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The app lands on whichever workspace it resolves; the assertion that
  // matters is only that the sign-in got past the form.
  await expect(page).not.toHaveURL(/\/login/);

  if (MFA_REQUIRED_ROLES.has(role)) {
    await presentTotpCode(page, world, role as keyof typeof TOTP_SECRET_BY_ROLE);
  }
}

/**
 * Walk the app's per-sign-in MFA challenge (components/auth/mfa-challenge-gate.tsx).
 *
 * THE GATE IS ASSERTED PRESENT FIRST, and that assertion is the interesting
 * half: `signInWithPassword()` returns an aal1 session and Supabase does NOT
 * re-prompt on its own (lib/auth/mfa-gate.ts's fix-round-1 note), so this
 * screen appearing is the product's own gate doing the work. If it ever stopped
 * appearing, this goes red here rather than leaving a Finance user quietly
 * browsing at aal1 with no finance keys.
 *
 * The code is generated from the secret `setUpWorld` enrolled and verified
 * against the LIVE verifier -- no stub, no injected `aal` claim.
 */
async function presentTotpCode(
  page: Page,
  world: E2eWorld,
  role: keyof typeof TOTP_SECRET_BY_ROLE,
): Promise<void> {
  const heading = page.getByRole("heading", { name: CHALLENGE_HEADING });
  await expect(heading).toBeVisible();
  await page
    .locator('input[name="code"]')
    .fill(totpCode(TOTP_SECRET_BY_ROLE[role](world)));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  // The gate is gone: the action verified, upgraded the session in place and
  // redirected to `next`. A wrong code re-renders the same screen with an
  // error, so this is a real assertion and not a formality.
  await expect(heading).toHaveCount(0);
}

/** Sign out, so the next test's sign-in starts from nothing. */
export async function signOut(page: Page): Promise<void> {
  // NO CONDITIONAL LOCATOR (Task 8 fix round 1). This used to be
  // `if (await button.count())`, which silently did nothing when the button was
  // absent -- the exact shape the "no conditional locators" rule forbids. Every
  // caller invokes it from a signed-in page, so the button is asserted present
  // and then clicked; a missing "Sign out" is now a failure, not a skip.
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
}
