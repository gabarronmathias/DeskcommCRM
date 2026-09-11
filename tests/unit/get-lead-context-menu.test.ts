import { describe, expect, it } from 'vitest';

import {
  buildMenuReply,
  ensureMenuUrl,
  hasPendingMenuRequest,
  isMenuRequest,
} from '@/lib/agent-engine/edge/crm/menu-context';
import { getLeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';

const MENU_URL = 'https://cardapio.sistemaathos.com.br/tortasdocalmon';
const MENU = { provider: 'athos' as const, store_ref: 'store-calmon', menu_url: MENU_URL };

function dbFalso(menuRows: unknown[]) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  return {
    chamadas,
    query: async (sql: string, params: unknown[]) => {
      chamadas.push({ sql, params });
      if (sql.includes('from contacts')) {
        return {
          rows: [{
            name: 'Cliente', display_name: null, email: null, phone_number: '+5511999999999',
            tags: [], is_blocked: false, source: 'whatsapp', consent: null, is_anonymized: false,
          }],
        };
      }
      if (sql.includes('from athos_sandbox_tenant_bindings')) return { rows: menuRows };
      return { rows: [] };
    },
  };
}

describe('cardápio Athos no contexto da Sarah', () => {
  it('passa ao contexto o URL oficial da conexão vinculada ao tenant', async () => {
    const fake = dbFalso([{ store_ref: MENU.store_ref, menu_url: MENU.menu_url }]);
    const result = await getLeadContext(
      fake as never,
      {} as never,
      { tenantId: 'org-calmon', leadId: 'contact-1' },
      { historyLimit: 20, maxTokens: 1_000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.menu).toEqual(MENU);
    const lookup = fake.chamadas.find((call) => call.sql.includes('from athos_sandbox_tenant_bindings'));
    expect(lookup?.params).toEqual(['org-calmon']);
    expect(lookup?.sql).toContain('b.organization_id = $1');
  });

  it('não inventa URL quando a fonte está ausente ou inválida', async () => {
    const missing = await getLeadContext(
      dbFalso([]) as never,
      {} as never,
      { tenantId: 'org-calmon', leadId: 'contact-1' },
      { historyLimit: 20, maxTokens: 1_000 },
    );
    expect(missing.ok && missing.context.menu).toBeNull();

    const invalid = await getLeadContext(
      dbFalso([{ store_ref: MENU.store_ref, menu_url: 'http://exemplo.invalid/menu' }]) as never,
      {} as never,
      { tenantId: 'org-calmon', leadId: 'contact-1' },
      { historyLimit: 20, maxTokens: 1_000 },
    );
    expect(invalid.ok && invalid.context.menu).toBeNull();
  });
});

describe('garantia do link no envio', () => {
  it('reconhece pedido explícito em português', () => {
    expect(isMenuRequest('Oi, vocês podem me mandar o cardápio?')).toBe(true);
    expect(isMenuRequest('Gostaria de fazer um pedido.')).toBe(true);
    expect(isMenuRequest('Quero cancelar meu pedido')).toBe(false);
    expect(isMenuRequest('Obrigado, vou pensar')).toBe(false);
  });

  it('anexa o mesmo URL oficial e não duplica o link', () => {
    expect(ensureMenuUrl('Claro, já te mando.', MENU, true)).toBe(
      `Olá! Eu sou a Sarah, da Tortas do Calmon.\n\nAbaixo está o nosso cardápio digital. Nele você pode conhecer todas as nossas delícias e fazer seu pedido:\n${MENU_URL}`,
    );
    expect(ensureMenuUrl(`Aqui está: ${MENU_URL}`, MENU, true)).toBe(`Aqui está: ${MENU_URL}`);
    expect(ensureMenuUrl('Posso ajudar em algo?', MENU, false)).toBe('Posso ajudar em algo?');
  });

  it('mantém um pedido sem link pendente após uma saudação posterior', () => {
    expect(hasPendingMenuRequest([
      { direction: 'inbound', body: 'Abra o cardápio' },
      { direction: 'outbound', body: 'Só um instante, já envio.' },
      { direction: 'inbound', body: 'Olá, boa noite' },
    ], MENU_URL)).toBe(true);
    expect(hasPendingMenuRequest([
      { direction: 'inbound', body: 'Abra o cardápio' },
      { direction: 'outbound', body: `Aqui está: ${MENU_URL}` },
      { direction: 'inbound', body: 'Olá, boa noite' },
    ], MENU_URL)).toBe(false);
  });

  it('monta a abertura completa da Tortas do Calmon', () => {
    expect(buildMenuReply(MENU_URL, 'Thailer')).toBe(
      `Olá, Thailer! Eu sou a Sarah, da Tortas do Calmon.\n\nAbaixo está o nosso cardápio digital. Nele você pode conhecer todas as nossas delícias e fazer seu pedido:\n${MENU_URL}`,
    );
  });
});
