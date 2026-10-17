import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  PASSWORD,
  authUserByEmail,
  localStack,
  membershipsOfUser,
  setUpInviteWorld,
  tearDownInviteWorld,
  type InviteWorld,
} from "./support/fixtures";
import { totpCode } from "../support/totp";

// ===========================================================================
// G11: ACCOUNT PRE-HIJACKING THROUGH INVITES (Phase 10 Task 4)
// ===========================================================================
// docs/launch-gates.md grades this the only Critical gap. A squatter signs up
// as an address they do not own (bookings@victim.example) BEFORE its owner
// does; a workspace later invites that address; the invitation binds to the
// squatter's account; the squatter joins the tenant with the invited role.
// Two paths, both reproduced through these same forms before the fix:
//
//   PATH 1, confirmations OFF (the old local config). The squatter is
//     auto-confirmed, inviteUserByEmail answers 422 email_exists, and the
//     invite step reused the squatter's id. Closed by `enable_confirmations =
//     true` (tests/unit/security/auth-config.test.ts) -- every test below runs
//     with it on, which is why the squatter cannot sign in before confirming.
//
//   PATH 2, confirmations ON. inviteUserByEmail on an existing UNCONFIRMED
//     sign-up answers 200 with the SAME id and sends an invite, so the invite
//     step bound the squatter's account through its "created" branch. When the
//     real owner followed the invite link, GoTrue confirmed that account with
//     the squatter's password still on it, and the squatter signed in. Closed
//     in the invite step (lib/org/actions.ts): an existing account that has
//     not confirmed its email and was not created by an invite is refused
//     BEFORE inviteUserByEmail is called, so no invite email is ever sent.
//
// Everything is driven through the real pages: /signup, /login with a real
// TOTP challenge for the Owner, the members page's invite form, the emailed
// links read out of the local mail catcher (Mailpit, `[local_smtp]` in
// supabase/config.toml), and /invites. Postgres is read only to assert
// outcomes (which memberships exist), never to make the attack work.
// ===========================================================================

const REFUSAL =
  "That address has an account that has not confirmed its email yet. Ask them to confirm it, then invite again.";
const INVITE_SUBJECT = "You've been invited to a GetSetPaid workspace";
const BAD_SIGN_IN = "That email and password don't match. Check both and try again.";

const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ADDRESSES = {
  squatter: `squatter-${run}@example.test`,
  holder: `holder-${run}@example.test`,
  pending: `pending-${run}@example.test`,
  resignup: `resignup-${run}@example.test`,
};
const P1 = "Squatter-chose-this-1";
const P2 = "Owner-chose-this-2!";

let world: InviteWorld;

test.beforeAll(async () => {
  world = await setUpInviteWorld();
});

test.afterAll(async () => {
  await tearDownInviteWorld(world, Object.values(ADDRESSES));
});

// ---------------------------------------------------------------------------
// The mail catcher
// ---------------------------------------------------------------------------
interface Mail {
  id: string;
  subject: string;
}

function mailUrl(): string {
  const url = localStack().mailUrl;
  if (!url) throw new Error("`supabase status` reported no local mail catcher (MAILPIT_URL).");
  return url;
}

/** Every message addressed to `address`, newest first. */
async function mailTo(address: string): Promise<Mail[]> {
  const res = await fetch(
    `${mailUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  const body = (await res.json()) as { messages?: { ID: string; Subject: string }[] };
  return (body.messages ?? []).map((m) => ({ id: m.ID, subject: m.Subject }));
}

/** Waits (bounded) until `address` has received `count` messages matching `subject`. */
async function waitForMail(address: string, subject: RegExp, count = 1): Promise<Mail[]> {
  let matching: Mail[] = [];
  await expect
    .poll(
      async () => {
        matching = (await mailTo(address)).filter((m) => subject.test(m.subject));
        return matching.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(count);
  return matching;
}

/**
 * The invitation emails `address` holds once delivery has settled: polls for
 * up to five seconds for one to appear and returns what is there, possibly
 * nothing. NOT an assertion -- the victim acts on whatever arrived, and the
 * test asserts separately whether anything should have. Waiting matters in
 * the other direction: returning before a real invitation lands would let
 * the takeover test pass without the victim ever following it.
 */
async function invitationsSettled(address: string): Promise<Mail[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const invitations = (await mailTo(address)).filter((m) => m.subject === INVITE_SUBJECT);
    if (invitations.length > 0 || Date.now() > deadline) return invitations;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The first link in a message whose href contains `marker`, HTML entities decoded. */
async function linkIn(mail: Mail, marker: string): Promise<string> {
  const res = await fetch(`${mailUrl()}/api/v1/message/${mail.id}`);
  const { HTML } = (await res.json()) as { HTML: string };
  const href = [...HTML.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"))
    .find((h) => h.includes(marker));
  if (!href) throw new Error(`No link containing "${marker}" in "${mail.subject}".`);
  return href;
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------
async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

/** Sign up through the real form; with confirmations on it lands on check-email. */
async function signUp(page: Page, address: string, password: string): Promise<void> {
  await page.goto("/signup");
  await page.locator('input[name="fullName"]').fill("Someone");
  await page.locator('input[name="email"]').fill(address);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/signup\/check-email/);
}

async function submitSignIn(page: Page, address: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(address);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The sign-in is refused, with the one enumeration-safe message. */
async function expectSignInRefused(page: Page, address: string, password: string): Promise<void> {
  await submitSignIn(page, address, password);
  await expect(page.getByText(BAD_SIGN_IN)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
}

/** The Owner signs in with a password AND the real per-sign-in TOTP challenge. */
async function signInOwner(page: Page): Promise<void> {
  await submitSignIn(page, world.owner.email, PASSWORD);
  await expect(page).not.toHaveURL(/\/login/);
  const challenge = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(challenge).toBeVisible();
  await page.locator('input[name="code"]').fill(totpCode(world.ownerTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(challenge).toHaveCount(0);
}

/** Sends an invitation through the members page and returns what the form says. */
async function invite(owner: Page, orgSlug: string, address: string): Promise<string> {
  await owner.goto(`/${orgSlug}/members`);
  const form = owner.locator("form").filter({ has: owner.locator('input[name="orgSlug"]') });
  await form.locator('input[name="email"]').fill(address);
  await form.locator('select[name="role"]').selectOption("manager");
  await form.getByRole("button", { name: "Send invitation" }).click();
  const outcome = form.getByText(/Invitation sent to|already has a GetSetPaid account|has not confirmed|couldn't|already a member/);
  await expect(outcome).toBeVisible();
  // The alert leads with its tone's word ("Done." / "Error.", components/ui/
  // alert.tsx); the message is what follows it.
  return (await outcome.innerText()).replace(/^(Done|Error|Note)\.\s*/, "");
}

/** Accepts the pending invitation into `org` from /invites; lands in the workspace. */
async function acceptFromInvites(page: Page, org: { name: string; slug: string }): Promise<void> {
  await page.goto("/invites");
  // The organisation's name is hidden from an invitee until they accept (the
  // invites page says why), so every pending row is "A GetSetPaid workspace".
  await page.getByRole("button", { name: /Accept invitation to/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/(${org.slug})`));
}

// ===========================================================================
// PATH 2: THE CONFIRMATIONS-ON TAKEOVER
// ===========================================================================
test("a squatter's unconfirmed sign-up is never bound by an invite, and its password never signs in", async ({
  browser,
}) => {
  const address = ADDRESSES.squatter;
  const squatter = await newPage(browser);

  // The squatter registers the victim's address with a password of their own.
  await signUp(squatter, address, P1);
  // Confirmations are on: the account is unusable until the inbox proves it.
  await expectSignInRefused(squatter, address, P1);

  // A workspace invites that address.
  const owner = await newPage(browser);
  await signInOwner(owner);
  const inviterSaw = await invite(owner, world.orgs[0].slug, address);

  // The real owner of the address acts on whatever arrives in their inbox: any
  // invitation they were sent, they follow, and accept. Before the fix this is
  // the step that confirmed the squatter's account; after it there is nothing
  // to follow, which the assertions further down pin explicitly.
  const victim = await newPage(browser);
  for (const mail of await invitationsSettled(address)) {
    await victim.goto(await linkIn(mail, "type=invite"));
    await expect(victim).toHaveURL(/\/invites/);
    await acceptFromInvites(victim, world.orgs[0]);
  }

  // THE INVARIANT: the password the squatter chose never signs in.
  await expectSignInRefused(squatter, address, P1);

  // ...because the invite step refused to bind the unconfirmed sign-up,
  await expect(inviterSaw).toBe(REFUSAL);
  // created no membership for it,
  const account = await authUserByEmail(address);
  expect(account).toMatchObject({ emailConfirmed: false, invited: false });
  expect(await membershipsOfUser(account!.id)).toEqual([]);
  // and sent the address no invitation at all.
  expect((await mailTo(address)).map((m) => m.subject)).not.toContain(INVITE_SUBJECT);
});

// ===========================================================================
// THE REFUSAL, AND THE POSITIVE CONTROL: ONCE THE INBOX IS PROVED, IT BINDS
// ===========================================================================
test("an unconfirmed sign-up is refused an invite; once its owner confirms, a fresh invite binds and is accepted", async ({
  browser,
}) => {
  const address = ADDRESSES.holder;
  const holder = await newPage(browser);

  await signUp(holder, address, P2);
  await expectSignInRefused(holder, address, P2);

  const owner = await newPage(browser);
  await signInOwner(owner);
  expect(await invite(owner, world.orgs[1].slug, address)).toBe(REFUSAL);
  const before = await authUserByEmail(address);
  expect(await membershipsOfUser(before!.id)).toEqual([]);

  // The holder proves the inbox through the confirmation email.
  const [confirmation] = await waitForMail(address, /confirm/i);
  // Same browser that signed up, so the PKCE exchange at /auth/callback
  // completes and the link itself signs them in (with confirmations now on,
  // this is the sign-up journey every new user takes).
  await holder.goto(await linkIn(confirmation, "/auth/v1/verify"));
  await expect.poll(async () => (await authUserByEmail(address))?.emailConfirmed).toBe(true);
  await expect(holder).not.toHaveURL(/\/(login|signup)/);

  // Their own password now signs in, from anywhere...
  const elsewhere = await newPage(browser);
  await submitSignIn(elsewhere, address, P2);
  await expect(elsewhere).not.toHaveURL(/\/login/);

  // ...and a fresh invitation binds to the confirmed account and is accepted.
  expect(await invite(owner, world.orgs[1].slug, address)).toBe(
    `${address} already has a GetSetPaid account. We've sent them an invitation to this workspace.`,
  );
  await acceptFromInvites(holder, world.orgs[1]);
  expect(await membershipsOfUser(before!.id)).toEqual([
    { organisationId: world.orgs[1].id, role: "manager", status: "active" },
  ]);
});

// ===========================================================================
// THE LEGITIMATE RE-INVITE MUST STILL WORK
// ===========================================================================
// A pending invitee is ALSO an existing, unconfirmed account (the first
// invitation created it), and inviteUserByEmail answers 200 with the same id
// for it too. What tells it from a squatter is how it came to exist: an
// invitation created it (invited_at is set before this call) rather than a
// self-service sign-up. A refusal keyed on "unconfirmed" alone would break
// this: one person invited by two workspaces before accepting either.
test("a pending invitee can be invited by a second workspace and accept both", async ({ browser }) => {
  const address = ADDRESSES.pending;
  const owner = await newPage(browser);
  await signInOwner(owner);

  expect(await invite(owner, world.orgs[0].slug, address)).toBe(
    `Invitation sent to ${address}. They'll get an email with a link to join.`,
  );
  expect(await invite(owner, world.orgs[1].slug, address)).toBe(
    `Invitation sent to ${address}. They'll get an email with a link to join.`,
  );

  // The second invitation re-issued the token, so the newest email is the live one.
  const [newest] = await waitForMail(address, new RegExp(INVITE_SUBJECT), 2);
  const invitee = await newPage(browser);
  await invitee.goto(await linkIn(newest, "type=invite"));
  await expect(invitee).toHaveURL(/\/invites/);
  await expect(invitee.getByRole("button", { name: /Accept invitation to/ })).toHaveCount(2);

  await invitee.getByRole("button", { name: /Accept invitation to/ }).first().click();
  await expect(invitee).not.toHaveURL(/\/invites/);
  await invitee.goto("/invites");
  await invitee.getByRole("button", { name: /Accept invitation to/ }).click();
  await expect(invitee).not.toHaveURL(/\/invites/);

  const account = await authUserByEmail(address);
  const memberships = await membershipsOfUser(account!.id);
  expect(memberships.map((m) => m.status)).toEqual(["active", "active"]);
  expect(new Set(memberships.map((m) => m.organisationId))).toEqual(
    new Set(world.orgs.map((o) => o.id)),
  );
});

// ===========================================================================
// WHAT GoTrue DOES WITH AN UNCONFIRMED RE-SIGN-UP (a pinned residual)
// ===========================================================================
// Measured on GoTrue v2.196.0 (Phase 10 Task 4, Step 6) and pinned so an
// upgrade that changes it is noticed. Signing up AGAIN as an address that
// has not confirmed, with a different password, sends a SECOND confirmation
// email to the same inbox, voids the first link, and gives nobody without
// the inbox anything: neither password signs in. That is the safe half, and
// it is why a squatter cannot simply sign up over the real owner.
//
// The residual half is the last two assertions: the account keeps the FIRST
// registrant's password, and confirming does not change that. So if the
// real owner signs up over a squatter's earlier sign-up and confirms, the
// SQUATTER's password signs in to the now-confirmed account, and the owner's
// own does not. SECURITY.md § 10 records it with what closes it.
test("RESIDUAL: an unconfirmed re-sign-up mails the same inbox again, and confirming keeps the FIRST password", async ({
  browser,
}) => {
  const address = ADDRESSES.resignup;
  const first = await newPage(browser);
  await signUp(first, address, P1);
  await waitForMail(address, /confirm/i, 1);
  // [auth.email] max_frequency = "1s": a second confirmation for the same
  // account inside a second is refused with 429, which is not what is measured.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const second = await newPage(browser);
  await signUp(second, address, P2);
  const [newest, older] = await waitForMail(address, /confirm/i, 2);

  // Unconfirmed: neither password is any use to anybody.
  await expectSignInRefused(first, address, P1);
  await expectSignInRefused(second, address, P2);

  // The holder of the inbox confirms with the newest link; the older is dead.
  await second.goto(await linkIn(newest, "/auth/v1/verify"));
  await expect.poll(async () => (await authUserByEmail(address))?.emailConfirmed).toBe(true);
  const stale = await newPage(browser);
  await stale.goto(await linkIn(older, "/auth/v1/verify"));
  await expect(stale).toHaveURL(/\/login\?error=link_failed/);

  // THE RESIDUAL: the second registrant's password does not sign in...
  await expectSignInRefused(await newPage(browser), address, P2);
  // ...and the first registrant's does.
  const firstAgain = await newPage(browser);
  await submitSignIn(firstAgain, address, P1);
  await expect(firstAgain).not.toHaveURL(/\/login/);
});
