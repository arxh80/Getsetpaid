import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";

// The three fields share one label/hint/error frame. The expected strings are
// the output of the three hand-written copies before the extraction, captured
// by rendering the old file -- not by running the new one.
describe("the shared field frame emits the markup the three copies emitted", () => {
  it("Field, with hint, error and footer", () => {
    expect(
      renderToStaticMarkup(
        <Field
          label="Email"
          type="email"
          name="email"
          required
          hint="Work address."
          error="Enter an email."
          footer={<a href="/x">Forgot?</a>}
          className="max-w-sm"
        />,
      ),
    ).toBe(
      "<div class=\"flex flex-col gap-2\"><label for=\"_R_0_\" class=\"text-sm font-semibold text-ink\">Email<span class=\"ml-2 font-normal text-ink-muted\">Required</span></label><p id=\"_R_0_-hint\" class=\"text-sm text-ink-muted\">Work address.</p><input spellCheck=\"false\" autoCorrect=\"off\" autoCapitalize=\"none\" type=\"email\" id=\"_R_0_\" required=\"\" aria-invalid=\"true\" aria-describedby=\"_R_0_-hint _R_0_-error\" class=\"h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink placeholder:text-ink-muted transition-colors duration-[var(--dur-fast)] ease-brand border-danger disabled:cursor-not-allowed disabled:opacity-55 max-w-sm\" name=\"email\"/><p id=\"_R_0_-error\" role=\"alert\" class=\"text-sm font-semibold text-danger\">Enter an email.</p><a href=\"/x\">Forgot?</a></div>",
    );
  });

  it("TextAreaField, with hint and error", () => {
    expect(
      renderToStaticMarkup(
        <TextAreaField label="Notes" name="notes" hint="Free text." error="Too long." />,
      ),
    ).toBe(
      "<div class=\"flex flex-col gap-2\"><label for=\"_R_0_\" class=\"text-sm font-semibold text-ink\">Notes<span class=\"ml-2 font-normal text-ink-muted\">Optional</span></label><p id=\"_R_0_-hint\" class=\"text-sm text-ink-muted\">Free text.</p><textarea name=\"notes\" id=\"_R_0_\" rows=\"5\" aria-invalid=\"true\" aria-describedby=\"_R_0_-hint _R_0_-error\" class=\"w-full min-w-0 border bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-muted transition-colors duration-[var(--dur-fast)] ease-brand border-danger disabled:cursor-not-allowed disabled:opacity-55 \"></textarea><p id=\"_R_0_-error\" role=\"alert\" class=\"text-sm font-semibold text-danger\">Too long.</p></div>",
    );
  });

  it("SelectField, required with an error", () => {
    expect(
      renderToStaticMarkup(
        <SelectField label="Status" name="status" required error="Pick one.">
          <option value="a">A</option>
        </SelectField>,
      ),
    ).toBe(
      "<div class=\"flex flex-col gap-2\"><label for=\"_R_0_\" class=\"text-sm font-semibold text-ink\">Status<span class=\"ml-2 font-normal text-ink-muted\">Required</span></label><select name=\"status\" id=\"_R_0_\" required=\"\" aria-invalid=\"true\" aria-describedby=\"_R_0_-error\" class=\"h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink transition-colors duration-[var(--dur-fast)] ease-brand border-danger disabled:cursor-not-allowed disabled:opacity-55 \"><option value=\"a\">A</option></select><p id=\"_R_0_-error\" role=\"alert\" class=\"text-sm font-semibold text-danger\">Pick one.</p></div>",
    );
  });
});
