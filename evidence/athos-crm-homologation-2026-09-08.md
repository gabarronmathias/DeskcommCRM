# Homologação Athos ↔ Sarah ↔ CRM — 2026-09-08

## Veredito

**BACKEND CRM VALIDADO — TESTE CONJUNTO PENDENTE**

A reconciliação Athos → CRM foi implementada, o tenant piloto foi provisionado e o roteiro E2E interno passou integralmente em 09/09/2026, sem alterar o contrato HTTP já entregue à Athos. O teste conjunto permanece pendente da criação do acesso humano ao tenant, da conexão controlada do WhatsApp e da confirmação de data e horário pela Athos.

## Superfícies

- CRM preview: `https://deskcomm-crm-git-feat-ath-f1ac1f-thailer-mathias-5234s-projects.vercel.app/`
- Athos sandbox: `https://ukenluaihqiuwtdssatc.supabase.co/functions/v1/athos-sandbox`
- Cardápio: `https://cardapio.sistemaathos.com.br/tortasdocalmon`
- Pull request: `https://github.com/gabarronmathias/DeskcommCRM/pull/9` (draft)
- Branch: `feat/athos-sandbox`

## Tenant piloto isolado

- Nome: `Athos Piloto — Tortas do Calmon`
- Slug: `athos-piloto-tortas-do-calmon`
- Organization ID: `d31a7319-c347-40f6-96f1-640353a97ae0`
- Channel session ID: `26b8e514-5f33-45b6-886b-56add1ef83b5`
- WAHA session: `org_d31a7319`
- Estado do canal: `STOPPED`
- Contato sintético: `3f77b76e-d174-4ab5-82f0-7cd81e4b67d6`
- Conversa sintética: `0543115e-5215-4e85-b736-77baeb664952`
- Launch ID: `d8a86b8f-7d36-4e6e-9dd1-8a9b1b8db8e1`

Nenhum telefone de cliente real foi usado. A Sarah foi criada como rascunho inativo para impedir mensagens antes da conexão controlada do WhatsApp.

## O que foi implementado

1. Binding explícito entre uma conexão sandbox Athos e um único tenant CRM.
2. RLS e revogação de acesso de `anon` e `authenticated` na tabela de binding.
3. Reconciliação de `athos_sandbox_orders` para `orders` canônica.
4. Preservação de contato, conversa, launch, origem Athos e tenant no pedido.
5. Upsert idempotente por `(organization_id, external_provider, external_id)`.
6. Proteção contra regressão por evento atrasado.
7. Rejeição de correlação fora do tenant vinculado.
8. Provisionador idempotente do tenant piloto.
9. Roteiro E2E repetível com dados sintéticos.

## Evidência observada

Na primeira execução após a correção da função no banco, passaram as verificações de:

- criação de um único pedido canônico;
- idempotência do evento duplicado;
- atualização do mesmo pedido para `preparing`;
- não regressão por evento atrasado;
- vínculo ao contato e à conversa corretos;
- ausência do pedido em outro tenant;
- RLS e revogações do binding;
- rejeição de status inválido;
- rejeição de correlação cross-tenant.

O roteiro foi corrigido para materializar o recibo sintético exato antes de executar a projeção. Isso impede que a ordem de avaliação de predicados do PostgreSQL tente reprojetar recibos antigos da Athos sem vínculo com o novo tenant piloto.

Em 09/09/2026, passaram as dez verificações do roteiro:

- binding restrito ao backend com RLS ativo;
- dois recibos processados;
- isolamento do pedido no tenant piloto;
- rejeição de correlação cross-tenant;
- proteção contra regressão por evento atrasado;
- idempotência de evento duplicado;
- rejeição de status inválido;
- preservação de contato, conversa e origem Athos;
- projeção única de `order.created`;
- atualização do mesmo pedido para `preparing`.

O pedido canônico sintético gerado nessa execução foi `90258bf6-fced-4ae0-90bf-157870b09fe4`.

## Arquivos

- `supabase/migrations/20260908090000_athos_crm_pilot_reconciliation.sql`
- `scripts/provision-athos-crm-pilot.sql`
- `scripts/verify-athos-crm-pilot.sql`

## Commits remotos confirmados

- `bdfc174759633c9d2b263ae71cffa07c5231734f` — projeção Athos → CRM
- `7ef51fe` — provisionador do tenant piloto
- `98e0154c2a52190411c36ee3ef075f496bbd793b` — correção da projeção de moeda na migração

O roteiro E2E corrigido permanece local e ainda precisa ser adicionado ao PR após sua repetição final bem-sucedida.

## Bloqueios de go-live

1. Criar ou vincular `alex@athoslabs.com.br` como usuário de homologação do tenant piloto.
2. Iniciar a sessão `org_d31a7319` e escanear o QR com um número exclusivo de teste.
3. Confirmar com Mateus, da Athos, a data e o horário do teste conjunto.
4. Fazer uma mensagem real controlada: WhatsApp → Sarah → launch Athos → `order.created` → `order.status_changed` → pedido canônico no CRM.

## Risco operacional externo

O painel Supabase informa que a organização excedeu a cota no ciclo anterior e que os projetos poderão ser restringidos em **06/10/2026** se a situação continuar. A cota deve ser regularizada antes de qualquer go-live.

## Integridade do contrato Athos

Nenhum endpoint, payload, mecanismo Bearer/HMAC, idempotência ou tabela `athos_sandbox_*` já entregue à Athos foi removido ou renomeado. A mudança adiciona somente a projeção interna para o CRM e o binding do tenant piloto.
