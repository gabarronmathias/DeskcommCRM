/**
 * Bypass determinístico do classificador quando o router está ativo mas tem ZERO
 * membros (achado 1 do briefing de latência Sarah 2026-09-12). Por construção
 * `classifyIntent` não tem como casar uma intent em `router.members` vazio — a
 * chamada LLM só gastaria ~14.3s por turno e o turno cairia no fallback de
 * qualquer jeito (regra 5 do resolver). Resolver localmente:
 *   - com fallback declarado ⇒ outcome 'fallback', config do fallback;
 *   - sem fallback ⇒ outcome 'no_match' com config do agente publicado DA SESSÃO
 *     (não genérico — porta do fix 35eb014d, adaptada ao HEAD atual).
 *
 * Ver `lib/agent-engine/agent/resolve-turn-agent.ts` (regra 5b no header).
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from '../../lib/agent-engine/agent/resolve-turn-agent';
import type { PublishedAgentConfig } from '../../lib/agent-engine/agent/agent-config';
import type { LoadedRouter } from '../../lib/agent-engine/agent/router-config';

function fakeConfig(agentId: string): PublishedAgentConfig {
  return {
    agentId,
    versionId: `v-${agentId}`,
    agentName: agentId,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    splitMessages: false,
    splitMaxChars: 900,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    versionCreatedBy: null,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
  };
}

const baseInput = {
  tenantId: 'org-tortas',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
};

/**
 * Router ATIVO com zero membros — o cenário do bug medido em Tortas do Calmon.
 * Estado que a tela deixa criar em dois cliques (ligar router sem popular membros).
 */
function routerVazio(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-vazio',
    name: 'R',
    classifierModel: 'gpt-5-mini',
    classifierProvider: 'openai',
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members: [],
    ...overrides,
  };
}

/**
 * Router ATIVO com membros reais — sanity check pra garantir que o bypass NÃO
 * altera o comportamento no caminho normal.
 */
function routerComMembers(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-cheio',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members: [
      { agentId: 'agent-vendas', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
      { agentId: 'agent-suporte', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
    ],
    ...overrides,
  };
}

function _makeDeps(overrides: {
  loadActiveRouter?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfigById?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfig?: ReturnType<typeof vi.fn>;
  classifyIntent?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: overrides.loadActiveRouter ?? vi.fn(),
    loadPublishedAgentConfigById: overrides.loadPublishedAgentConfigById ?? vi.fn(),
    loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),
    classifyIntent: overrides.classifyIntent ?? vi.fn(),
  } as never;
}

describe('resolveTurnAgent — router vazio (achado 1)', () => {
  it('A. router ativo + 0 members + FALLBACK → zero classifyIntent, retorna fallback (config do fallback)', async () => {
    const r = routerVazio({ fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      fakeConfig(id));
    const loadPublishedAgentConfig = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'somos em 6 pessoas', stickyAgentId: null, stickyIntent: null },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig } as never);

    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
    expect(out.routerId).toBe('router-vazio');
    // log explícito pra telemetria
    expect(log.info).toHaveBeenCalledWith(
      'resolve-turn-agent: router_empty_members_bypass',
      expect.objectContaining({
        routerId: 'router-vazio',
        hasFallback: true,
        outcome: 'fallback',
      }),
    );
  });

  it('B. router ativo + 0 members + SEM fallback → zero classifyIntent, usa agente publicado DA SESSÃO (não genérico)', async () => {
    const r = routerVazio({ fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = vi.fn();
    const loadPublishedAgentConfig = vi.fn(async (_db: unknown, _org: unknown, _sess: unknown) =>
      fakeConfig('agent-publicado-da-sessao'));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'somos em 6 pessoas', stickyAgentId: null, stickyIntent: null },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig } as never);

    expect(classifyIntent).not.toHaveBeenCalled();
    // outcome continua sendo o que explica a ausência de match — 'no_match'
    expect(out.outcome).toBe('no_match');
    // MAS o config é o agente publicado DA SESSÃO, não null (regra 5 portada)
    expect(out.config?.agentId).toBe('agent-publicado-da-sessao');
    expect(out.routerId).toBe('router-vazio');
    expect(loadPublishedAgentConfig).toHaveBeenCalledWith({}, 'org-tortas', 'sess-1');
    expect(log.info).toHaveBeenCalledWith(
      'resolve-turn-agent: router_empty_members_bypass',
      expect.objectContaining({
        routerId: 'router-vazio',
        hasFallback: false,
        outcome: 'no_match',
      }),
    );
  });

  it('B2. router ativo + 0 members + SEM fallback + SEM agente publicado → config null + warn (genérico)', async () => {
    const r = routerVazio({ fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = vi.fn();
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(null);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'somos em 6 pessoas', stickyAgentId: null, stickyIntent: null },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig } as never);

    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('no_match');
    expect(out.config).toBeNull();
    // fim legítimo da linha — log.warn sinaliza
    expect(log.warn).toHaveBeenCalledWith(
      'resolve-turn-agent: router sem fallback e sessão sem agente publicado — turno cai no genérico',
      expect.objectContaining({ routerId: 'router-vazio', outcome: 'no_match' }),
    );
  });

  it('C. router COM members → comportamento atual intacto (NÃO aciona bypass, classifica normal)', async () => {
    const r = routerComMembers({ sticky: false });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      fakeConfig(id));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById } as never);

    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(log.info).not.toHaveBeenCalledWith(
      'resolve-turn-agent: router_empty_members_bypass',
      expect.anything(),
    );
  });

  it('D. sticky COM members → continua reclassificando (regra 2 do resolver)', async () => {
    const r = routerComMembers();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.85 });
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      fakeConfig(id));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'tenho um problema técnico', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById } as never);

    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
  });

  it('B3. router ativo + 0 members + FALLBACK declarado mas sem versão publicada → outcome no_match honesto (regra 7) com config null + warn', async () => {
    const r = routerVazio({ fallbackAgentId: 'agent-fallback-sem-versao' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(null); // fallback sem versão publicada
    const loadPublishedAgentConfig = vi.fn(async (_db: unknown, _org: unknown, _sess: unknown) =>
      fakeConfig('agent-publicado-da-sessao'));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'somos em 6 pessoas', stickyAgentId: null, stickyIntent: null },
      { log, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig } as never);

    expect(classifyIntent).not.toHaveBeenCalled();
    // outcome honesto: o bypass tentou fallback, falhou (regra 7) — 'no_match' em vez de mentir 'fallback'
    expect(out.outcome).toBe('no_match');
    // config null aqui pq o fallbackAgentId foi declarado mas sem versão — fim legítimo da linha
    expect(out.config).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'resolve-turn-agent: fallbackAgentId sem versão publicada — turno cai no genérico',
      expect.objectContaining({ routerId: 'router-vazio', fallbackAgentId: 'agent-fallback-sem-versao' }),
    );
  });
});

/**
 * Porta do fallback decente (35eb014d) no resolveFallback — quando um router
 * ATIVO com members classifica mas NÃO bate, e não há fallback declarado,
 * atende o agente publicado DA SESSÃO (não genérico).
 */
describe('resolveTurnAgent — fallback decente sem fallbackAgentId (regra 5 portada)', () => {
  it('classificou baixo + SEM fallback → outcome no_match mas config = agente da SESSÃO (não null)', async () => {
    const r = routerComMembers({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfigById = vi.fn();
    const loadPublishedAgentConfig = vi.fn(async (_db: unknown, _org: unknown, _sess: unknown) =>
      fakeConfig('agent-publicado-da-sessao'));

    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig } as never);

    expect(out.outcome).toBe('no_match');
    // regração 5 portada: o agente da SESSÃO atende, NÃO genérico
    expect(out.config?.agentId).toBe('agent-publicado-da-sessao');
    expect(loadPublishedAgentConfig).toHaveBeenCalledWith({}, 'org-tortas', 'sess-1');
  });
});
