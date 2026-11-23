import { describe, expect, it } from "vitest";
import { oneLine } from "@/lib/email/notice-render";

// Free text in a notice is one line: every character a mail client or a
// plain-text renderer could treat as a line break becomes a single space.
describe("oneLine", () => {
  it.each([
    ["CR LF", "a\r\nb"],
    ["tab", "a\tb"],
    ["vertical tab", "a\vb"],
    ["form feed", "a\fb"],
    ["NEL U+0085", "a\u0085b"],
    ["line separator U+2028", "a b"],
    ["paragraph separator U+2029", "a b"],
  ])("folds %s to one space", (_name, input) => {
    expect(oneLine(input, 50)).toBe("a b");
  });

  it("control: ordinary text is unchanged", () => {
    expect(oneLine("Load-in at the Fleece", 50)).toBe("Load-in at the Fleece");
  });
});
