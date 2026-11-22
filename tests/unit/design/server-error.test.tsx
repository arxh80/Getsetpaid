// DESIGN.md § Error pages, the 500 row: the copy, Retry plus a way out, and
// never the error's own message (it can carry internals).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AppError from "@/app/(app)/error";
import RootError from "@/app/error";

const secret = new Error("relation private.step_up_tokens does not exist");

describe("the 500 page", () => {
  it.each([
    ["in the shell", AppError, "<div"],
    ["outside the shell", RootError, "<main"],
  ])("%s shows the DESIGN.md copy and actions, opening with the right element", (_, Page, opener) => {
    const html = renderToStaticMarkup(<Page error={secret} reset={() => {}} />);
    expect(html.startsWith(opener)).toBe(true);
    expect(html).toContain("500");
    expect(html).toContain("Something went wrong on our end.");
    expect(html).toContain(">Retry<");
    expect(html).toContain('href="/"');
  });

  it("never renders the error's message", () => {
    for (const Page of [AppError, RootError]) {
      const html = renderToStaticMarkup(<Page error={secret} reset={() => {}} />);
      expect(html).not.toContain("step_up_tokens");
    }
  });
});
