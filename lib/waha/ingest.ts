/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";
import { bareWaMessageId } from "@/lib/waha/message-id";

type Admin = ReturnType<typeof createAdminClient>;

interface Session {
  id: string;
  organization_id: string;
}

export interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
  /** WAHA >= 2026.x (NOWEB): mídia vem aninhada em payload.media. */
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
  _data?: {
    notifyName?: string;
    pushName?: string;
    /** NOWEB: o conteúdo real (imageMessage, stickerMessage, …) — fonte do tipo. */
    message?: Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null };

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` | formato desconhecido -> group (skip binding CRM)
 */
export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId.replace(/@.*$/, "") };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "group", phone: null, lid: null };
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

export function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  const t = resolveMessageType(p);
  return t !== "text" ? `[${t}]` : "";
}

/** URL da mídia: WAHA novo (payload.media.url) com fallback legado (payload.mediaUrl). */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.mediaUrl ?? p.media?.url ?? null;
}

/** MIME da mídia: idem (payload.media.mimetype é o campo do NOWEB atual). */
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.mimetype ?? p.media?.mimetype ?? null;
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * NOWEB (WAHA 2026.x) não envia `type` no payload — o tipo real está nas
 * chaves de `_data.message` (imageMessage, stickerMessage, …). Ordem de
 * resolução: `type` explícito → chave do message → prefixo do MIME → text.
 */
const NOWEB_MESSAGE_KEY_TYPE: Record<string, string> = {
  stickerMessage: "sticker",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video", // video note (bolinha)
  audioMessage: "audio",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
};

export function resolveMessageType(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const msg = p._data?.message;
  if (msg && typeof msg === "object") {
    for (const [key, mapped] of Object.entries(NOWEB_MESSAGE_KEY_TYPE)) {
      if (key in msg) return mapped;
    }
  }
  const mime = mediaMimeOf(p);
  if (mime) {
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar.
 *
 * Política em 23505 (unique violation):
 *   O contato JÁ EXISTE (a constraint não mente). Em vez de criar outro,
 *   localizamos o vencedor por QUALQUER caminho de identidade canônico
 *   e o reutilizamos. Cobrimos:
 *     - índice `uniq_contacts_org_wa_identity` (wa_identity — versão 0027)
 *     - índice `uniq_contacts_org_wa_lid` (wa_lid — adicionado em produção,
 *       fora das migrations)
 *     - legado jsonb `source_metadata->>'waha_lid'` (pré-0027)
 *     - coluna `phone_number` (legado)
 *
 *   A diferença entre LOOKUP_NOT_FOUND e LOOKUP_FAILED é explícita: erro de
 *   query propaga como throw; null genuíno também propaga (não cria contato
 *   às cegas em race extrema).
 *
 *   Contatos mergeados (`is_merged_into IS NOT NULL`) resolvem para o
 *   canônico — sem merge destrutivo automático.
 */
/** Exportada só para teste. Em produção é chamada por handleInbound/handleOutboundFromUserPhone. */
export async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
): Promise<string | null> {
  if (parsed.kind === "group") return null;
  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? parsed.phone : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  } as never);
  if (!error) return (data as string) ?? null;

  // Erro que NÃO é unique violation: propaga sem fallback cego.
  if (error.code !== "23505") {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    throw new Error(`waha contact upsert failed: ${error.message}`);
  }

  // 23505: tenta recuperar pelo caminho mais amplo possível.
  const lid = parsed.kind === "lid" ? parsed.lid.replace(/@.*$/, "") : null;
  const phone = parsed.kind === "phone" ? parsed.phone : null;
  const recovered = await findExistingContactByIdentity(admin, orgId, { lid, phone });
  if (recovered) return recovered;

  // LOOKUP_NOT_FOUND genuíno após 23505: race extrema ou drift de schema.
  // NÃO criar outro contato — propagar erro recuperável pro webhook retornar
  // 503 e o WAHA reentregar (com lock mais limpo da segunda vez).
  console.error("[waha.ingest] contact upsert race: 23505 but no existing contact", {
    org_id: orgId,
    parsed_kind: parsed.kind,
    lid, phone,
    constraint_error: error.message,
  });
  throw new Error(`waha contact upsert race: ${error.message}`);
}

/**
 * Localiza contato existente na MESMA organização por precedência
 * DETERMINÍSTICA de identidade WhatsApp. NÃO faz merge destrutivo: cada
 * match encontrado é resolvido para o canônico (via `is_merged_into`),
 * e os canonicals únicos são contados.
 *
 * SEM MÚLTIPLOS CANÔNICOS POR IDENTIDADE:
 *   Índices únicos são parciais (`WHERE is_merged_into IS NULL`), o que
 *   significa que linhas mergeadas PODEM coexistir com a mesma identidade
 *   (wa_lid, wa_identity ou phone). Para uma identidade `X`, podem haver:
 *     - 0 matches
 *     - N mergeados convergindo para 1 canônico (caso normal)
 *     - N mergeados convergindo para canônicos DIFERENTES (corrupção)
 *     - 1 ativo + N mergeados convergindo para canônicos DIFERENTES
 *
 *   Regras:
 *     0 matches         → próximo nível
 *     1 canônico único  → retorna
 *     >1 canônicos distintos → throw CONTACT_IDENTITY_CONFLICT
 *
 *   Proibido:
 *     - .maybeSingle() (falha em >1 match, esconde conflito)
 *     - .order("created_at").limit(1) (oldest-wins esconde conflito)
 *     - criar contato novo quando há ambiguidade
 *
 * PRECEDÊNCIA (estrita; telefone nunca vence wa_lid):
 *   1. `wa_lid` coluna (índice uniq_contacts_org_wa_lid em produção) — EXATO
 *   2. LID canônico/legado:
 *        `wa_identity = 'lid:<digits>'`  (coluna gerada)
 *        `source_metadata->>'waha_lid' = <digits>`  (jsonb legado pré-0027)
 *   3. Telefone (SÓ se `parsed.kind === "phone"`):
 *        `phone_number = <+E164>`
 *        `wa_identity = 'phone:<+E164>'`
 *
 * IMPORTANTE: NÃO filtramos `is_merged_into IS NULL` na query. A política
 * real de merge no projeto (supabase/baseline.sql:4165) SÓ seta
 * `is_merged_into` e move as FKs — não transfere `wa_lid`, `wa_identity` ou
 * `phone` para o canônico. Identidades em contatos mergeados ficam
 * órfãs no banco; se a query filtrasse mergeados, essas identidades
 * desapareceriam do alcance da busca.
 *
 * LOOKUP_FAILED (erro de query) propaga como throw. LOOKUP_NOT_FOUND
 * genuíno (consulta funcionou, zero matches em todos os níveis) retorna null.
 */
async function findExistingContactByIdentity(
  admin: Admin,
  orgId: string,
  identity: { lid: string | null; phone: string | null },
): Promise<string | null> {
  const lid = identity.lid;
  const phone = identity.phone;
  const MAX_MATCHES = 10; // limite defensivo — em produção é 1 ou poucos

  // ----- Nível 1: wa_lid coluna (EXATO; identidade mais forte) -----
  if (lid) {
    const result = await admin
      .from("contacts")
      .select("id, is_merged_into")
      .eq("organization_id", orgId)
      .eq("wa_lid", lid)
      .limit(MAX_MATCHES);
    if (result.error) throw new Error(`waha wa_lid lookup failed: ${result.error.message}`);
    const decision = await resolveMatchesToCanonical(admin, result.data ?? [], "wa_lid");
    if (decision.kind === "one") return decision.id;
    if (decision.kind === "ambiguous") throw new Error(decision.message);
    // kind === "none" → cai pro próximo nível
  }

  // ----- Nível 2: LID canônico/legado -----
  if (lid) {
    const result = await admin
      .from("contacts")
      .select("id, is_merged_into")
      .eq("organization_id", orgId)
      .or(`wa_identity.eq.lid:${lid},source_metadata->>waha_lid.eq.${lid}`)
      .limit(MAX_MATCHES);
    if (result.error) throw new Error(`waha lid legacy lookup failed: ${result.error.message}`);
    const decision = await resolveMatchesToCanonical(admin, result.data ?? [], "lid_legacy");
    if (decision.kind === "one") return decision.id;
    if (decision.kind === "ambiguous") throw new Error(decision.message);
  }

  // ----- Nível 3: telefone (SÓ se kind=phone) -----
  if (phone) {
    const e164 = phone.startsWith("+") ? phone : `+${phone}`;
    const result = await admin
      .from("contacts")
      .select("id, is_merged_into")
      .eq("organization_id", orgId)
      .or(`phone_number.eq.${e164},wa_identity.eq.phone:${e164}`)
      .limit(MAX_MATCHES);
    if (result.error) throw new Error(`waha phone lookup failed: ${result.error.message}`);
    const decision = await resolveMatchesToCanonical(admin, result.data ?? [], "phone");
    if (decision.kind === "one") return decision.id;
    if (decision.kind === "ambiguous") throw new Error(decision.message);
  }

  return null;
}

/**
 * Para cada match, resolve cadeia de merge (`is_merged_into` recursivo até
 * encontrar um contato ativo). Retorna:
 *   - "one" + id: exatamente 1 canônico único
 *   - "ambiguous" + message: >1 canônicos distintos — conflito de identidade
 *   - "none": zero matches
 */
async function resolveMatchesToCanonical(
  admin: Admin,
  matches: Array<{ id: string; is_merged_into?: string | null }>,
  level: "wa_lid" | "lid_legacy" | "phone",
): Promise<
  | { kind: "one"; id: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "none" }
> {
  if (matches.length === 0) return { kind: "none" };

  const canonicals = new Set<string>();
  for (const m of matches) {
    const id = await resolveCanonicalChain(admin, m);
    canonicals.add(id);
  }

  if (canonicals.size === 1) return { kind: "one", id: canonicals.values().next().value! };
  // > 1 canônicos distintos: AMBIGUIDADE — bloqueia, não escolhe, não cria
  const ids = [...canonicals];
  return {
    kind: "ambiguous",
    message:
      `CONTACT_IDENTITY_CONFLICT: ${canonicals.size} canônicos distintos para ` +
      `identidade no nível ${level} (canonicais: ${ids.join(", ")}; ` +
      `matches brutos: ${matches.length}). ` +
      `Resolve manualmente antes de continuar — não foi possível escolher deterministicamente.`,
  };
}

/**
 * Resolve cadeia de merge. A merge chain é resolvida recursivamente até
 * encontrar contato sem `is_merged_into`. Limite de profundidade pra
 * evitar loops infinitos em caso de corrupção (ciclo A→B→A).
 */
async function resolveCanonicalChain(
  admin: Admin,
  contact: { id: string; is_merged_into?: string | null },
  depth = 0,
): Promise<string> {
  if (!contact.is_merged_into) return contact.id;
  if (depth >= 5) {
    throw new Error(
      `waha merge chain too deep at ${contact.id} (depth ${depth}). ` +
      `Verificar manualmente — provável ciclo de merges.`,
    );
  }
  const { data, error } = await admin
    .from("contacts")
    .select("id, is_merged_into")
    .eq("id", contact.is_merged_into)
    .maybeSingle();
  if (error) throw new Error(`waha canonical lookup failed: ${error.message}`);
  if (!data) return contact.id; // degradação segura — pode ter sido deletado
  return resolveCanonicalChain(admin, data, depth + 1);
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    throw new Error(`waha conversation upsert failed: ${error.message}`);
  }
  return (data as string) ?? null;
}

/**
 * Carimba a conversa com a mensagem que acabou de entrar.
 *
 * ⚠️ FALHA BAIXO, MAS CONTA — e a diferença entre as duas coisas é o motivo
 * desta função existir com corpo próprio. A mensagem JÁ foi inserida quando
 * chegamos aqui; bloquear a ingestão porque o carimbo falhou deixaria o
 * histórico refém de uma coluna derivada. Então não se bloqueia.
 *
 * Mas `console.error` sozinho não é "falhar baixo": ele **não bloqueia e também
 * não conta** (anti-pattern nº 14 do CLAUDE.md, e a mesma doutrina já escrita em
 * `lib/leads/activity-write-failure.ts`). Log de servidor sem destino não vira
 * alerta de ninguém — e o efeito prático é que "a RPC falha às vezes" nunca sai
 * de OPINIÃO para NÚMERO. Em 25/07 isso custou caro: a suspeita de que esta
 * chamada falhava foi levada a sério por horas, e não havia como medi-la porque
 * cada falha tinha sumido no log de um processo que já não existia.
 *
 * O evento é o que torna a pergunta respondível: `select count(*) from event_log
 * where event_type = 'whatsapp.conversation_mark_failed'`.
 */
async function markConversation(
  admin: Admin,
  organizationId: string,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (!error) return;

  const { error: erroAviso } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.conversation_mark_failed",
    p_entity_kind: "conversation",
    p_entity_id: convId,
    // O preview NÃO entra no payload: ele é o texto da mensagem do cliente, e
    // isto é registro operacional, não cópia de conteúdo. O que se precisa
    // saber para agir é qual conversa, que sentido, e o erro.
    p_payload: { direction, erro: error.message },
    p_metadata: { severity: "warn" },
    p_organization_id: organizationId,
  } as never);

  if (erroAviso) {
    // Segunda linha de defesa: o próprio canal de aviso caiu. Aqui o log do
    // processo é o que sobra — é para ESTE caso que ele existe, não como rotina.
    console.error("[waha.ingest] o carimbo falhou E o aviso também", {
      conversa: convId,
      erro: error.message,
      aviso: erroAviso.message,
    });
  }
}

interface InboundEventDetails {
  organizationId: string;
  messageId: string;
  conversationId: string;
  contactId: string;
  channelSessionId: string;
  externalId: string;
  body: string;
  hasMedia: boolean;
  requestId: string;
}

/**
 * Eventos que sustentam o próximo passo são parte da ingestão, não um efeito
 * colateral fire-and-forget. A rota só confirma o webhook depois que eles
 * foram aceitos pelo event_log; em falha, o WAHA recebe 503 e pode reenviar.
 * `source_event_key` torna o replay do mesmo webhook idempotente no banco.
 */
async function emitInboundEvents(admin: Admin, details: InboundEventDetails): Promise<void> {
  const baseMetadata = {
    source: "waha_webhook",
    request_id: details.requestId,
    source_event_key: `waha:${details.organizationId}:${details.externalId}`,
  };
  const events = [
    {
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_payload: {
        organization_id: details.organizationId,
        conversation_id: details.conversationId,
        contact_id: details.contactId,
        channel_session_id: details.channelSessionId,
        inbound_message_id: details.messageId,
        correlation_id: details.requestId,
      },
    },
    ...(details.hasMedia
      ? [{
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_payload: {
            message_id: details.messageId,
            conversation_id: details.conversationId,
            correlation_id: details.requestId,
          },
        }]
      : []),
  ];

  const results = await Promise.all(
    events.map((event) =>
      admin.rpc("emit_event" as never, {
        ...event,
        p_metadata: { ...baseMetadata, source_event_key: `${baseMetadata.source_event_key}:${event.p_event_type}` },
        p_organization_id: details.organizationId,
      } as never),
    ),
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(`waha event emission failed: ${failed.error.message}`);
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id || !chatId) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;

  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName, correlation_id: requestId },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    throw new Error(`waha inbound message insert failed: ${insertErr.message}`);
  }
  if (insertErr?.code === "23505") {
    // `message` + `message.any` e retries do WAHA chegam com o mesmo external_id.
    // Reconfirma os eventos pelo mesmo source_event_key; o banco deduplica sem
    // criar uma segunda execução do agente.
    const existing = await admin
      .from("messages")
      .select("id, conversation_id, contact_id, channel_session_id, body, media_url")
      .eq("organization_id", session.organization_id)
      .eq("external_id", p.id)
      .maybeSingle();
    if (existing.error) throw new Error(`waha duplicate lookup failed: ${existing.error.message}`);
    if (existing.data?.id) {
      await emitInboundEvents(admin, {
        organizationId: session.organization_id,
        messageId: existing.data.id,
        conversationId: existing.data.conversation_id,
        contactId: existing.data.contact_id,
        channelSessionId: existing.data.channel_session_id,
        externalId: p.id,
        body: existing.data.body ?? "",
        hasMedia: Boolean(existing.data.media_url),
        requestId,
      });
    }
    return;
  }

  await markConversation(admin, session.organization_id, conversationId, "inbound", previewFromMessage(p), now);

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: now })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // O event_log é a custódia durável do próximo passo. A confirmação do
  // webhook só sai depois que os eventos foram aceitos.
  if (insertedMessage?.id) {
    await emitInboundEvents(admin, {
      organizationId: session.organization_id,
      messageId: insertedMessage.id,
      conversationId,
      contactId,
      channelSessionId: session.id,
      externalId: p.id!,
      body: p.body ?? "",
      hasMedia: Boolean(mediaUrlOf(p)),
      requestId,
    });
  }
}

/**
 * fromMe=true: operador respondeu direto do WhatsApp dele (não pelo composer).
 * Contato = destinatário (`to`). `from` é o próprio número do operador — nunca
 * vira contato. Registrado como outbound p/ o operador ver o histórico completo.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.to ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;

  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedOutbound, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "outbound",
      status: "sent",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      metadata: { raw_type: p.type, fromMe: true },
    })
    .select("id")
    .maybeSingle();
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, session.organization_id, conversationId, "outbound", previewFromMessage(p), now);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id, from_user_phone: true },
  });

  if (insertedOutbound?.id && mediaUrlOf(p)) {
    admin
      .rpc("emit_event" as never, {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: insertedOutbound.id,
        p_payload: { message_id: insertedOutbound.id, conversation_id: conversationId },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
      });
  }
}

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  // O ack do WAHA 2026.x vem como `{fromMe}_{chatId}_{bareId}`. O NOWEB grava
  // `external_id` = bareId (id interno), o WEBJS grava o `_serialized` completo.
  // Casar as duas formas cobre ambos os engines sem tocar no external_id de
  // inbound (que é full e sustenta o dedup 23505).
  const bare = bareWaMessageId(p.id);
  const candidates = bare === p.id ? [p.id] : [p.id, bare];
  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .in("external_id", candidates);
}

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
    if (payload.fromMe) {
      await handleOutboundFromUserPhone(admin, session, payload, requestId);
    } else {
      await handleInbound(admin, session, payload, requestId);
    }
  } else if (eventType === "message.ack") {
    await handleAck(admin, session, payload);
  } else if (eventType === "session.status" || eventType === "state.change") {
    await handleSessionStatus(admin, session, payload);
  }
}
