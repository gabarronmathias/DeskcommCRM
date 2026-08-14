import { redirect } from "next/navigation";

import { DemoAoVivoClient } from "./_components/DemoAoVivoClient";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

export const dynamic = "force-dynamic";

export default async function DemoAoVivoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const key = process.env.WAHA_API_KEY;
  const wahaConfigured = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );
  const wakeUrls = [process.env.DEMO_WORKER_WAKE_URL, process.env.DEMO_WAHA_WAKE_URL].filter(
    (url): url is string => Boolean(url),
  );

  return (
    <DemoAoVivoClient
      organizationId={activeOrg.orgId}
      organizationName={activeOrg.name}
      wahaConfigured={wahaConfigured}
      wakeUrls={wakeUrls}
    />
  );
}
