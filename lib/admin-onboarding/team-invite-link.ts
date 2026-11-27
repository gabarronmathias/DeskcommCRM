import { signInviteToken } from "@/lib/auth/invite-token";

type InviteRole = "agent" | "manager";

interface PendingInviteLinkInput {
  inviteId: string;
  email: string;
  organizationId: string;
  role: InviteRole;
  expiresAt: string;
  baseUrl: string;
  now?: number;
}

/** Reassina os dados do convite pendente existente; nunca persiste o token. */
export function buildPendingInviteLink(input: PendingInviteLinkInput): string | null {
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.now ?? Date.now())) return null;
  if (!input.inviteId || !input.organizationId || !input.email.trim()) return null;
  if (input.role !== "agent" && input.role !== "manager") return null;

  let origin: URL;
  try {
    origin = new URL(input.baseUrl);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") return null;

  const token = signInviteToken({
    invite_id: input.inviteId,
    email: input.email.trim().toLowerCase(),
    organization_id: input.organizationId,
    role: input.role,
    exp: Math.floor(expiresAt / 1000),
    source: "admin_onboarding",
  });
  return new URL(`/team/accept-invite/${token}`, origin).toString();
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

/** Invalida o id usado pelo link após a membership ser aceita. */
export function consumePendingInviteState(
  stateValue: unknown,
  inviteId: string,
  acceptedAt: string,
): JsonRecord | null {
  const state = record(stateValue);
  const setup = record(state.foodservice_setup);
  const invite = record(setup.team_invite);
  if (invite.invite_id !== inviteId) return null;

  return {
    ...state,
    foodservice_setup: {
      ...setup,
      team_invite: {
        ...invite,
        invite_id: null,
        accepted_invite_id: inviteId,
        accepted_at: acceptedAt,
        expires_at: acceptedAt,
      },
    },
  };
}
