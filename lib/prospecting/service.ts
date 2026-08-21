import type { SupabaseClient } from "@supabase/supabase-js";

import type { PublicBusinessProspect } from "./google-places";
import {
  NEW_STAGE_NAME,
  OPENING_MESSAGE,
  TARGET_ORG_SLUG,
  TARGET_PIPELINE_NAME,
} from "./config";
import { domainOf, normalizeBrazilianCommercialPhone, segmentTag } from "./normalization";

export interface ImportedProspect {
  outcome: "created" | "updated" | "duplicate" | "invalid";
  company: string;
  phone: string | null;
  category: string;
  city: string;
  leadId?: string;
  queueId?: string;
  reason?: string;
}

interface TargetContext {
  organizationId: string;
  pipelineId: string;
  newStageId: string;
  channelSessionId: string;
}

interface ExistingLead {
  id: string;
  contact_id: string;
  custom_fields: unknown;
  source_metadata: unknown;
  tags: unknown;
  reason: "google_place_id" | "phone" | "website_domain" | "name_address";
}

interface ExistingContact {
  contact_id: string;
  reason: "phone_contact";
}

async function loadTargetContext(db: SupabaseClient): Promise<TargetContext> {
  const { data: org } = await db.from("organizations").select("id").eq("slug", TARGET_ORG_SLUG).maybeSingle();
  if (!org) throw new Error("gabarron_mathias_org_not_found");

  const { data: pipeline } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", org.id)
    .eq("name", TARGET_PIPELINE_NAME)
    .eq("is_archived", false)
    .maybeSingle();
  if (!pipeline) throw new Error("gabarron_mathias_pipeline_not_found");

  const { data: stage } = await db
    .from("crm_stages")
    .select("id")
    .eq("organization_id", org.id)
    .eq("pipeline_id", pipeline.id)
    .eq("name", NEW_STAGE_NAME)
    .eq("is_archived", false)
    .maybeSingle();
  if (!stage) throw new Error("gabarron_mathias_new_stage_not_found");

  const { data: agent } = await db
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", org.id)
    .eq("name", "Sarah")
    .eq("is_active", true)
    .maybeSingle();
  if (!agent?.published_version_id) throw new Error("gabarron_mathias_sarah_not_published");

  const { data: version } = await db
    .from("ai_agent_versions")
    .select("channel_session_id")
    .eq("organization_id", org.id)
    .eq("id", agent.published_version_id)
    .maybeSingle();
  if (!version?.channel_session_id) throw new Error("gabarron_mathias_sarah_without_channel");

  const { data: session } = await db
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", org.id)
    .eq("id", version.channel_session_id)
    .maybeSingle();
  if (!session) throw new Error("gabarron_mathias_channel_not_owned");

  return {
    organizationId: org.id,
    pipelineId: pipeline.id,
    newStageId: stage.id,
    channelSessionId: session.id,
  };
}

async function findExisting(
  db: SupabaseClient,
  ctx: TargetContext,
  prospect: PublicBusinessProspect,
  phone: string,
  domain: string | null,
): Promise<ExistingLead | ExistingContact | null> {
  const { data: byPlace } = await db
    .from("crm_leads")
    .select("id, contact_id, custom_fields, source_metadata, tags")
    .eq("organization_id", ctx.organizationId)
    .eq("source", "google_places")
    .contains("source_metadata", { google_place_id: prospect.placeId })
    .maybeSingle();
  if (byPlace) return { ...byPlace, reason: "google_place_id" };

  const { data: contact } = await db
    .from("contacts")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("phone_number", phone)
    .is("is_merged_into", null)
    .maybeSingle();
  if (contact) {
    const { data: lead } = await db
      .from("crm_leads")
      .select("id, contact_id, custom_fields, source_metadata, tags")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lead) return { ...lead, reason: "phone" } as ExistingLead;
    return { contact_id: contact.id, reason: "phone_contact" };
  }

  if (domain) {
    const { data: byDomain } = await db
      .from("crm_leads")
      .select("id, contact_id, custom_fields, source_metadata, tags")
      .eq("organization_id", ctx.organizationId)
      .eq("custom_fields->>website_domain", domain)
      .limit(1)
      .maybeSingle();
    if (byDomain) return { ...byDomain, reason: "website_domain" };
  }

  if (prospect.address) {
    const { data: byName } = await db
      .from("crm_leads")
      .select("id, contact_id, custom_fields, source_metadata, tags")
      .eq("organization_id", ctx.organizationId)
      .ilike("title", prospect.companyName)
      .limit(5);
    const matching = (byName ?? []).find((lead) =>
      String((lead.custom_fields as Record<string, unknown>)?.address ?? "").toLowerCase() === prospect.address.toLowerCase(),
    );
    if (matching) return { ...matching, reason: "name_address" };
  }
  return null;
}

function fields(prospect: PublicBusinessProspect, phone: string, domain: string | null) {
  return {
    company_name: prospect.companyName,
    contact_name: null,
    business_category: prospect.category,
    phone,
    email: null,
    website: prospect.website,
    website_domain: domain,
    instagram: null,
    address: prospect.address,
    neighborhood: prospect.neighborhood,
    city: prospect.city,
    state: prospect.state,
    google_place_id: prospect.placeId,
    google_maps_url: prospect.mapsUrl,
    rating: prospect.rating,
    review_count: prospect.reviewCount,
    source: "google_places",
    prospecting_status: "queued",
    first_outbound_at: null,
    last_outbound_at: null,
    next_followup_at: null,
    last_reply_at: null,
    opt_out: false,
    qualification_summary: null,
  };
}

export async function importProspect(db: SupabaseClient, prospect: PublicBusinessProspect): Promise<ImportedProspect> {
  const phone = normalizeBrazilianCommercialPhone(prospect.phoneRaw);
  if (!phone) return { outcome: "invalid", company: prospect.companyName, phone: null, category: prospect.category, city: prospect.city, reason: "invalid_phone" };
  const ctx = await loadTargetContext(db);
  const domain = domainOf(prospect.website);
  const tags = ["prospeccao", "foodservice", segmentTag(prospect.category)];
  const customFields = fields(prospect, phone, domain);
  const sourceMetadata = {
    google_place_id: prospect.placeId,
    google_maps_url: prospect.mapsUrl,
    publicly_listed_business_phone: true,
    legal_basis: "legitimate_interest_b2b",
    business_status: prospect.businessStatus,
    captured_at: new Date().toISOString(),
  };

  const existing = await findExisting(db, ctx, prospect, phone, domain);
  if (existing && "id" in existing) {
    const previousFields = (existing.custom_fields ?? {}) as Record<string, unknown>;
    const previousSource = (existing.source_metadata ?? {}) as Record<string, unknown>;
    const previousTags = Array.isArray(existing.tags) ? existing.tags : [];
    await db.from("crm_leads").update({
      custom_fields: {
        ...previousFields,
        ...customFields,
        // Recoletar o mesmo estabelecimento enriquece os dados públicos, mas
        // nunca reinicia uma cadência que já avançou, respondeu ou deu STOP.
        prospecting_status: previousFields.prospecting_status ?? customFields.prospecting_status,
        first_outbound_at: previousFields.first_outbound_at ?? customFields.first_outbound_at,
        last_outbound_at: previousFields.last_outbound_at ?? customFields.last_outbound_at,
        next_followup_at: previousFields.next_followup_at ?? customFields.next_followup_at,
        last_reply_at: previousFields.last_reply_at ?? customFields.last_reply_at,
        opt_out: previousFields.opt_out ?? customFields.opt_out,
        qualification_summary: previousFields.qualification_summary ?? customFields.qualification_summary,
      },
      source_metadata: { ...previousSource, ...sourceMetadata },
      tags: [...new Set([...previousTags, ...tags])],
      last_activity_at: new Date().toISOString(),
    }).eq("organization_id", ctx.organizationId).eq("id", existing.id);
    return { outcome: "duplicate", company: prospect.companyName, phone, category: prospect.category, city: prospect.city, leadId: existing.id, reason: existing.reason };
  }

  let contact: { id: string } | null = existing ? { id: existing.contact_id } : null;
  if (!contact) {
    const { data: insertedContact, error: contactError } = await db.from("contacts").insert({
      organization_id: ctx.organizationId,
      name: prospect.companyName,
      display_name: prospect.companyName,
      phone_number: phone,
      source: "google_places",
      source_metadata: sourceMetadata,
      tags,
    }).select("id").single();
    if (contactError || !insertedContact) throw new Error(`prospecting_contact_insert: ${contactError?.message ?? "no_row"}`);
    contact = insertedContact;
  }

  const { data: lead, error: leadError } = await db.from("crm_leads").insert({
    organization_id: ctx.organizationId,
    pipeline_id: ctx.pipelineId,
    stage_id: ctx.newStageId,
    contact_id: contact.id,
    title: prospect.companyName,
    source: "google_places",
    source_metadata: sourceMetadata,
    custom_fields: customFields,
    tags,
    last_activity_at: new Date().toISOString(),
  }).select("id").single();
  if (leadError || !lead) throw new Error(`prospecting_lead_insert: ${leadError?.message ?? "no_row"}`);

  const { data: conversation, error: conversationError } = await db.from("conversations").insert({
    organization_id: ctx.organizationId,
    contact_id: contact.id,
    channel_session_id: ctx.channelSessionId,
    channel: "whatsapp",
    status: "ai_handling",
    metadata: { source: "google_places", google_place_id: prospect.placeId, prospecting: true },
  }).select("id").single();
  if (conversationError || !conversation) throw new Error(`prospecting_conversation_insert: ${conversationError?.message ?? "no_row"}`);

  const { data: queued, error: queueError } = await db.from("prospecting_outbound_queue").insert({
    organization_id: ctx.organizationId,
    lead_id: lead.id,
    contact_id: contact.id,
    conversation_id: conversation.id,
    channel_session_id: ctx.channelSessionId,
    kind: "opening",
    message_body: OPENING_MESSAGE(prospect.companyName),
    idempotency_key: `opening:${prospect.placeId}`,
    metadata: { source: "google_places", company: prospect.companyName, category: prospect.category, city: prospect.city },
  }).select("id").single();
  if (queueError || !queued) throw new Error(`prospecting_queue_insert: ${queueError?.message ?? "no_row"}`);

  return { outcome: "created", company: prospect.companyName, phone, category: prospect.category, city: prospect.city, leadId: lead.id, queueId: queued.id };
}

export async function targetOrganizationId(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("organizations").select("id").eq("slug", TARGET_ORG_SLUG).maybeSingle();
  if (!data) throw new Error("gabarron_mathias_org_not_found");
  return data.id;
}
