/**
 * Fonte determinística do cardápio Athos.
 *
 * O URL não é montado pelo modelo nem duplicado no prompt: ele vem da conexão
 * Athos vinculada ao tenant ou da configuração de comércio já persistida no
 * CRM. Se nenhuma fonte estiver disponível, retornamos null e nunca fabricamos
 * um endereço.
 */
import type { Queryable } from '../../queue/queue';

export interface AthosMenuContext {
  provider: 'athos';
  store_ref: string;
  menu_url: string;
}

export interface MenuMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

interface AthosMenuRow {
  store_ref: string | null;
  menu_url: string | null;
}

interface CommerceMenuRow {
  menu_url: string | null;
  store_ref: string | null;
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/** Lê a URL oficial da conexão Athos ativa e vinculada à organização. */
export async function loadAthosMenuContext(
  db: Queryable,
  organizationId: string,
): Promise<AthosMenuContext | null> {
  let rows: AthosMenuRow[] = [];
  try {
    ({ rows } = await db.query<AthosMenuRow>(
      `select c.store_ref, c.menu_url
       from athos_sandbox_tenant_bindings b
       join athos_sandbox_connections c on c.id = b.connection_id
       where b.organization_id = $1
         and b.active = true
         and c.active = true
         and c.revoked_at is null
       order by b.updated_at desc
       limit 1`,
      [organizationId],
    ));
  } catch (error) {
    // The Athos PR9 schema is optional for non-Athos installations. Other
    // database failures remain visible and retryable; only a missing relation
    // means this tenant has no Athos capability installed yet.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')) {
      throw error;
    }
  }
  const row = rows[0];

  const linkedMenuUrl = validHttpsUrl(row?.menu_url);
  if (row && linkedMenuUrl && typeof row.store_ref === 'string' && row.store_ref.trim() !== '') {
    return { provider: 'athos', store_ref: row.store_ref, menu_url: linkedMenuUrl };
  }

  // The live CRM can be connected to the Athos sandbox without carrying the
  // sandbox receipt tables locally. In that deployment, food_commerce_settings
  // is the existing tenant-scoped source of the official menu URL.
  let commerceRows: CommerceMenuRow[];
  try {
    ({ rows: commerceRows } = await db.query<CommerceMenuRow>(
      `select settings ->> 'athos_menu_url' as menu_url,
              settings ->> 'athos_store_ref' as store_ref
       from food_commerce_settings
       where organization_id = $1
         and is_enabled = true
       order by updated_at desc
       limit 1`,
      [organizationId],
    ));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01') return null;
    throw error;
  }
  const commerceRow = commerceRows[0];
  const commerceMenuUrl = validHttpsUrl(commerceRow?.menu_url);
  if (!commerceMenuUrl) return null;
  return {
    provider: 'athos',
    store_ref: commerceRow?.store_ref?.trim() || 'tortas-do-calmon',
    menu_url: commerceMenuUrl,
  };
}

/** Sinal explícito de que o inbound pede o cardápio/opções para fazer pedido. */
export function isMenuRequest(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/\b(cardapio|menu|opcoes)\b/.test(normalized)) return true;
  return /\b(?:quero|gostaria de|posso|pode me|vou)\s+(?:fazer|realizar|montar|pedir)\b/.test(normalized);
}

/** Mantém o pedido pendente até o URL oficial ser realmente enviado. */
export function hasPendingMenuRequest(messages: MenuMessage[], menuUrl: string | null | undefined): boolean {
  if (!menuUrl) return false;
  let pending = false;
  for (const message of messages) {
    if (message.direction === 'inbound' && isMenuRequest(message.body)) pending = true;
    if (message.direction === 'outbound' && message.body.includes(menuUrl)) pending = false;
  }
  return pending;
}

/** Resposta inicial estável: não promete um link para uma mensagem futura. */
export function buildMenuReply(menuUrl: string, contactName?: string | null): string {
  const greeting = contactName?.trim() ? `Olá, ${contactName.trim()}!` : 'Olá!';
  return `${greeting} Eu sou a Sarah, da Tortas do Calmon.\n\nAbaixo está o nosso cardápio digital. Nele você pode conhecer todas as nossas delícias e fazer seu pedido:\n${menuUrl}`;
}

/** Garante o link oficial em um envio que responde a um pedido explícito de menu. */
export function ensureMenuUrl(
  body: string,
  context: AthosMenuContext | null | undefined,
  menuRequested: boolean,
): string {
  if (!menuRequested || !context || body.includes(context.menu_url)) return body;
  return buildMenuReply(context.menu_url);
}
