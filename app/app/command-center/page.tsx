import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { CommandCenter } from "./CommandCenter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function CommandCenterPage() {
  const h = await headers();
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <CommandCenter orgId={org.orgId} orgName={org.name ?? "Operação"} />;
}

