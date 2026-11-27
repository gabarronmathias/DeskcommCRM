import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ContactDetailClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await loadAuthUser();
  if (!user) notFound();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) notFound();
  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, organization_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!contact) notFound();
  return <ContactDetailClient contactId={id} />;
}
