type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

/** The admin Foodservice onboarding is authoritative once its state exists. */
export function foodserviceActivationPending(onboardingState: unknown): boolean {
  const setup = record(record(onboardingState).foodservice_setup);
  return Object.keys(setup).length > 0 && setup.status !== "ACTIVE";
}

export function foodserviceSetupExists(onboardingState: unknown): boolean {
  return Object.keys(record(record(onboardingState).foodservice_setup)).length > 0;
}
