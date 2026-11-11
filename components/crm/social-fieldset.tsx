import { SOCIAL_PLATFORMS } from "@/lib/crm/urls";
import type { FormState } from "@/lib/forms";
import { Field } from "@/components/ui/field";

/** The Social block the contact, artist and venue forms share. */
export function SocialFieldset({
  shown,
  fieldErrors,
}: {
  /** The value to show for a platform key: the echoed submit, else the saved one. */
  shown: (key: string) => string;
  fieldErrors: FormState["fieldErrors"];
}) {
  return (
    <fieldset className="flex flex-col gap-5 border border-rule p-5">
      {/* A real <fieldset>/<legend>, so a screen reader announces "Social,
          Instagram" rather than unrelated inputs called after platforms. */}
      <legend className="px-2 text-sm font-semibold tracking-[0.04em] text-ink-muted uppercase">
        Social
      </legend>
      <p className="max-w-prose text-sm text-ink-muted">
        A handle or a full link. Only http:// and https:// links are stored —
        anything else is refused, here and again when the page renders it.
      </p>
      {SOCIAL_PLATFORMS.map((platform) => (
        <Field
          key={platform.key}
          label={platform.label}
          name={`social_${platform.key}`}
          defaultValue={shown(platform.key)}
          autoComplete="off"
          maxLength={300}
          error={fieldErrors?.[`social_${platform.key}`]}
        />
      ))}
    </fieldset>
  );
}
