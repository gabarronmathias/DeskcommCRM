import { generateAthosCredentials, hashBearerToken } from "@/lib/athos/contract";
import { createAthosLaunch } from "@/lib/athos/service";
import { createAdminClient } from "@/lib/supabase/admin";

const PRODUCTION_PROJECT_REF = "ukenluaihqiuwtdssatc";
const DEFAULT_MENU_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
const DEFAULT_STORE_REF = "5b7b4a38-4c54-488e-986f-9ea0428cff7a";

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  if (supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Refusing to provision Athos sandbox against the production Supabase project");
  }
  if (process.env.ATHOS_SANDBOX_CONFIRM !== "ATHOS_SANDBOX_ONLY") {
    throw new Error("Set ATHOS_SANDBOX_CONFIRM=ATHOS_SANDBOX_ONLY to confirm isolated sandbox provisioning");
  }

  const menuUrl = process.env.ATHOS_SANDBOX_MENU_URL ?? DEFAULT_MENU_URL;
  const storeRef = process.env.ATHOS_SANDBOX_STORE_REF ?? DEFAULT_STORE_REF;
  const admin = createAdminClient();

  let { data: organization, error: organizationLookupError } = await admin
    .from("organizations")
    .select("id, slug")
    .eq("slug", "athos-sandbox-piloto")
    .maybeSingle();
  if (organizationLookupError) throw organizationLookupError;

  if (!organization) {
    const created = await admin
      .from("organizations")
      .insert({
        slug: "athos-sandbox-piloto",
        legal_name: "Athos Sandbox Piloto",
        display_name: "Athos Sandbox Piloto",
        status: "active",
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        settings: { sandbox: true, partner: "athos" },
      })
      .select("id, slug")
      .single();
    if (created.error || !created.data) throw created.error ?? new Error("sandbox organization creation failed");
    organization = created.data;
  }

  let { data: contact, error: contactLookupError } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organization.id)
    .eq("source_metadata->>sandbox_key", "athos_pilot_customer")
    .maybeSingle();
  if (contactLookupError) throw contactLookupError;

  if (!contact) {
    const created = await admin
      .from("contacts")
      .insert({
        organization_id: organization.id,
        name: "Cliente Sandbox Athos",
        display_name: "Cliente Sandbox Athos",
        phone_number: "+5511999999999",
        source: "manual",
        source_metadata: { sandbox_key: "athos_pilot_customer", partner: "athos" },
      })
      .select("id")
      .single();
    if (created.error || !created.data) throw created.error ?? new Error("sandbox contact creation failed");
    contact = created.data;
  }

  const credentials = generateAthosCredentials();
  const encrypted = await admin.rpc("fn_encrypt_oauth", { plaintext: credentials.hmacSecret });
  if (encrypted.error || !encrypted.data) {
    throw encrypted.error ?? new Error("HMAC secret encryption failed");
  }

  const bearerExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const connectionWrite = await admin
    .from("partner_athos_connections")
    .upsert(
      {
        organization_id: organization.id,
        environment: "sandbox",
        store_ref: storeRef,
        menu_url: menuUrl,
        bearer_hash: hashBearerToken(credentials.bearer),
        hmac_secret_encrypted: encrypted.data,
        scopes: ["partner:athos", "athos:launch:read", "athos:events:write"],
        active: true,
        bearer_expires_at: bearerExpiresAt,
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,environment,store_ref" },
    )
    .select("id")
    .single();
  if (connectionWrite.error || !connectionWrite.data) {
    throw connectionWrite.error ?? new Error("Athos connection provisioning failed");
  }

  const launch = await createAthosLaunch({
    organizationId: organization.id,
    contactId: contact.id,
    storeRef,
  });

  // These two secrets are deliberately printed only at provisioning time.
  // Never commit, log elsewhere or send through an open email/WhatsApp group.
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: "sandbox",
        organization_id: organization.id,
        store_ref: storeRef,
        athos_menu_url: menuUrl,
        launch_id: launch.launchId,
        launch_expires_at: launch.expiresAt,
        menu_url_with_launch: launch.menuUrl,
        bearer: credentials.bearer,
        hmac_secret: credentials.hmacSecret,
        bearer_expires_at: bearerExpiresAt,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Never include secret values in thrown errors.
  process.stderr.write(`[athos-sandbox] provisioning failed: ${message}\n`);
  process.exitCode = 1;
});
