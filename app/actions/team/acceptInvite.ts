"use server";
/**
 * Server Action: accept a team invite token.
 *
 * Steps:
 *   1. Verify HMAC token (signature + expiry).
 *   2. Get current authenticated user from cookie session.
 *   3. Email mismatch → return error (UI tells user to sign out / use the right account).
 *   4. INSERT user_organizations (organization_id, user_id, role, accepted_at, invited_by=null).
 *      If a revoked row already exists for (user, org), reactivate it instead.
 *   5. Audit `member.accepted` and redirect to /app/inbox.
 */
import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { consumePendingInviteState } from "@/lib/admin-onboarding/team-invite-link";

export type AcceptInviteResult =
  | { ok: true }
  | { ok: false; error: "invalid_or_expired" | "email_mismatch" | "not_authenticated" | "internal_error"; message?: string; expectedEmail?: string };

async function consumeOnboardingInvite(
  db: ReturnType<typeof createAdminClient>,
  organizationId: string,
  inviteId: string,
  acceptedAt: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: org, error } = await db.from("organizations")
      .select("onboarding_state,updated_at")
      .eq("id", organizationId)
      .maybeSingle();
    if (error || !org) return false;

    const nextState = consumePendingInviteState(org.onboarding_state, inviteId, acceptedAt);
    if (!nextState) {
      const state = org.onboarding_state && typeof org.onboarding_state === "object" && !Array.isArray(org.onboarding_state)
        ? org.onboarding_state as Record<string, unknown>
        : {};
      const setup = state.foodservice_setup && typeof state.foodservice_setup === "object" && !Array.isArray(state.foodservice_setup)
        ? state.foodservice_setup as Record<string, unknown>
        : {};
      const invite = setup.team_invite && typeof setup.team_invite === "object" && !Array.isArray(setup.team_invite)
        ? setup.team_invite as Record<string, unknown>
        : {};
      return invite.accepted_invite_id === inviteId && invite.invite_id === null;
    }

    const latestUpdatedAt = Date.parse(String(org.updated_at ?? ""));
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(latestUpdatedAt) ? latestUpdatedAt + 1 : 0)).toISOString();
    const { data: updated, error: updateError } = await db.from("organizations")
      .update({ onboarding_state: nextState, updated_at: updatedAt })
      .eq("id", organizationId)
      .eq("updated_at", org.updated_at)
      .select("id")
      .maybeSingle();
    if (updateError) return false;
    if (updated) return true;
  }
  return false;
}

export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  const payload = verifyInviteToken(token);
  if (!payload) return { ok: false, error: "invalid_or_expired" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const userEmail = (user.email ?? "").trim().toLowerCase();
  const inviteEmail = payload.email.trim().toLowerCase();
  if (userEmail !== inviteEmail) {
    return { ok: false, error: "email_mismatch", expectedEmail: payload.email };
  }

  // Reactivate or insert. RLS em user_organizations exige admin da org para
  // INSERT/UPDATE (user_orgs_insert/update) — o convidado ainda NÃO é membro, então
  // não pode se auto-inserir. A escrita da membership usa o service role. Autorização:
  // token HMAC verificado + email do usuário autenticado === email do convite; org e
  // role vêm do token assinado (fonte confiável), nunca do body.
  const db = createAdminClient();
  if (payload.source === "admin_onboarding") {
    const { data: org, error } = await db.from("organizations")
      .select("onboarding_state")
      .eq("id", payload.organization_id)
      .maybeSingle();
    const onboardingState = org?.onboarding_state;
    const setup = onboardingState && typeof onboardingState === "object" && !Array.isArray(onboardingState)
      ? (onboardingState as Record<string, unknown>).foodservice_setup
      : null;
    const invitation = setup && typeof setup === "object" && !Array.isArray(setup)
      ? (setup as Record<string, unknown>).team_invite
      : null;
    const current = invitation && typeof invitation === "object" && !Array.isArray(invitation)
      ? invitation as Record<string, unknown>
      : {};
    if (error || !org || current.invite_id !== payload.invite_id
      || String(current.email ?? "").trim().toLowerCase() !== inviteEmail
      || current.role !== payload.role
      || typeof current.expires_at !== "string"
      || Date.parse(current.expires_at) <= Date.now()) {
      return { ok: false, error: "invalid_or_expired" };
    }
  }
  const { data: existing, error: fetchErr } = await db
    .from("user_organizations")
    .select("id, revoked_at")
    .eq("user_id", user.id)
    .eq("organization_id", payload.organization_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: "internal_error", message: fetchErr.message };
  }

  const nowIso = new Date().toISOString();

  if (existing?.id) {
    const { error: updErr } = await db
      .from("user_organizations")
      .update({
        role: payload.role,
        revoked_at: null,
        accepted_at: existing.revoked_at ? nowIso : (nowIso),
        updated_at: nowIso,
      })
      .eq("id", existing.id);
    if (updErr) return { ok: false, error: "internal_error", message: updErr.message };

    if (payload.source === "admin_onboarding"
      && !await consumeOnboardingInvite(db, payload.organization_id, payload.invite_id, nowIso)) {
      return { ok: false, error: "internal_error", message: "Não foi possível invalidar o link de convite após o aceite." };
    }

    await audit({
      action: "member.accepted",
      actorUserId: user.id,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: existing.id,
      metadata: { invite_id: payload.invite_id, role: payload.role, reactivated: !!existing.revoked_at },
    });
  } else {
    const { data: inserted, error: insErr } = await db
      .from("user_organizations")
      .insert({
        user_id: user.id,
        organization_id: payload.organization_id,
        role: payload.role,
        invited_at: new Date(payload.exp * 1000 - 24 * 60 * 60 * 1000).toISOString(),
        accepted_at: nowIso,
      })
      .select("id")
      .single();
    if (insErr) return { ok: false, error: "internal_error", message: insErr.message };

    if (payload.source === "admin_onboarding"
      && !await consumeOnboardingInvite(db, payload.organization_id, payload.invite_id, nowIso)) {
      return { ok: false, error: "internal_error", message: "Não foi possível invalidar o link de convite após o aceite." };
    }

    await audit({
      action: "member.accepted",
      actorUserId: user.id,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: inserted.id,
      metadata: { invite_id: payload.invite_id, role: payload.role },
    });
  }

  redirect("/app/inbox");
}
