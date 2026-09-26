# Sarah — baseline e diagnóstico de estabilização (26/09/2026)

Esta baseline descreve **o código deste checkout**, não certifica a configuração publicada nem um pedido comercial na Athos. Nenhuma mensagem WhatsApp é disparada pelos testes.

## Configuração e fluxo observados

| Camada | Fonte verificável | Estado / limite |
| --- | --- | --- |
| Entrada oficial | `app/api/v1/webhooks/meta/[token]/route.ts`, `lib/channels/meta/webhook.ts` | Assinatura Meta validada antes de processar. O fluxo antigo WAHA ainda existe no produto, mas não é a origem presumida deste número. |
| Fila e identidade | `lib/agent-engine/edge/crm/drain.ts`, `lib/agent-engine/agent/inbound-turn.ts` | Evento inbound vira job; `job.id` é o identificador de execução dos logs e chamadas LLM. |
| Agente publicado | `lib/agent-engine/agent/resolve-turn-agent.ts` | Resolvido por versão publicada vinculada à sessão. Conteúdo exato do system prompt e versão **não foram lidos do ambiente ativo nesta baseline**. Não serão inventados nem alterados aqui. |
| Modelo e parâmetros | `lib/agent-engine/edge/llm/run-model-call.ts`, `inbound-turn.ts` | Provider/modelo/temperatura podem vir da versão publicada e da configuração da organização. O modelo efetivo do turno real deve ser auditado em `llm_calls` por `job_id`; o código local não comprova sozinho GPT-5 Mini em produção. |
| Ferramentas LLM | `inbound-turn.ts:AGENT_TOOL_DEFS` | Contexto do lead, template, busca, envio, estado/nota, handoff, follow-up, referência, caso. Bridge Athos é caminho determinístico **antes** do LLM, não uma ferramenta que o modelo executa. |
| Estado do pedido | `lib/foodservice/athos/order-state.ts`, `runtime-repository.ts` | Snapshot em `conversations.metadata.athos_order`; histórico limitado em `athos_order_history`; party size também em contato. Estados explícitos já existem. |
| Catálogo | `lib/foodservice/athos/athos-catalog.ts`, `runtime-repository.ts` | Produtos e preços vêm do catálogo mapeado; pode haver cache. ID externo deve existir antes de entrar no carrinho. |
| Pedido/CRM | `runtime-wiring.ts`, `order-adapter.ts`, `order-mirror.ts` | Confirmar chama adapter Athos e espelha em `orders` + `food_order_items`; testes locais usam adapter e banco simulados. Não equivalem a prova na Athos comercial. |
| Saída | `inbound-turn.ts`, `lib/agent-engine/guardrails/before-send.ts`, `lib/channels/adapters/meta-cloud.ts` | Bridge e LLM passam por guardrails e ledger antes do canal. Nenhum teste desta correção chama a Graph API. |
| Jobs/automação | `workers/agent-worker/main.ts`, `lib/agent-engine/cron/scheduler.ts` | Existem scheduler, follow-up e recovery; ativação efetiva das campanhas não foi alterada nem presumida. |

Fluxo relevante: Meta webhook → persistência inbound → drain/job (`job.id`) → resolução do agente/contexto → bridge Athos → snapshot + catálogo → seleção/confirmar → adapter Athos → espelho CRM → guardrails/ledger → Meta. Se o bridge não tratar, vai para prompt + LLM/ferramentas antes dos mesmos guardrails e envio. Este patch adiciona eventos `sarah_turn_stage` com `trace_id=job.id` para chegada ao bridge, resolução do tenant, decisão e resultado da cadeia de envio, sem corpo de mensagem. As demais etapas ainda dependem de logs/linhas existentes por `job_id`; não alegar trace completo de todas as camadas.

## BUG SARAH-ORDER-001

- **OBSERVED_BEHAVIOR:** “Quero fazer um novo pedido. Quero 2 tortas...” abria pedido vazio; após marcar retirada, Sarah pedia novamente o item e rejeitava a confirmação por carrinho vazio.
- **EXPECTED_BEHAVIOR:** iniciar pedido separado e registrar as duas unidades mapeadas no mesmo turno; preservar o carrinho nos turnos seguintes; não afirmar inclusão que não ocorreu.
- **REPRODUCED:** sim. Teste novo falhou com `expected [{quantity:2}], received []` antes da correção.
- **ROOT_CAUSE:** o ramo `EXPLICIT_NEW_ORDER_SIGNAL_RE` em `runtime-wiring.ts` retornava imediatamente depois de zerar o snapshot, sem interpretar a parte restante da mesma mensagem. O LLM podia, em turno posterior, falar sobre itens não persistidos.
- **LAYER:** `ORDER_STATE_ERROR` + `POST_PROCESSING_ERROR` como efeito secundário; **não** `PROMPT_ERROR`.
- **FILES_INVOLVED:** `lib/foodservice/athos/runtime-wiring.ts`, `tests/unit/athos-bridge-handler-integration.test.ts`.
- **PROMPT_INVOLVED:** não na causa primária; nenhum prompt foi editado.
- **STATE_BEFORE:** pedido anterior completo ou carrinho em andamento; novo snapshot inicializado com `cartItems=[]`.
- **STATE_AFTER (esperado):** novo snapshot `awaiting_confirmation`, produto mapeado e quantidade 2; pedido anterior preservado.
- **FIX:** após abrir o novo snapshot, resolver qualquer seleção de produto no trecho posterior ao sinal de novo pedido e persistir pelo mesmo caminho de seleção já existente; item desconhecido falha explicitamente.
- **TEST_CREATED:** multi-turno até confirmação (`novo pedido com produto` → `retirada` → `confirmo`), cenário de produto e retirada na mesma mensagem, além de 30 contratos golden de bridge com estado inicial, intenção, fronteira consultada, mutação, resposta e proibição de confirmação falsa.
- **TESTS_BEFORE:** 33/33 no recorte original; novo cenário reproduzido falhando (0/1).
- **TESTS_AFTER:** 180/180 em 15 arquivos relacionados, incluindo os 30 golden; typecheck aprovado. Regressão ampla: 290/290 arquivos unit/golden/api passaram em lotes controlados, com um teste previamente marcado como ignorado.
- **REGRESSIONS:** 0 nas suítes executadas.
- **STATUS:** corrigido **localmente**, não publicado nem validado em inbound real.

## Limites explícitos dos golden tests

Os 30 contratos (`MENU`, `CART`, `NEW`, `INFO`, `CONFIRM`, `PARTY`, `PICKUP`) executam o bridge determinístico com pool/adapter simulados e inspecionam estado a cada turno configurado. Eles não medem estilo da resposta gerada pelo GPT, venda consultiva, entrega Meta, nem escrita na Athos comercial. Para essa prova faltam uma suíte de conversação LLM controlada e um teste inbound do usuário **após** publicação. Não declarar “100%” com base nestes testes.

## GAP-TRACE-001 — rastreabilidade do bridge

- **OBSERVED_BEHAVIOR:** não havia evento de estágio que permitisse correlacionar decisão de carrinho e resultado do envio no mesmo turno.
- **EXPECTED_BEHAVIOR:** eventos estruturados ligados ao `job.id`, sem texto ou segredo do cliente.
- **REPRODUCED:** sim; teste de `trace_id` retornou lista vazia antes da alteração.
- **ROOT_CAUSE:** falta de instrumentação por estágio no bridge; logs existentes de `job_id` não descreviam a decisão de carrinho.
- **LAYER:** `CONTEXT_ERROR` de observabilidade, não prompt.
- **FILES_INVOLVED:** `athos-bridge-handler.ts`, `inbound-turn.ts`, `athos-bridge-handler-integration.test.ts`.
- **PROMPT_INVOLVED:** não; nenhum prompt alterado.
- **STATE_BEFORE:** estado de pedido inalterado; eventos de estágio ausentes.
- **STATE_AFTER:** estado de pedido inalterado; eventos de estágio presentes com o mesmo `trace_id`.
- **FIX:** emitir chegada, tenant, decisão, falha fechada e resultado do envio; sem corpo de mensagem nos campos.
- **TEST_CREATED:** cenário que exige as etapas e verifica ausência de texto do cliente nos campos.
- **TESTS_BEFORE:** 0/1 no teste novo (etapas ausentes).
- **TESTS_AFTER:** 1/1 no teste novo; 180/180 no recorte e 290/290 arquivos na regressão ampla.
- **REGRESSIONS:** 0 nas suítes executadas.
- **STATUS:** instrumentação local, não publicada. Logs das demais etapas ainda não estão padronizados.
