import { checkStepUp, stepUpProofMode } from "@/lib/auth/step-up-gate";
import { ReauthPrompt } from "./reauth-prompt";

/**
 * Reusable step-up gate: wraps a security-sensitive action's UI and demands a
 * fresh (<=5 min) credential before rendering it, per CLAUDE.md § Session
 * security ("Step-up re-authentication ... required before: changing security
 * settings, large data exports, deleting organisation data, and any high-risk
 * admin/superuser function").
 *
 * NO CONSUMER WIRED UP YET, on purpose -- there is nothing in this phase that
 * needs step-up (no security-settings screen, no export, no org-deletion UI,
 * no impersonation flow exist to protect). Later phases import this exactly
 * as-is:
 *
 *   <StepUpGate next="/org/security">
 *     <ChangeMfaSettingsForm />
 *   </StepUpGate>
 *
 * The underlying decision (checkStepUp -> isStepUpSatisfied ->
 * readAuthFreshness) is proven in tests/unit/auth/step-up-gate.test.ts and,
 * for the amr arithmetic itself, tests/unit/auth/step-up.test.ts. This
 * component's own job is one branch: render the gated content when fresh,
 * the re-auth prompt when not -- and, per fix round 1 Important 4,
 * stepUpProofMode() decides WHICH proof that prompt asks for (MFA preferred,
 * password fallback, or neither for a Google-SSO-only user with no verified
 * factor).
 */
export async function StepUpGate({
  next,
  children,
}: {
  /** Where to return to once step-up succeeds -- same-origin path only. */
  next: string;
  children: React.ReactNode;
}) {
  const fresh = await checkStepUp();
  if (fresh) return <>{children}</>;

  const proof = await stepUpProofMode();
  return <ReauthPrompt next={next} proof={proof} />;
}
