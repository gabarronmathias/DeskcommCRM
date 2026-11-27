import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Verifica membership aceita pelo e-mail do operador, sempre dentro da organização. */
export async function hasAcceptedTeamMembership(
  admin: AdminClient,
  organizationId: string,
  email: string,
  role: "agent" | "manager",
): Promise<"accepted" | "missing" | "error"> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return "missing";

  const { data: memberships, error } = await admin.from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", role)
    .not("accepted_at", "is", null)
    .is("revoked_at", null);
  if (error) return "error";

  for (const membership of memberships ?? []) {
    const { data, error: authError } = await admin.auth.admin.getUserById(membership.user_id);
    if (authError) return "error";
    if (data.user?.email?.trim().toLowerCase() === normalizedEmail) return "accepted";
  }
  return "missing";
}
