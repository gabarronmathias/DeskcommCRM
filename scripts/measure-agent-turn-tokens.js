/* eslint-disable */
// Estimativa do BREAKDOWN de tokens do agent_turn (briefing latência Sarah
// 2026-09-12, achado 3) — Tortas do Calmon, "somos em 6 pessoas".
//
// FONTE: heurística `countPayloadTokens` (chars / 3.5) que é A MESMA que o
// runtime usa em `lib/agent-engine/edge/crm/get-lead-context.ts:22`. O total
// calculado aqui DEVE bater com a faixa de inputTokens que o briefing mediu
// (~15.881) — se bater, a estimativa é fiel ao runtime; se não bater, há
// blocos não contabilizados (provavelmente org memory grande + skill bodies
// matched, não só o índice).
//
// ⚠️ Esta estimativa SUBSTITUI medição real em produção (Thailer proibiu
// instrumentação de runtime). A planilha de números é referência pra
// dimensionar o FAST_CONTEXT_PROFILE, não auditoria.
//
// Execução: `node scripts/measure-agent-turn-tokens.js`

const fs = require('fs');
const path = require('path');

const CHARS_PER_TOKEN = 3.5; // mesma constante de countPayloadTokens
const tok = (s) => Math.ceil((s || '').length / CHARS_PER_TOKEN);

// === 1. PLATFORM (camada fixa) ===
const platformPath = path.join(__dirname, '..', 'lib', 'agent-engine', 'playbooks', 'platform.md');
const platform = fs.existsSync(platformPath) ? fs.readFileSync(platformPath, 'utf8') : '';
console.log('=== PLATFORM (seed em git, versão ativa é maior no DB) ===');
console.log('  chars:', platform.length, ' ~tokens:', tok(platform));

// === 2. TENANT (system_prompt publicado do agente — Tortas do Calmon) ===
// ANTIGO (simulado pelo briefing: "Posso te ajudar?", "Quer que eu sugira?",
// instruções passivas que conflitam com platform).
const tenantOld = `# Sarah — Atendimento Tortas do Calmon

## Identidade
Você é a Sarah, atendente virtual da Tortas do Calmon, especializada em tortas artesanais, bolos de festa, doces e salgados para entrega na região.

## Como conversar
- Posso te ajudar com qualquer dúvida sobre nosso cardápio?
- Quer que eu sugira algumas opções de bolo?
- Se quiser, posso te enviar o link do nosso cardápio completo.
- Em que posso te ajudar hoje?
- Como posso te auxiliar nessa escolha?
- Me conta um pouco mais sobre o que você precisa.

## Cardápio
Trabalhamos com tortas de vários sabores: chocolate, morango, leite ninho, napolitano, prestigio, floresta negra. Bolos de festa sob encomenda com 48h de antecedência. Doces (brigadeiro, beijinho, cajuzinho) para festas. Salgados (coxinha, pastel, empada) para eventos.

## Horário e entregas
Atendemos de terça a sábado das 8h às 19h. Entregas no mesmo dia para pedidos até 14h. Frete grátis para pedidos acima de R$ 150.

## Política de pagamento
Aceitamos Pix, cartão de crédito e débito. Parcelamos em até 3x sem juros.

## Como fechar pedido
Quer que eu te ajude a montar o pedido? Me diga quantas pessoas, sabor preferido e data que precisa.`;
console.log('=== TENANT (Sarah — ANTIGO com linguagem passiva) ===');
console.log('  chars:', tenantOld.length, ' ~tokens:', tok(tenantOld));

// === 3. TENANT LIMPO (proposta, briefing achado 2) ===
const tenantNew = `# Sarah — Atendimento Tortas do Calmon

## Identidade
Sarah, atendente virtual da Tortas do Calmon — tortas artesanais, bolos de festa, doces e salgados com entrega na região.

## Regra de ouro (vinda da camada platform)
- NÃO peça permissão para vender. Em vez de "Posso te ajudar?", identifique o momento do cliente e conduza para o pedido.
- NÃO repita o link do cardápio turno após turno. Envie uma vez e prossiga.
- NÃO repita perguntas já respondidas (party size, sabor, data).
- Condução comercial turn 2+: cumprimente + apresente próximo passo concreto, não pergunte "Posso te ajudar?" de novo.

## Cardápio (use quando perguntarem)
Tortas (chocolate, morango, leite ninho, napolitano, prestigio, floresta negra). Bolos de festa sob encomenda — 48h de antecedência. Doces (brigadeiro, beijinho, cajuzinho). Salgados (coxinha, pastel, empada) para eventos.

## Prazos e entrega
- Pedidos até 14h saem no mesmo dia; depois disso, no dia seguinte.
- Frete grátis acima de R$ 150.

## Pagamento
Pix, crédito, débito. Parcela em até 3x sem juros.

## Handoff
Quando o cliente pedir algo fora do cardápio, tiver dúvida técnica não respondida, ou pedir para falar com humano, abra handoff humano.`;
console.log('=== TENANT (Sarah — LIMPO, sem linguagem passiva) ===');
console.log('  chars:', tenantNew.length, ' ~tokens:', tok(tenantNew));

// === 4. CAMPAIGN (estimativa; sem DB) ===
// Tortas do Calmon provavelmente tem campaign curta ou vazia. Vou assumir 600 chars.
const campaign = `# Campanha ativa: captação de pedidos para festas de fim de semana

## Oferta
Frete grátis para São José dos Campos e Jacareí acima de R$ 150. Válido até domingo.

## Próximo passo
Confirmar sabor + data + endereço de entrega.`;
console.log('=== CAMPAIGN (estimado; pode ser vazio) ===');
console.log('  chars:', campaign.length, ' ~tokens:', tok(campaign));

// === 5. ORG MEMORY (sem DB; pode ser vazio ou ter entries curadas) ===
const orgMemory = `# Aprendizados da organização

- party_size já respondida não perguntar de novo
- recusa explícita → encerrar com cordialidade, sem nova oferta
- pedido confirmado → abrir follow-up 30min antes da entrega`;
console.log('=== ORG MEMORY (3 entries curadas, estimado) ===');
console.log('  chars:', orgMemory.length, ' ~tokens:', tok(orgMemory));

// === 6. SKILL INDEX (estimado — Sarah pode ter 5-10 skills) ===
const skillIndex = `# Skills disponíveis

- saudacao-abertura: cumprimento inicial + identificação do momento
- cardapio-detalhes: lista sabores, preços e prazos de tortas/bolos
- fechamento-pedido: conduz até confirmar sabor + data + endereço
- follow-up-pre-entrega: confirma entrega 30min antes
- handoff-humano: transfere para humano quando apropriado`;
console.log('=== SKILL INDEX (5 skills, estimado) ===');
console.log('  chars:', skillIndex.length, ' ~tokens:', tok(skillIndex));

// === 7. LEAD CONTEXT (history_message_window: 24) ===
const leadContext24 = JSON.stringify({
  lead_id: 'lead-tortas-001',
  contact: {
    name: 'Maria Silva',
    phone: '+5511988887777',
    email: null,
    tags: ['cliente-recorrente', 'festa'],
    is_blocked: false,
  },
  conversation_id: 'conv-001',
  last_human_decision: null,
  messages: Array.from({ length: 24 }).map((_, i) => ({
    direction: i % 2 === 0 ? 'inbound' : 'outbound',
    body: 'Mensagem típica da conversa '.repeat(8), // ~184 chars por mensagem
    sent_at: `2026-09-12T${10 + Math.floor(i / 2)}:${(i * 5) % 60}:00Z`,
  })),
});
console.log('=== LEAD CONTEXT (history=24 messages) ===');
console.log('  chars:', leadContext24.length, ' ~tokens:', tok(leadContext24));

// === 8. LEAD CONTEXT FAST (history=8 messages) ===
const leadContext8 = JSON.stringify({
  lead_id: 'lead-tortas-001',
  contact: {
    name: 'Maria Silva',
    phone: '+5511988887777',
    email: null,
    tags: ['cliente-recorrente', 'festa'],
    is_blocked: false,
  },
  conversation_id: 'conv-001',
  last_human_decision: null,
  messages: Array.from({ length: 8 }).map((_, i) => ({
    direction: i % 2 === 0 ? 'inbound' : 'outbound',
    body: 'Mensagem típica da conversa '.repeat(8),
    sent_at: `2026-09-12T${12 + Math.floor(i / 2)}:${(i * 5) % 60}:00Z`,
  })),
});
console.log('=== LEAD CONTEXT FAST (history=8 messages) ===');
console.log('  chars:', leadContext8.length, ' ~tokens:', tok(leadContext8));

// === 9. TOOL SCHEMAS ===
const toolsFull = [
  { name: 'search_knowledge', desc: 'Busca na base de conhecimento (RAG)', schema: 'x'.repeat(800) },
  { name: 'send_message', desc: 'Envia mensagem WhatsApp', schema: 'x'.repeat(1200) },
  { name: 'schedule_followup', desc: 'Agenda follow-up', schema: 'x'.repeat(900) },
  { name: 'request_human_handoff', desc: 'Aciona handoff humano', schema: 'x'.repeat(700) },
  { name: 'update_lead_state', desc: 'Atualiza estado do lead', schema: 'x'.repeat(600) },
  { name: 'read_skill_reference', desc: 'Lê referência de skill', schema: 'x'.repeat(500) },
  { name: 'update_lead_property', desc: 'Atualiza propriedade do lead', schema: 'x'.repeat(550) },
];
const toolsFullJson = JSON.stringify(toolsFull);
console.log('=== TOOL SCHEMAS (7 tools ativas) ===');
console.log('  chars:', toolsFullJson.length, ' ~tokens:', tok(toolsFullJson));

// Tools FAST — só essenciais pra foodservice simples
const toolsFast = [
  { name: 'search_knowledge', desc: 'Busca na base de conhecimento (RAG)', schema: 'x'.repeat(800) },
  { name: 'send_message', desc: 'Envia mensagem WhatsApp', schema: 'x'.repeat(1200) },
  { name: 'schedule_followup', desc: 'Agenda follow-up', schema: 'x'.repeat(900) },
];
const toolsFastJson = JSON.stringify(toolsFast);
console.log('=== TOOLS FAST (3 essenciais) ===');
console.log('  chars:', toolsFastJson.length, ' ~tokens:', tok(toolsFastJson));

// === TOTAIS ===
const platformAtivo = tok(platform) * 3; // versão ativa no DB provavelmente é 3x o seed
const totalAtual =
  platformAtivo +
  tok(tenantOld) +
  tok(campaign) +
  tok(orgMemory) +
  tok(skillIndex) +
  tok(leadContext24) +
  tok(toolsFullJson) +
  800; // outros blocos (system wrapper, headers, format blocks)
console.log('\n=== TOTAL ATUAL (estimativa, briefing ~15.881) ===', totalAtual);

const totalFast =
  600 + // platform trimado p/ essencial
  tok(tenantNew) +
  0 + // campaign omitida (zero)
  tok(orgMemory) +
  0 + // skill index só sob demanda (zero)
  tok(leadContext8) +
  tok(toolsFastJson) +
  400; // outros blocos reduzidos
console.log('=== TOTAL FAST_CONTEXT_PROFILE (meta ≤5k) ===', totalFast);

console.log('\n=== FAST_CONTEXT_PROFILE (proposta) ===');
console.log('history_message_window: 24 → 8');
console.log('history_token_window: 8000 → 2000');
console.log('tools: 7 → 3 (search_knowledge + send_message + schedule_followup)');
console.log('platform: trim para essencial (sem re-explicar regras que viraram hook)');
console.log('tenant: limpar linguagem passiva (achado 2)');
console.log('campaign: omitir (zero) — Sarah comercial não precisa de campanha sempre');
console.log('skill index: omitir do prefixo (bodies matched sob demanda)');
console.log('org memory: manter só se curado (≤1k tokens)');
