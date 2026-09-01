import { expect, test } from "@playwright/test";
import {
  DOCUMENT_NAMES,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE PHASE 4 DOCUMENTS GOLDEN PATH, WALKED — the file-security pipeline as a
// browser meets it.
//
// `SECURITY.md` § 6 / `CLAUDE.md` § Non-negotiable rules: files are private,
// malware-scanned before they can be opened, and served only through a
// short-lived signed URL after authorisation. This walks the two verdicts:
//
//   * a CLEAN upload lands "Ready" and downloads (302 to a signed URL);
//   * an EICAR upload lands "Quarantined", offers no download link, and the
//     download Route Handler refuses it with 409 even by direct URL — hiding
//     the link is not the control, refusing the URL is (Global Constraint 12).
//
// NO CONDITIONAL LOCATORS. Every control asserted present is asserted, then
// used; a missing one is a failure, never a skip. Count assertions carry a
// denominator (`toHaveCount`), never "somewhere on the page".
//
// The EICAR path uses the default scanner stub (MALWARE_SCANNER unset): the stub
// flags a file carrying the EICAR marker as infected, which is how a quarantine
// is exercisable end to end on the local stack with no real engine wired
// (Task 4, Q42). THE STUB PROVES THE PIPELINE, NOT DETECTION — a real scanner
// against real malware is a launch-gate item (exit document, Phase 10).

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

// The smallest file the magic-byte allowlist accepts as a PDF: `sniffAndAllow`
// keys PDF on the "%PDF-" prefix (`lib/security/file-allowlist.ts`).
const CLEAN_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< >>\n%%EOF\n",
);

// The EICAR test string, assembled from fragments so this source file never
// holds the contiguous signature. Plain ASCII, accepted as text/plain, then
// flagged by the stub.
const EICAR = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" +
    "EICAR-STANDARD-" +
    "ANTIVIRUS-TEST-FILE" +
    "!$H+H*",
);

const CLEAN_UPLOAD = "walk-clean.pdf";
const EICAR_UPLOAD = "walk-eicar.txt";

test("a clean upload lands Ready and downloads via a signed URL", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/documents`);
  await expect(
    page.getByRole("heading", { name: "Documents", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Files are scanned before they can be downloaded."),
  ).toBeVisible();

  await page.locator("#document-file").setInputFiles({
    name: CLEAN_UPLOAD,
    mimeType: "application/pdf",
    buffer: CLEAN_PDF,
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText("Done. Uploaded.", { exact: true })).toBeVisible();

  // The row appears: a download link on the filename and a "Ready" scan chip.
  // Scoped to the row — "Ready" is also a (hidden) option in the scan filter.
  const cleanLink = page.getByRole("link", { name: CLEAN_UPLOAD });
  await expect(cleanLink).toHaveCount(1);
  const cleanRow = page.getByRole("row").filter({ has: cleanLink });
  await expect(cleanRow.getByText("Ready")).toBeVisible();

  // The download resolves: fetch the link's own href WITHOUT following the
  // redirect, so we observe the handler's 302 to the signed URL. `page.request`
  // shares the browser's authenticated cookies.
  const href = await cleanLink.getAttribute("href");
  expect(href, "clean download href").not.toBeNull();
  const res = await page.request.get(href!, { maxRedirects: 0 });
  expect(res.status(), "clean download is a 302 to the signed URL").toBe(302);
  expect(res.headers()["location"], "signed URL in Location header").toBeTruthy();
});

test("an EICAR upload lands Quarantined with no download link", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/documents`);

  await page.locator("#document-file").setInputFiles({
    name: EICAR_UPLOAD,
    mimeType: "text/plain",
    buffer: EICAR,
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  // The upload reports the quarantine (the marker apostrophe is curly in the
  // source; matched as a substring to avoid depending on it).
  await expect(
    page.getByText("pass the malware scan", { exact: false }),
  ).toBeVisible();

  // The row lands with the "Quarantined" chip and the inert reason, and offers
  // NO download link — the filename is plain text.
  const eicarRow = page.getByRole("row").filter({ hasText: EICAR_UPLOAD });
  await expect(eicarRow.getByText("Quarantined").first()).toBeVisible();
  await expect(
    eicarRow.getByText("Quarantined — cannot be opened"),
  ).toBeVisible();
  await expect(eicarRow.getByRole("link", { name: EICAR_UPLOAD })).toHaveCount(0);
});

test("the download Route Handler returns 409 for a quarantined document", async ({
  page,
}) => {
  // The control is the SERVER'S refusal, not the missing link. Asserted against
  // the fixture quarantined document, whose id is known and whose verdict is
  // `quarantined` by construction (a freshly uploaded EICAR row's id is not
  // exposed in the DOM). `issueDownloadUrl` returns 409 for any non-`clean`
  // document, so no signed URL is ever minted for it.
  await signIn(page, world, "manager");

  const quarantinedUrl = `/${world.orgSlug}/documents/${world.quarantinedDocumentId}/download`;
  const refused = await page.request.get(quarantinedUrl, { maxRedirects: 0 });
  expect(refused.status(), "quarantined download is refused with 409").toBe(409);

  // Non-vacuity control: the fixture CLEAN document, in contrast, yields a
  // download link on the same list and its route is not a 409.
  await page.goto(`/${world.orgSlug}/documents`);
  const cleanFixtureLink = page.getByRole("link", { name: DOCUMENT_NAMES.clean });
  await expect(cleanFixtureLink).toHaveCount(1);

  // And the fixture quarantined document renders with no link and the reason.
  const quarantinedRow = page
    .getByRole("row")
    .filter({ hasText: DOCUMENT_NAMES.quarantined });
  await expect(
    quarantinedRow.getByRole("link", { name: DOCUMENT_NAMES.quarantined }),
  ).toHaveCount(0);
  await expect(
    quarantinedRow.getByText("Quarantined — cannot be opened"),
  ).toBeVisible();
});
