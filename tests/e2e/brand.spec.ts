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
});
