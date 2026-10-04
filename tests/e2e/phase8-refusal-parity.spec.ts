// =============================================================================
// PHASE 8 TASK 8 -- REFUSAL PARITY ON EVERY PAGE PHASE 8 ADDED
// =============================================================================
// "Refused" is not the property. INDISTINGUISHABLE FROM ABSENT is: a refusal
// that looks different from a page or record that does not exist tells a
// prober what exists, which is the enumeration oracle `DESIGN.md` § Error
// pages and tenant-breakout.spec.ts's REFUSAL PARITY test exist to close.
// super-permissions.spec.ts asserts each /super refusal carries "Page not
// found" and none of the page's own chrome; that is necessary and it is not
// the oracle property, because it never compares the refusal with the
// document a page that DOES NOT EXIST produces. This file does, directly, for
// every Phase 8 surface that can refuse:
//
//   every /super page (all nine)        -- vs a /super URL that matches no
//                                          route, per principal, rendered
//                                          AND as raw HTML
//   /[orgSlug]/settings/export          -- workspace-slug refusal: a real
//                                          foreign slug vs a slug nobody has,
//                                          and the literal 404 on both
//   /account/exports/[jobId]/download   -- route handler: a DOWNLOADABLE job
//                                          that is not yours (its Owner gets
//                                          the 302) vs an id nobody has, and
//                                          the literal 404 on both
//   /account/*                          -- a signed-out caller is bounced the
//                                          same way for a real page and a
//                                          ghost one
//
// and it walks the two principals Phase 8 made meaningful: a person with no
// workspace, and a member of a SUSPENDED workspace, who must still reach the
// four /account pages (their statutory rights) while being refused /super.
//
// Compared as rendered innerText plus the document title AND, for /super,
// as the RAW HTML. tenant-breakout.spec.ts's argument that raw bytes need not
// be compared holds where a real record and a ghost go through the SAME
// route; here the route is the secret. Fix round 1 (review I2) measured it:
// with the [...unknown] catch-all alone, the text and title matched but the
// raw document did not -- each page's own loading.tsx skeleton is flushed
// before its notFound(), and the inline flight data names the matched
// segment -- so `curl` with any signed-in cookie listed the console's pages.
// lib/supabase/middleware.ts now rewrites every /super request from a caller
// who is not on the allowlist to one fixed path, and normaliseDocument()
// below strips only what differs between two requests for the SAME URL.
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  countExportDownloadAudit,
  deleteExportJobAndArchive,
  localStack,
  PASSWORD,
  plantReadyAccountExport,
  setOrganisationSuspended,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";
import { totpCode } from "../support/totp";
import { SUPER_PAGE_URLS } from "../support/super-route-census";

let world: E2eWorld;
let noWorkspace: { id: string; email: string };

test.beforeAll(async () => {
  world = await setUpWorld();
  const { apiUrl, serviceRoleKey } = localStack();
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `t8-no-workspace-${Date.now()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`no-workspace principal: ${error?.message}`);
  noWorkspace = { id: data.user.id, email };
});

test.afterAll(async () => {
  const { apiUrl, serviceRoleKey } = localStack();
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (noWorkspace) await admin.auth.admin.deleteUser(noWorkspace.id).catch(() => undefined);
  await tearDownWorld(world);
});

/** A /super URL that matches no route at all -- the baseline a refusal must equal. */
const SUPER_GHOST = "/super/zzz-phase8-no-such-page";
/** The Phase 8 /super surfaces, including the editor's query-string view. */
const PHASE8_SUPER = ["/super/legal", "/super/legal?doc=terms", "/super/data-requests"];
/** EVERY /super page (review M4: the catch-all and the rewrite cover all nine,
 *  so the parity proof does too), from the census super-permissions.spec.ts
 *  and a CI unit test hold to the app tree, plus the editor's query view. */
const ALL_SUPER = [...SUPER_PAGE_URLS, "/super/legal?doc=terms"];
/** A slug nothing can own: reserved-grammar-valid, never created. */
const GHOST_SLUG = "zzz-phase8-ghost-workspace";
const GHOST_ID = "00000000-0000-4000-8000-0000000000f8";

async function signInByEmail(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function signInAsSuperuser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const heading = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(heading).toBeVisible();
  await page.locator('input[name="code"]').fill(totpCode(world.superuserTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

/** One document, reduced to what a prober can compare. */
async function documentOf(page: Page, url: string) {
  const response = await page.goto(url);
  await expect(page.locator("body")).toContainText("Page not found");
  return {
    status: response?.status() ?? -1,
    text: await page.locator("body").innerText(),
    title: await page.title(),
    url: page.url(),
  };
}

/**
 * A raw HTML document reduced to what is the same between two requests for
 * ONE URL, and nothing more. MEASURED (fix round 1): two fetches of the same
 * ghost differ in exactly these, and in nothing else --
 *   - the per-request CSP nonce, and Next's per-request `__next_r` id;
 *   - the canonical-URL echo `"c":[...]` of the requested path, which is the
 *     caller's own input and says nothing about what exists;
 *   - the dev server's React debug-info rows (`<id>:D"$<id>"`), whose number
 *     varies from one request to the next, and the flight row ids that shift
 *     with them, renumbered here by first appearance.
 * The superuser control in the POSITIVE CONTROL test proves this does not
 * erase the difference between two real pages.
 *
 * NOT normalised, and not a difference: the dev server's stack trace in the
 * document. The streamed notFound() under loading.tsx makes React emit
 * `<template data-dgst="NEXT_HTTP_ERROR_FALLBACK;404" data-msg data-stck
 * data-cstck>` ("switched to client rendering"); the three message/stack
 * attributes are development-only (a production build emits `data-dgst`
 * alone) and are byte-identical across refused URLs, because every one is
 * rewritten onto the same route. The fix round 2 red only LOOKED like it was
 * in that stack: the rest of the document follows it on one physical line.
 */
function normaliseDocument(html: string): string {
  let s = html;
  const nonce = /nonce="([^"]+)"/.exec(s)?.[1];
  if (nonce) s = s.split(nonce).join("<nonce>");
  s = s.replace(/__next_r="[^"]*"/g, '__next_r=""');
  s = s.replace(/\\"c\\":\[[^\]]*\]/g, '\\"c\\":<requested>');
  // Flight row ids are lowercase hex, and only flight syntax is renumbered
  // (review N3: the earlier pattern also rewrote ordinary text, e.g. the `d`
  // of `userId":` after an upper-case letter). A row id is the hex run at a
  // ROW START -- after an unescaped `\n` separator, after the `[1,"` that
  // opens a push, or straight after a text row's last byte, because a
  // `<id>:T<hexlen>,` row is length-prefixed and the next row follows it with
  // no separator; flightRowStarts() walks that length exactly. A reference is
  // a whole escaped string `\"$<id>\"` / `\"$<id>:path`, optionally typed
  // `\"$<p><id>` where <p> is `@` or a NON-hex letter.
  //
  // FIX ROUND 2 (the red in the full gate, owner, /super/legal?doc=terms):
  // the old `\$[A-Za-z]?` greedily took the first digit of a PLAIN reference
  // as a type prefix, so `"$f3"` (id f3) normalised as `$f` + id `3` while
  // `"$e9"` stayed whole. The dev server's debug rows shift every id from one
  // request to the next, so whether an id happened to start with a-f decided
  // whether two identical documents normalised alike. MEASURED: the two
  // documents differed only at `"$@113"` vs `"$f@108"` and the like -- the
  // dev-only owner/debug-stack slots of React elements -- with the same
  // structure on both sides. React's type prefixes (`$L`, `$@`, `$h`, `$Q`,
  // `$W`, ...) are never a-f, so a-f straight after `$` is always the id.
  const edits: { at: number; end: number; id?: string }[] = [];
  for (const at of flightRowStarts(s)) {
    const debugRow = /^[0-9a-f]+:D\\"\$[0-9a-f]+\\"/.exec(s.slice(at, at + 64));
    if (debugRow) {
      // The dev server's `<id>:D"$<id>"` debug rows, with their separator.
      edits.push({ at: s.startsWith("\\n", at - 2) ? at - 2 : at, end: at + debugRow[0].length });
      continue;
    }
    const row = /^[0-9a-f]+(?=:)/.exec(s.slice(at, at + 16));
    if (row) edits.push({ at, end: at + row[0].length, id: row[0] });
  }
  for (const m of s.matchAll(/(\\+"\$[@g-zA-Z]?)([0-9a-f]+)(?=\\+"|:)/g)) {
    const at = m.index + m[1].length;
    edits.push({ at, end: at + m[2].length, id: m[2] });
  }
  edits.sort((a, b) => a.at - b.at);
  const ids = new Map<string, number>();
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    if (e.at < cursor) continue; // a reference inside a debug row already dropped
    out += s.slice(cursor, e.at);
    if (e.id !== undefined) {
      if (!ids.has(e.id)) ids.set(e.id, ids.size);
      out += `@${ids.get(e.id)}`;
    }
    cursor = e.end;
  }
  return out + s.slice(cursor);
}

/** Where a flight row may start in the raw HTML (the flight is JS-string
 *  escaped inside `self.__next_f.push([1,"..."])`): after an unescaped `\n`,
 *  after `[1,"`, and at the end of each `<id>:T<hexlen>,<bytes>` text row,
 *  found by decoding the escapes and counting UTF-8 bytes. A text row that
 *  runs into the end of its push is skipped -- its successor is then not
 *  renumbered, which can only make two documents differ, never match. */
function flightRowStarts(s: string): number[] {
  const starts: number[] = [];
  const textRows: [number, number][] = [];
  for (const m of s.matchAll(/[0-9a-f]+:T([0-9a-f]+),/g)) {
    const from = m.index + m[0].length;
    let i = from;
    let bytes = 0;
    const want = parseInt(m[1], 16);
    while (bytes < want && i < s.length && s[i] !== '"') {
      let unit: number;
      if (s[i] === "\\") {
        unit = s[i + 1] === "u" ? parseInt(s.slice(i + 2, i + 6), 16) : 0x20; // \n, \" etc: one byte
        i += s[i + 1] === "u" ? 6 : 2;
      } else {
        unit = s.charCodeAt(i);
        i += 1;
      }
      // UTF-16 code unit -> UTF-8 bytes; a surrogate pair is 2 + 2 = 4.
      bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit < 0xe000) ? 2 : 3;
    }
    if (bytes === want) {
      starts.push(i);
      textRows.push([from, i]);
    }
  }
  // A separator inside a text row's own bytes is content, not a row start.
  for (const m of s.matchAll(/(?<!\\)\\n|\[1,"/g)) {
    const at = m.index + m[0].length;
    if (!textRows.some(([a, b]) => at > a && at <= b)) starts.push(at);
  }
  return starts;
}

/** The raw document a `curl` with this session's cookies would receive. */
async function rawDocumentOf(page: Page, url: string): Promise<{ status: number; html: string }> {
  const response = await page.request.get(url, { maxRedirects: 0 });
  return { status: response.status(), html: normaliseDocument(await response.text()) };
}

/** The oracle property, for a page refusal: the refused surface and the ghost
 *  are the same document, and neither is a 403 or a bounce to /login. */
async function expectParity(page: Page, who: string, real: string, ghost: string) {
  const a = await documentOf(page, real);
  const b = await documentOf(page, ghost);
  expect([200, 404], `${who} ${real}: never 403, never a redirect; got ${a.status}`).toContain(a.status);
  expect(a.url, `${who} ${real} bounced to /login`).not.toMatch(/\/login/);
  // SOFT, so one run reports every channel that differs rather than the first.
  expect.soft(a.status, `${who}: ${real} and ${ghost} must share one status`).toBe(b.status);
  expect.soft(a.text, `${who}: ${real} and ${ghost} must render the identical document`).toBe(b.text);
  expect.soft(a.title, `${who}: ${real} and ${ghost} must carry the same title`).toBe(b.title);
}

test("POSITIVE CONTROL: the aal2 superuser reaches each Phase 8 /super page, and the ghost is not-found for them too", async ({
  page,
}) => {
  // Without this, "the refusal equals the ghost" could be two not-found
  // documents for a URL that is broken for everybody.
  await signInAsSuperuser(page);
  for (const url of PHASE8_SUPER) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(200);
    await expect(page.locator("body"), url).not.toContainText("Page not found");
  }
  await documentOf(page, SUPER_GHOST);
  // THE NORMALISER CAN TELL TWO PAGES APART. Without this, "every refused page
  // equals the ghost, raw" could be a normaliser that erases everything.
  const real = await rawDocumentOf(page, "/super/legal");
  const ghost = await rawDocumentOf(page, SUPER_GHOST);
  expect(real.html.length, "the raw superuser page is empty").toBeGreaterThan(1000);
  expect(real.html, "normaliseDocument() erased the difference between a real page and a ghost").not.toBe(
    ghost.html,
  );
  // ...and it is stable: the same ghost twice is the same document.
  expect((await rawDocumentOf(page, SUPER_GHOST)).html, "two fetches of one URL normalise differently").toBe(
    ghost.html,
  );
});

for (const who of ["read_only", "owner", "no-workspace", "suspended manager"] as const) {
  test(`REFUSAL PARITY: ${who} -- every /super page equals a /super page that does not exist, rendered and raw`, async ({
    page,
  }) => {
    if (who === "no-workspace") await signInByEmail(page, noWorkspace.email);
    else if (who === "suspended manager") {
      await setOrganisationSuspended(world.orgId, true);
      await signIn(page, world, "manager");
    } else await signIn(page, world, who);
    try {
      for (const url of ALL_SUPER) await expectParity(page, who, url, SUPER_GHOST);
      // THE RAW DOCUMENT (review I2): what `curl` sees, not what a browser
      // renders. The ghost is fetched beside each page, not once, so a dev
      // server warming up between the two cannot be mistaken for the oracle.
      for (const url of ALL_SUPER) {
        const ghost = await rawDocumentOf(page, SUPER_GHOST);
        const real = await rawDocumentOf(page, url);
        expect.soft(real.status, `${who}: ${url} raw status`).toBe(ghost.status);
        expect.soft(real.html, `${who}: ${url} and ${SUPER_GHOST} must be the same raw HTML`).toBe(ghost.html);
      }
    } finally {
      if (who === "suspended manager") await setOrganisationSuspended(world.orgId, false);
    }
  });
}

test("REFUSAL PARITY: /[orgSlug]/settings/export -- a real foreign workspace equals one nobody has, as a literal 404", async ({
  page,
}) => {
  // A workspace-slug refusal happens in the layout, above every loading
  // boundary, so the literal 404 is still assertable and is asserted.
  await signIn(page, world, "manager");
  const foreign = await documentOf(page, `/${world.otherOrgSlug}/settings/export`);
  const ghost = await documentOf(page, `/${GHOST_SLUG}/settings/export`);
  expect(foreign.status).toBe(404);
  expect(ghost.status).toBe(404);
  expect(foreign.text).toBe(ghost.text);
  expect(foreign.title).toBe(ghost.title);
  // POSITIVE CONTROL: the same person reaches the page in their OWN workspace
  // (as a Manager they read the page and are offered no control), so the
  // refusal above is the tenant boundary and not a broken route.
  const own = await page.goto(`/${world.orgSlug}/settings/export`);
  expect(own?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
});

test("REFUSAL PARITY: the export download route -- somebody else's DOWNLOADABLE job equals an id nobody has", async ({
  page,
}) => {
  // A READY archive (a real object and a succeeded, unexpired row), not a
  // queued one: the download path 404s a row with no storage_key for EVERY
  // caller, its own requester included, so a parity proof against one would
  // be row state, green with the IDOR guard deleted (review I1).
  const jobId = await plantReadyAccountExport(world.users.owner.id);
  try {
    // POSITIVE CONTROL: the job's own requester is served it. Without this,
    // "real == ghost" cannot tell "refused" from "nothing to serve".
    await signIn(page, world, "owner");
    const own = await page.request.get(`/account/exports/${jobId}/download`, { maxRedirects: 0 });
    expect([302, 303, 307], `the Owner's own ready archive: got ${own.status()}`).toContain(own.status());
    expect(own.headers()["location"] ?? "", "the Owner was not sent to a signed URL").toMatch(
      /\/storage\/v1\/object\/sign\/exports\//,
    );
    expect(await countExportDownloadAudit(jobId), "the positive control's download was not audited").toBe(1);
    await signOut(page);

    const probe = async (who: string) => {
      const real = await page.request.get(`/account/exports/${jobId}/download`, { maxRedirects: 0 });
      const ghost = await page.request.get(`/account/exports/${GHOST_ID}/download`, { maxRedirects: 0 });
      expect(real.status(), `${who}: a colleague's real export`).toBe(ghost.status());
      // Each id is replaced by one placeholder before comparing: a redirect
      // to /login echoes the REQUESTED path back (the caller's own input,
      // which says nothing about whether the job exists). Anything else that
      // differs is the oracle.
      const norm = (body: string) => body.split(jobId).join("<id>").split(GHOST_ID).join("<id>");
      expect(norm(await real.text()), `${who}: the two refusals must be the same body`).toBe(
        norm(await ghost.text()),
      );
      expect(
        (real.headers()["location"] ?? "").split(jobId).join("<id>"),
        `${who}: the same redirect, or none`,
      ).toBe((ghost.headers()["location"] ?? "").split(GHOST_ID).join("<id>"));
      return real.status();
    };
    // Signed out: bounced, identically, before anything reads the register.
    const anonStatus = await probe("anonymous");
    expect([302, 303, 307, 308, 404], `anonymous got ${anonStatus}`).toContain(anonStatus);
    for (const role of ["read_only", "admin"] as const) {
      await signIn(page, world, role);
      expect(await probe(role), `${role}: a route handler refuses with the literal 404`).toBe(404);
      await signOut(page);
    }
    await signInByEmail(page, noWorkspace.email);
    expect(await probe("no-workspace"), "no-workspace: the literal 404").toBe(404);
    // The refusals wrote nothing: still exactly the positive control's row.
    expect(await countExportDownloadAudit(jobId), "a refused download wrote an audit row").toBe(1);
  } finally {
    await deleteExportJobAndArchive(jobId);
  }
});

test("REFUSAL PARITY: signed out, each /account page is bounced exactly like an /account page that does not exist", async ({
  page,
}) => {
  const ghost = await page.request.get("/account/zzz-phase8-ghost", { maxRedirects: 0 });
  for (const path of ["privacy", "data-requests", "exports", "erase"]) {
    const real = await page.request.get(`/account/${path}`, { maxRedirects: 0 });
    expect(real.status(), `/account/${path}`).toBe(ghost.status());
    const loc = (r: typeof real) => new URL(r.headers()["location"] ?? "http://x/", "http://x").pathname;
    expect(loc(real), `/account/${path} bounced somewhere other than the ghost did`).toBe(loc(ghost));
  }
  expect([302, 303, 307, 308], "the ghost is a bounce, so the comparison is between two bounces").toContain(
    ghost.status(),
  );
});

test("a SUSPENDED workspace's members keep every /account page, and its Owner keeps the workspace export", async ({
  page,
}) => {
  // Suspension is read-only for the WORKSPACE. A statutory right is not a
  // write to the workspace, and export_organisation_data is one of the three
  // keys with survives_suspension = true. Both are promises the product makes;
  // this is the first browser that has been pointed at either while a
  // workspace was actually suspended.
  await setOrganisationSuspended(world.orgId, true);
  try {
    await signIn(page, world, "manager");
    for (const [path, heading] of [
      ["privacy", "Privacy and communications"],
      ["data-requests", "Your data protection requests"],
      ["exports", "A copy of your data"],
      ["erase", "Delete your account"],
    ] as const) {
      const response = await page.goto(`/account/${path}`);
      expect(response?.status(), `/account/${path} for a suspended workspace's member`).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
    await signOut(page);
    await signIn(page, world, "owner");
    const response = await page.goto(`/${world.orgSlug}/settings/export`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export this workspace" }),
      "the one key that survives suspension must still offer its control",
    ).toBeVisible();
  } finally {
    await setOrganisationSuspended(world.orgId, false);
  }
});
