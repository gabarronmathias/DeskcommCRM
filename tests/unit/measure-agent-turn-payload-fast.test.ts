/**
 * Prova real de tokens (BLOCO 3, modo encerramento 2026-09-13).
 *
 * Monta o payload efetivamente entregue ao agent_turn usando as FUNÇÕES REAIS do
 * runtime (composePlaybook + composeSystemPrompt + countPayloadTokens), com
 * AGENT_FAST_CONTEXT_PROFILE=true (historyLimit=8, maxTokens=600).
 *
 * Cenário: "somos em 6 pessoas" (turno simples, lead com party size já capturada).
 *
 * Critério: tokens_total <= 5000.
 *
 * Execução: `npx vitest run tests/unit/measure-agent-turn-payload-fast.test.ts`
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { composePlaybook } from '../../lib/agent-engine/agent/playbook';
import { composeSystemPrompt } from '../../lib/agent-engine/agent/org-memory';
import { countPayloadTokens } from '../../lib/agent-engine/edge/crm/get-lead-context';

const ROOT = resolve(__dirname, '..', '..');
const platformMd = readFileSync(resolve(ROOT, 'lib/agent-engine/playbooks/platform.md'), 'utf8');
const tenantDraft = readFileSync(
  resolve(ROOT, 'docs/drafts/tortas-do-calmon-system-prompt.clean.md'),
  'utf8',
);
// Extrai apenas o bloco "## system_prompt (versão LIMPA proposta)" do draft
const tenantClean = (() => {
  const match = tenantDraft.match(/## system_prompt \(versão LIMPA proposta\)\n+```\n([\s\S]*?)\n```/);
  return match !== null ? match[1] : tenantDraft;
})();

describe('measure-agent-turn-payload (BLOCO 3) — AGENT_FAST_CONTEXT_PROFILE=true', () => {
  it('"somos em 6 pessoas" → tokens_total <= 5000', () => {
    // === Componentes canônicos do runtime ===
    const playbookPrompt = composePlaybook([
      { layer: 'platform', content: platformMd },
      { layer: 'tenant', content: tenantClean },
    ]);

    const orgMemoryBlock = ''; // Tortas do Calmon sem memória curada (default)
    const skillIndex = ''; // fast profile: skill index omitido do prefixo

    const systemPrompt = composeSystemPrompt({
      playbookPrompt,
      orgMemoryBlock,
      skillIndex,
    });

    // Lead context (FAST profile): history=8 messages com cap de 600 tokens
    const history = Array.from({ length: 8 }, (_, i) => ({
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      body: i === 0
        ? 'somos em 6 pessoas'
        : i === 7
          ? 'Que ótimo! Para 6 pessoas recomendo nosso bolo de chocolate 1.5kg. Posso separar? Me passa a data que precisa.'
          : i % 2 === 0
            ? 'Oi, tudo bem? Vocês entregam para São José dos Campos?'
            : 'Claro! Atendemos São José dos Campos. Para onde seria a entrega?',
      sent_at: `2026-09-12T${10 + Math.floor(i / 2)}:${(i * 5) % 60}:00Z`,
    }));
    const leadContext = {
      lead_id: 'lead-tortas-001',
      contact: {
        name: 'Maria Silva',
        phone: '+5511988887777',
        tags: ['cliente-recorrente', 'festa'],
      },
      conversation_id: 'conv-001',
      messages: history,
    };
    const leadContextStr = JSON.stringify(leadContext);

    // Tools FAST (3 essenciais — fast profile gating)
    const toolsFast = [
      {
        name: 'search_knowledge',
        description: 'Busca na base de conhecimento (RAG) do tenant.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'termo de busca' } },
          required: ['query'],
        },
      },
      {
        name: 'send_message',
        description: 'Envia mensagem WhatsApp ao lead. Corpo final após gate before_send.',
        parameters: {
          type: 'object',
          properties: { body: { type: 'string', description: 'corpo da mensagem' } },
          required: ['body'],
        },
      },
      {
        name: 'schedule_followup',
        description: 'Agenda follow-up D+N dias no horário comercial.',
        parameters: {
          type: 'object',
          properties: {
            delay_hours: { type: 'number', description: 'horas até o envio' },
            body_hint: { type: 'string', description: 'rascunho da mensagem' },
          },
          required: ['delay_hours'],
        },
      },
    ];
    const toolsJson = JSON.stringify(toolsFast);

    // Mensagem inbound corrente
    const userMessage = 'somos em 6 pessoas';

    // === Montagem do payload agent_turn (formato messages[]) ===
    const agentTurnPayload = JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: '=== lead context ===\n' + leadContextStr },
        { role: 'user', content: userMessage },
      ],
      tools: toolsFast,
    });

    // === Breakdown por componente ===
    const tokensPlatform = countPayloadTokens(platformMd);
    const tokensTenant = countPayloadTokens(tenantClean);
    const tokensCampaign = 0; // não há campaign ativa para Tortas do Calmon
    const tokensOrgMemory = 0; // fast profile: sem org memory curada
    const tokensSkills = 0; // fast profile: omitido do prefixo
    const tokensHistory = countPayloadTokens(leadContextStr);
    const tokensTools = countPayloadTokens(toolsJson);
    const tokensUserMessage = countPayloadTokens(userMessage);
    const tokensSystemWrapper = countPayloadTokens('=== lead context ===\n') +
      countPayloadTokens('=== playbook:platform ===\n') * 2 +
      countPayloadTokens('=== playbook:tenant ===\n');

    const tokensTotal = countPayloadTokens(agentTurnPayload);

    console.log('\n=== AGENT_TURN PAYLOAD BREAKDOWN (AGENT_FAST_CONTEXT_PROFILE=true) ===');
    console.log(`  tokens_platform       = ${tokensPlatform}`);
    console.log(`  tokens_tenant         = ${tokensTenant}`);
    console.log(`  tokens_campaign       = ${tokensCampaign}`);
    console.log(`  tokens_org_memory     = ${tokensOrgMemory}`);
    console.log(`  tokens_skills         = ${tokensSkills}`);
    console.log(`  tokens_history        = ${tokensHistory}`);
    console.log(`  tokens_tools          = ${tokensTools}`);
    console.log(`  tokens_user_message   = ${tokensUserMessage}`);
    console.log(`  tokens_system_wrapper = ${tokensSystemWrapper}`);
    console.log(`  -----------------------------------`);
    console.log(`  tokens_total          = ${tokensTotal}`);
    console.log('=== CRITÉRIO: tokens_total <= 5000 ===\n');

    expect(tokensTotal).toBeLessThanOrEqual(5_000);
    // invariantes de cada bloco (sanidade)
    expect(tokensPlatform).toBeGreaterThan(0);
    expect(tokensTenant).toBeGreaterThan(0);
    expect(tokensHistory).toBeGreaterThan(0);
    expect(tokensTools).toBeGreaterThan(0);
  });
});
