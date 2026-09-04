/**
 * De onde sai o identificador da sessão/número no provider.
 *
 * Esta é a pergunta que NÃO pode viver numa feature: com dois providers o
 * `sessionRef` vem de `waha_session_name` **ou** de `meta_phone_number_id`, e
 * quem escolher isso fora daqui vira o `if (provider === ...)` que o invariante
 * 1 da doutrina existe para proibir. O chamador pede o ref; a coluna é detalhe.
 *
 * O tipo é a tagged union que a migration 0087 já enforça no banco
 * (`channel_sessions_provider_ref_check`): a coluna do provider da vez é NOT
 * NULL, a do outro é NULL. Por isso o retorno é `string`, não `string | null` —
 * a garantia é do CHECK, não de otimismo.
 */
export type ChannelSessionRef =
  | { provider: "waha"; waha_session_name: string }
  | { provider: "meta_cloud"; meta_phone_number_id: string }
  | { provider: "zernio"; zernio_account_id: string };

/**
 * Colunas que um `select` do PostgREST precisa trazer para `resolveSessionRef`
 * funcionar. Fica aqui pelo mesmo motivo da função: a string do `select` também
 * nomeia coluna de provider, e ela some da feature junto com a decisão.
 */
export const CHANNEL_SESSION_REF_COLUMNS =
  "provider, waha_session_name, meta_phone_number_id, zernio_account_id";

/**
 * Valores do sessionRef que SÃO placeholders óbvios — nunca devem chegar à
 * rede. Bug do 2026-09-04: WAHA retornou `Session "default" does not exist`
 * porque o `c.channel_sessions.waha_session_name` tinha sido gravado como
 * `"default"` em algum caminho. A correção tem DOIS lados:
 *   1. Garantir que a sessão resolve para o id REAL (este arquivo: fail
 *      closed em `resolveSessionRef`).
 *   2. Impedir que a conversa seja criada/atualizada com um placeholder —
 *      isso é tratado pelos chamadores (ingest) que têm o nome real do
 *      WAHA que recebeu o webhook.
 */
const SESSION_REF_PLACEHOLDERS = new Set([
  "default",
  "DEFAULT",
  "",
  " ",
  "null",
  "undefined",
]);

export class ChannelSessionUnresolvedError extends Error {
  readonly name = "ChannelSessionUnresolvedError";
  readonly provider: string;
  readonly attemptedRef: string;
  constructor(provider: string, attemptedRef: string) {
    super(
      `channel_session_unresolved: provider=${provider} ref="${attemptedRef}" — ` +
        `sessão WAHA/Meta/Zernio ausente, vazia ou placeholder. ` +
        `fail closed: o envio NUNCA prossegue com "default" / vazio.`,
    );
    this.provider = provider;
    this.attemptedRef = attemptedRef;
  }
}

export function resolveSessionRef(session: ChannelSessionRef): string {
  let ref: string;
  switch (session.provider) {
    case "meta_cloud":
      ref = session.meta_phone_number_id;
      break;
    case "waha":
      ref = session.waha_session_name;
      break;
    // O `accountId` que o provider devolve ao conectar a WABA. NÃO é o
    // phone_number_id da Meta: quem intermedeia guarda o número por dentro e
    // endereça pelo id dele. Mandar o id da Meta aqui responde 404.
    case "zernio":
      ref = session.zernio_account_id;
      break;
  }
  // Fail closed: NUNCA mandar placeholder para o WAHA. O WAHA aceita o nome e
  // devolve 422 — o que significa que a sessão não foi encontrada — mas
  // devolver 422 deixa o lead em silêncio. Melhor errar alto aqui e deixar o
  // chamador decidir (cancelar / re-rotear / alertar).
  //
  // A regra se aplica SÓ a WAHA. Meta Cloud e Zernio carregam credenciais no
  // próprio adapter (resolveMetaCreds / credenciais por sessão) e o ref
  // vazio não é estado inválido: cai no fallback de env. Fail-closed ali
  // quebraria a Fase 3b sem motivo — o adapter já tem a própria defesa.
  if (session.provider === "waha") {
    const trimmedRef = (ref ?? "").trim();
    if (trimmedRef === "" || SESSION_REF_PLACEHOLDERS.has(trimmedRef)) {
      throw new ChannelSessionUnresolvedError(session.provider, ref ?? "");
    }
    return trimmedRef;
  }
  // Meta Cloud / Zernio: o adapter resolve creds e, se preciso, fallback de env.
  // Não fazemos fail-closed aqui; o adapter é quem decide o que conta como
  // "sessão não configurada".
  return (ref ?? "").trim();
}
