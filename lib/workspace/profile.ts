import { TARGET_ORG_SLUG } from "@/lib/prospecting/config";

/**
 * A interface pode ter um recorte operacional sem alterar os dados nem as
 * permissões do tenant. A autorização continua sendo RLS + memberships; este
 * perfil só define quais ferramentas fazem sentido para a operação.
 */
export type WorkspaceProfile = "standard" | "foodservice_prospecting";

/**
 * A operação comercial da Gabarron & Mathias não opera pedidos de uma loja nem
 * integra Nuvemshop. O perfil reduz a interface ao CRM e à Sarah, sem
 * transformar uma preferência visual em uma regra de acesso de banco.
 */
export function workspaceProfileForOrganization(slug: string | null | undefined): WorkspaceProfile {
  return slug === TARGET_ORG_SLUG ? "foodservice_prospecting" : "standard";
}

const HIDDEN_IN_FOODSERVICE = new Set([
  "/app/orders",
  "/app/integrations/nuvemshop",
]);

export function isDestinationAvailable(
  href: string,
  profile: WorkspaceProfile | undefined,
): boolean {
  return profile !== "foodservice_prospecting" || !HIDDEN_IN_FOODSERVICE.has(href);
}
