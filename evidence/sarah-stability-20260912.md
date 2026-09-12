# Sarah — investigação de estabilidade (em andamento)

## Estado preservado

- Branch inicial: `feat/gm-branding-homologation`; HEAD `89f6d20`; git status limpo.
- Branch de investigação: `fix/sarah-stability-20260912`.
- App ativo confirmado no VPS: `deskcommcrm-app-1`, imagem `deskcomm-app:sarah-fix-bb2048a`.
- O helper `athos-test.ts` NÃO existe em `/opt/deskcommcrm/lib/waha/` após a tentativa interrompida. Não houve deploy confirmado do commit `89f6d20`.
- Checkout remoto tem alterações preexistentes. Não limpar/resetar nem usar como fonte implicitamente equivalente à imagem ativa.
- `origin/main` tem 4006 commits ausentes da branch local. Atualização geral não faz parte desta correção de incidente; manter mudança isolada e revisar integração separadamente.

## Evidências observadas

1. Logs do app ativo: `uniq_contacts_org_wa_lid` viola unicidade ao resolver contato; fallback consulta `contacts.waha_chat_id`, coluna inexistente. A exceção ocorre antes de enfileirar Sarah.
2. Logs registram `Gateway Timeout` no event-log drain, audit e watchers. Uma consulta direta, limitada a 10s, do app à configuração do cardápio respondeu HTTP 200 em 634ms. Não atribuir toda latência ao banco com base em uma amostra.
3. `deskcommcrm-worker-1` e `chopperia-worker-1` têm a mesma imagem (`sha256:e2881f0cd25b7dadcb6e69361759d838d164596a92d611c64a98763cc2f007cc`) e a mesma conexão de banco (comparada por hash, segredo não registrado).
4. Os workers estão em redes distintas: `deskcommcrm_internal` e `chopperia_internal`. Ambos usam `http://waha:3000`; há um WAHA distinto em cada rede. Consequência potencial: um job pode ser consumido pelo worker cujo WAHA não possui a sessão. Efeito ainda precisa de prova por job/sessão.
5. Jobs históricos do tenant alternam `done` com `dead`, estes após 5 tentativas com `Unsupported state or unable to authenticate data`. Verificar contrato de criptografia antes de atribuir a OpenAI.
6. O helper local anterior consulta `athos_store_ref` como coluna, porém o registro real armazena esse valor dentro de `settings`. Também não limita tenant e deduplica antes do sucesso, podendo perder retries.

## Fonte real do cardápio

- Projeto Supabase `oxvzqmyaocxqkqnjaosi`.
- Tabela `public.food_commerce_settings`, filtro `organization_id = 036bb1d5-2cb6-4346-9c19-3dbb1c0d0433`.
- `app_name = Tortas do Calmon`, `is_enabled = true`, `settings.environment = sandbox`.
- `settings.athos_menu_url = https://cardapio.sistemaathos.com.br/tortasdocalmon`.
- `settings.athos_store_ref = 5b7b4a38-4c54-488e-986f-9ea0428cff7a`.
- Sessão WORKING: `org_036bb1d5_fd766273bc0b`, id `15ed07d7-57f9-4746-a543-d8768003848b`.
- Sessão antiga FAILED: `org_036bb1d5`, id `65117eb8-b36c-45f8-baaf-dacb8ffc8cef`.

## Mapa de código (local; conferir divergências na imagem ativa)

WhatsApp → WAHA → rota `app/api/v1/webhooks/waha/[token]/route.ts` → token resolve `channel_sessions.organization_id` → HMAC → log de webhook → `lib/waha/ingest.ts:dispatchWahaEvent` → `handleInbound` → `fn_upsert_wa_contact` → `fn_upsert_wa_conversation` → INSERT messages → `emitInboundEvents` → `event_log:ai_agent.dispatch_requested` → `lib/agent-engine/edge/crm/drain.ts:drainTick` → `enqueueJob` em `job_queue:inbound_turn` → `workers/agent-worker/main.ts` → `createInboundTurnHandler` → `runAgentTurn` em `lib/agent-engine/agent/inbound-turn.ts`.

O agente carrega contexto/configuração e cardápio (`lib/agent-engine/edge/crm/menu-context.ts`), monta ferramentas e chama `runModelCall` (`edge/llm/run-model-call.ts`). A URL vem de bindings Athos ou de `food_commerce_settings.settings.athos_menu_url`. `send_message` passa por guardrails e pelo canal; `edge/crm/send-message.ts:sendTurnMessage` mantém `send_ledger` e chama `app/api/v1/messages/_handler.ts:sendMessageHandler`, que grava CRM e chama o cliente WAHA. Texto livre fora da ferramenta não é enviado pelo contrato do agente.

CRM é dependência tanto antes do agente quanto antes do outbound normal. Athos, para enviar cardápio, deve ser apenas leitura da URL já persistida; escrita/sincronização não precisa participar.

## Critérios pendentes

Instrumentação correlacionada; teste sem IA restrito à homologação; 100 entradas sequenciais; 20 conversas concorrentes; isolamento entre tenants; retries/duplicatas/timeout; comprovação real no WhatsApp. Teste simulado não equivale a entrega no celular. Não há aprovação para produção nem resultado 100/100 neste registro.
