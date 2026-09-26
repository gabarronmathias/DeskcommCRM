import { randomUUID } from "node:crypto";

import { generateAthosCredentials, hashBearerToken } from "@/lib/athos/contract";
import { createAthosLaunch } from "@/lib/athos/service";
import { createAdminClient } from "@/lib/supabase/admin";

const HOST_PROJECT_REF = "ukenluaihqiuwtdssatc";
const DEFAULT_MENU_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
const DEFAULT_STORE_REF = "5b7b4a38-4c54-488e-986f-9ea0428cff7a";

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");

  // Zero-cost mode intentionally shares only the Supabase compute instance.
  // All homologation rows live in athos_sandbox_* tables with no FKs/writes to
  // CRM production entities. Refuse any unexpected project so this script cannot
  // silently seed another environment.
  if (!supabaseUrl.includes(HOST_PROJECT_REF)) {
    throw new Error("Athos zero-cost sandbox must run on the configured host Supabase project");
  }
  if (process.env.ATHOS_SANDBOX_CONFIRM !== "ISOLATED_TABLES_ONLY") {
    throw new Error("Set ATHOS_SANDBOX_CONFIRM=ISOLATED_TABLES_ONLY to confirm sandbox-only provisioning");
  }

  const menuUrl = process.env.ATHOS_SANDBOX_MENU_URL ?? DEFAULT_MENU_URL;
  const storeRef = process.env.ATHOS_SANDBOX_STORE_REF ?? DEFAULT_STORE_REF;
  const admin = createAdminClient();

  const credentials = generateAthosCredentials();
  const bearerExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const connectionWrite = await admin
    .from("athos_sandbox_connections")
    .upsert(
      {
        environment: "sandbox",
        store_ref: storeRef,
        menu_url: menuUrl,
        bearer_hash: hashBearerToken(credentials.bearer),
        scopes: ["partner:athos", "athos:launch:read", "athos:events:write"],
        active: true,
        bearer_expires_at: bearerExpiresAt,
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_ref" },
    )
    .select("id")
    .single();
  if (connectionWrite.error || !connectionWrite.data) {
    throw connectionWrite.error ?? new Error("Athos sandbox connection provisioning failed");
  }

  const sandboxContactId = randomUUID();
  const launch = await createAthosLaunch({
    contactId: sandboxContactId,
    customerDisplayName: "Cliente Sandbox Athos",
    customerPhone: "+5511999999999",
    storeRef,
  });

  // Bearer and derived HMAC are shown exactly once so they can be handed to Athos.
  // Supabase persists only SHA-256(bearer), never a reversible partner secret.
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: "sandbox",
        isolation: "athos_sandbox_* tables only",
        store_ref: storeRef,
        athos_menu_url: menuUrl,
        launch_id: launch.launchId,
        launch_expires_at: launch.expiresAt,
        menu_url_with_launch: launch.menuUrl,
        sandbox_crm_contact_id: sandboxContactId,
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
  process.stderr.write(`[athos-sandbox] provisioning failed: ${message}\n`);
  process.exitCode = 1;
});
