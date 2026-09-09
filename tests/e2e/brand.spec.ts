import { expect, test } from "@playwright/test";

// The checks a source-reading unit test cannot make. tests/unit/design/*
// asserts what the FILES say; this asserts what the BROWSER computed -- that
// the tokens resolved, the SVG rendered, and the ground is actually dark.

test.describe("brand", () => {
  test("the signed-out header carries the lockup on a dark ground", async ({
    page,
  }) => {
    await page.goto("/login");

    const logo = page.getByRole("img", { name: "GetSetPaid" });
    await expect(logo).toBeVisible();

    // Inside the home link, and the link's accessible name comes from it.
    await expect(
      page.getByRole("link", { name: "GetSetPaid" }),
    ).toBeVisible();

    // One <svg>: the wordmark. The mark is deliberately not in the header
    // (founder ruling -- it is illegible at this size); it lives in
    // app/icon.svg. Two here would mean it crept back in.
    await expect(logo.locator("svg")).toHaveCount(1);

    const bg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(bg).toBe("rgb(11, 11, 14)"); // --color-shell #0B0B0E

    // The wordmark resolves --color-ink through a token utility rather than
    // pinning a value, so this is the check that the theme actually applied.
    const wordFill = await logo
      .locator("svg")
      .first()
      .evaluate((el) => getComputedStyle(el).fill);
    expect(wordFill).toBe("rgb(245, 245, 247)"); // --color-ink #F5F5F7
  });

  test("color-scheme is dark, so native controls follow the page", async ({
    page,
  }) => {
    await page.goto("/login");
    const scheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(scheme).toBe("dark");
  });

  test("app/icon.svg loads as an image, not a broken-image placeholder", async ({
    page,
  }) => {
    // This is the check that would have caught the parse bug FIRST: a
    // double hyphen inside app/icon.svg's XML comment made the file
    // unparseable, but the server still returned it with a 200 and the
    // correct content-type -- the browser is the consumer that actually
    // rejects it. tests/unit/design/icon.test.ts now guards the file's
    // markup with a real XML parser, but that reads the file on disk; this
    // is the same file requested exactly the way a browser chrome, bookmark
    // bar or PWA installer requests it.
    await page.goto("/login");
    const dims = await page.evaluate(async () => {
      const img = new Image();
      const loaded = new Promise<{ w: number; h: number }>(
        (resolve, reject) => {
          img.onload = () =>
            resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error("icon.svg failed to load"));
        },
      );
      img.src = "/icon.svg";
      return loaded;
    });

    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);
    // The icon's canvas is a square viewBox (ICON_SQUARE in
    // scripts/trace-logo.py) precisely so it does not letterbox in a square
    // icon slot -- equal natural dimensions is the browser-side proof that
    // held.
    expect(dims.w).toBe(dims.h);
  });
});
