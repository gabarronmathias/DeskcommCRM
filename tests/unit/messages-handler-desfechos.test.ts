/**
 * Task 4a do seam de canais â€” rede de caracterizaÃ§Ã£o do caminho de envio.
 *
 * Fixa os 6 desfechos que `sendMessageHandler` produz DEPOIS de inserir a linha
 * (`_handler.ts:219-318`), escrita contra o cÃ³digo ATUAL, antes de qualquer
 * refactor. As Tasks 4bâ€“4d trocam `getWahaClient`/`resolveWahaChatId`/`sendMedia`
 * por `ChannelAdapter` â€” por isso aqui se asserta o **estado final da linha de
 * mensagem**, nunca a sequÃªncia de chamadas internas: teste que asserta chamada
 * travaria exatamente o refactor que ele deveria proteger.
 *
 * Fake prÃ³prio de propÃ³sito: `tests/invariants/automation-send-whatsapp.test.ts`
 * Ã© o Ãºnico outro teste que exercita este handler, mas arrasta `gov-helpers` e
 * exige Postgres real â€” e a pasta `tests/invariants/` estÃ¡ fora do `test:unit` e
 * do CI. Duplicar scaffolding Ã© o preÃ§o de uma rede que gateia PR em segundos.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const WAHA_BASE = 'http://localhost:3030';

// A URL assinada do Storage Ã© montada com o admin client; ele valida env no
// import, e o desfecho de mÃ­dia precisa controlar sucesso E falha da assinatura.
const signedUrl = vi.fn<() => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>>(
  async () => ({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null }),
);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: signedUrl }) } }),
}));
// Audit Ã© fire-and-forget e escreve em outra tabela; fora do escopo dos desfechos.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;

interface ConversationShape {
  isGroup?: boolean;
  groupChatId?: string | null;
  phoneNumber?: string | null;
  waIdentity?: string | null;
  isBlocked?: boolean;
  sessionStatus?: string | null;
  provider?: string;
  /** Canal excluÃ­do pelo usuÃ¡rio (migration 0106) â€” a linha sobrevive, o canal nÃ£o. */
  archivedAt?: string | null;
  /** ID do phone number (Meta Cloud) â€” quando o provider Ã© meta_cloud. */
  metaPhoneNumberId?: string;
}

function conversationRow(shape: ConversationShape = {}): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: shape.isGroup ?? false,
    group_chat_id: shape.groupChatId ?? null,
    contacts: {
      phone_number: shape.phoneNumber === undefined ? '+5531999998888' : shape.phoneNumber,
      wa_identity: shape.waIdentity ?? null,
      is_blocked: shape.isBlocked ?? false,
    },
    channel_sessions:
      shape.sessionStatus === null
        ? null
        : {
            // `provider` sai do banco desde a migration 0087 â€” o handler nÃ£o
            // supÃµe mais o canal, entÃ£o a linha falsa tambÃ©m nÃ£o pode supor.
            provider: shape.provider ?? 'waha',
            waha_session_name: shape.provider === 'meta_cloud' ? null : 'test-session',
            meta_phone_number_id:
              shape.provider === 'meta_cloud' ? shape.metaPhoneNumberId ?? '1103328999528818' : null,
            status: shape.sessionStatus ?? 'WORKING',
            archived_at: shape.archivedAt ?? null,
          },
  };
}

/**
 * Fake de `SupabaseClient` com o mÃ­nimo que o handler encadeia:
 *   conversations: select().eq().maybeSingle() Â· update().eq()
 *   messages:      insert().select().single() Â· update().eq().select().maybeSingle()
 *   rpc('emit_event')
 * O update Ã© merge raso â€” igual ao que o Postgres faz com um SET de colunas.
 */
function makeSupabase(
  conversation: Row,
  templateRow: Row | null = null,
  /** `semColunaArquivada`: banco em que a migration 0106 ainda nÃ£o rodou. */
  opts: { semColunaArquivada?: boolean } = {},
) {
  const state: { message: Row | null } = { message: null };

  const client = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: (cols?: string) => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.semColunaArquivada === true && (cols ?? '').includes('archived_at')
                  ? {
                      data: null,
                      error: {
                        code: '42703',
                        message: 'column channel_sessions_1.archived_at does not exist',
                      },
                    }
                  : { data: conversation, error: null },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'meta_templates') {
        // O espelho local do template. `templateRow` Ã© injetado por caso; null
        // simula template que nÃ£o existe (ou WABA errada).
        //
        // A cadeia Ã© ENCADEÃVEL SEM LIMITE de propÃ³sito. A versÃ£o anterior tinha
        // exatamente trÃªs `eq` aninhados, e isso fazia o dublÃª ditar quantos
        // filtros o cÃ³digo de produÃ§Ã£o podia usar: acrescentar um quarto (a
        // conexÃ£o dona da definiÃ§Ã£o, da 0144) quebrava com `q.eq is not a
        // function` â€” um vermelho que nÃ£o fala do comportamento sob teste e
        // manda quem lÃª procurar defeito onde nÃ£o hÃ¡.
        const cadeia: Record<string, unknown> = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: templateRow, error: null }),
        };
        return { select: () => cadeia };
      }
      if (table === 'messages') {
        return {
          insert: (row: Row) => {
            state.message = {
              id: 'msg-1',
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
            };
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            return {
              eq: () => ({
                select: () => ({ maybeSingle: async () => ({ data: { ...state.message }, error: null }) }),
              }),
            };
          },
        };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ error: null }),
  };

  return client as unknown as SupabaseClient;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };

function textInput(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return { conversation_id: CONV, type: 'text', body: 'oi', ...over } as SendMessageInput;
}

function wahaConfigured(configured: boolean) {
  vi.stubEnv('WAHA_API_BASE_URL', configured ? WAHA_BASE : '');
  vi.stubEnv('WAHA_API_KEY', configured ? 'hash123' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  signedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null });
});

describe('sendMessageHandler â€” os 6 desfechos do envio', () => {
  it('1. WAHA nÃ£o configurado: fica queued com queued_reason, nada sai pela rede', async () => {
    wahaConfigured(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
    expect(msg.external_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. sem destinatÃ¡rio resolvÃ­vel: failed/missing_phone_number', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('missing_phone_number');
    expect(msg.error_message).toBe('Contato sem telefone para envio WhatsApp.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3. sessÃ£o fora de WORKING: fica queued com channel_session_not_working', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ sessionStatus: 'SCAN_QR_CODE' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('channel_session_not_working');
    expect(msg.error_code).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Os desfechos 4 e 5 gravam a MESMA linha final. O que os separa Ã© o efeito
  // externo â€” por qual endpoint a mensagem saiu. Isso nÃ£o Ã© "sequÃªncia de
  // chamadas internas": Ã© o que de fato deixa o processo, e o refactor das
  // Tasks 4bâ€“4d tem que preservÃ¡-lo (o adapter WAHA fala com o mesmo WAHA).
  it('4. com media_storage_path: sent + external_id + ack 0, pelo endpoint de mÃ­dia', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ id: { _serialized: 'MEDIA1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('MEDIA1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${WAHA_BASE}/api/sendImage`);
  });

  it('5. texto puro: sent + external_id + ack 0, pelo endpoint de texto', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${WAHA_BASE}/api/sendText`);
    // Bug do 2026-09-04 (Paizzani â†’ autoresponder â†’ waha_422 'default' not exists):
    // o sessionRef NÃƒO pode mais ser 'default' (placeholder). `resolveSessionRef`
    // Ã© fail-closed em placeholders. Aqui validamos que a coluna real do provider
    // (waha_session_name) chega ao fio, nÃ£o um fallback silencioso.
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      session: string;
    };
    expect(body.session).toBe('test-session');
    expect(body.session).not.toBe('default');
  });

  it('6. envio lanÃ§a: failed/waha_error com a mensagem do erro', async () => {
    wahaConfigured(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    // WAHA client devolve `waha_<status>: <body>` (atÃ© 400 chars) â€” `waha_500: boom`
    // Ã© mais informativo do que sÃ³ `waha_500` e o dispatcher diferencia pelo prefixo.
    expect(msg.error_message).toContain('waha_500');
    expect(msg.external_id).toBeNull();
  });

  // Task 7: o fallback de `error_message` quando o throw NÃƒO Ã© um `Error`. O
  // valor vai para o banco, entÃ£o trocÃ¡-lo Ã© mudanÃ§a de comportamento â€” ele saiu
  // do literal no handler para `adapter.codes`, com o mesmo texto.
  it('6c. throw que nÃ£o Ã© Error: error_message vem de adapter.codes.unknownError', async () => {
    wahaConfigured(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'nao-sou-um-Error';
      }),
    );

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    expect(msg.error_message).toBe('waha_unknown');
  });

  // Task 6: o canal sai do banco (`channel_sessions.provider`, migration 0087) e
  // nÃ£o de um literal. Esta Ã© a sabotagem que reprova o retorno do `getAdapter("waha")`
  // fixo: com o literal de volta, a sessÃ£o enviaria pelo canal errado e o teste ficaria
  // vermelho por nÃ£o ter lanÃ§ado.
  //
  // âš ï¸ Este caso usava `meta_cloud` como "provider sem adapter". Na Fase 3b o adapter
  // da Meta nasceu, e ele deixou de servir â€” a rede pegou a mudanÃ§a, que Ã© o trabalho
  // dela. Trocado por um provider que NÃƒO existe: o que se testa aqui Ã© o fail-closed,
  // nÃ£o qual canal estÃ¡ pronto. Amarrar o caso a um canal especÃ­fico o faria expirar de
  // novo na prÃ³xima fase.
  it('7. o canal vem da sessÃ£o: provider desconhecido falha fechado, nÃ£o cai em nenhum canal', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendMessageHandler(
        makeSupabase(conversationRow({ provider: 'canal_inexistente' })),
        ctx,
        textInput(),
      ),
    ).rejects.toThrow(/unknown_channel_provider: canal_inexistente/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.skip('7b. sessão meta_cloud agora RESOLVE adapter — a Fase 3b o criou', async () => {
    // O par com o caso 7 Ã© o que dÃ¡ sentido aos dois: um prova que provider
    // desconhecido nÃ£o vaza para canal nenhum; este prova que o canal oficial
    // deixou de ser desconhecido.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.META' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' })),
      ctx,
      textInput(),
    );
    expect((msg as { status: string }).status).toBe('sent');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('6b. assinatura do Storage falha: failed/storage_sign_failed, nÃ£o waha_error', async () => {
    wahaConfigured(true);
    signedUrl.mockResolvedValue({ data: null, error: { message: 'no_object' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('storage_sign_failed');
    expect(msg.error_message).toContain('no_object');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A ORDEM entre os desfechos Ã© comportamento, nÃ£o detalhe: se o pre-check de
  // configuraÃ§Ã£o descer para depois da resoluÃ§Ã£o do destinatÃ¡rio, uma instalaÃ§Ã£o
  // sem WAHA passa a marcar a mensagem como `failed` em vez de deixÃ¡-la em fila.
  it('ordem: sem WAHA E sem telefone â†’ waha_not_configured, nunca missing_phone_number', async () => {
    wahaConfigured(false);
    vi.stubGlobal('fetch', vi.fn());

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
  });

  it('8. type=template envia pelo caminho do template e grava nome e idioma', async () => {
    // O ramo NOVO. Grava `template_name`/`template_language` porque o tipo sozinho
    // nÃ£o responde "qual template custou o quÃª" â€” e template Ã© cobrado por entrega.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.TPL' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), {
        name: 'pedido_confirmado',
        language: 'pt_BR',
        status: 'APPROVED',
        contract_hash: 'h',
        components: [{ type: 'BODY', text: 'Ola {{1}}' }],
      }),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'pedido_confirmado',
        template_language: 'pt_BR',
        template_values: { '1': 'Rafael' },
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; external_id: string; template_name: string };
    expect(linha.status).toBe('sent');
    expect(linha.external_id).toBe('wamid.TPL');
    expect(linha.template_name).toBe('pedido_confirmado');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('8b. template ausente do espelho FALHA, nÃ£o envia Ã s cegas', async () => {
    // Sem esta guarda, um nome errado viraria 132000 na Meta â€” cobrado e tarde.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), null),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'nao_existe',
        template_language: 'pt_BR',
        template_values: {},
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; error_message: string };
    expect(linha.status).toBe('failed');
    expect(linha.error_message).toMatch(/template_missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * â­ A promessa do `comment on column` de 0100 ("nÃ£o Ã© mais elegÃ­vel para envio")
   * virando comportamento. `failed` e nÃ£o `queued` porque fila implica "sai depois",
   * e por este canal nÃ£o sai nunca: o nÃºmero jÃ¡ foi deslogado no transporte, e o
   * ledger do agente lÃª `queued` como algo a reconciliar mais tarde.
   */
  it('8. canal ARQUIVADO: failed/channel_archived, nada sai pela rede', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ archivedAt: '2026-08-05T10:00:00.000Z' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('channel_archived');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * â­ Este Ã© O caminho de saÃ­da do sistema (UI, automaÃ§Ã£o, MCP e agente passam
   * por aqui). Num clone que subiu o CÃ“DIGO sem aplicar a migration 0106 â€” cenÃ¡rio
   * medido neste projeto â€”, pedir `archived_at` direto derrubaria TODO envio com
   * 42703. Sem a coluna nada estÃ¡ arquivado, entÃ£o repetir sem ela Ã© o resultado
   * exato, nÃ£o um paliativo.
   */
  it('9. banco sem a coluna archived_at (migration nÃ£o aplicada): o envio segue normalmente', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT9' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow(), null, { semColunaArquivada: true }),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT9');
  });
});
