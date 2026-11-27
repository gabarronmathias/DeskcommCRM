export function foodserviceActivationGatePending(onboardingState: unknown): boolean {
  if (!onboardingState || typeof onboardingState !== "object" || Array.isArray(onboardingState)) return false;
  const setup = (onboardingState as Record<string, unknown>).foodservice_setup;
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) return false;
  return (setup as Record<string, unknown>).status !== "ACTIVE";
}
